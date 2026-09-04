// Thin wrapper over jose for verifying provider-issued OIDC JWTs (Apple identity
// tokens, Facebook Limited Login tokens) against a remote JWKS.
//
// One RemoteJWKSet per URL, created lazily and kept for the life of the process:
// jose caches the fetched keys and refreshes them on an unknown `kid`, so a new
// set per request would refetch the provider's keys every time.
//
// Every failure - bad signature, unknown key, expired, wrong iss/aud, malformed -
// surfaces as the SAME error to the caller. Which check failed is logged by the
// provider-specific verifier, never returned to the client.
import { Injectable } from '@nestjs/common';
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyOptions,
} from 'jose';

export interface JwksVerifyOptions {
  jwksUrl: string;
  issuer: string | string[];
  audience: string | string[];
}

/** How long one JWKS fetch may take before it counts as a failure. */
const JWKS_FETCH_TIMEOUT_MS = 5000;

@Injectable()
export class JwksJwtVerifier {
  private readonly keySets = new Map<
    string,
    ReturnType<typeof createRemoteJWKSet>
  >();

  /**
   * Verifies signature (RS256 only - what both Apple and Facebook issue),
   * `exp`, `iss` and `aud` in one call. Resolves to the payload on success and
   * rejects with jose's error otherwise.
   */
  async verify(token: string, opts: JwksVerifyOptions): Promise<JWTPayload> {
    const jwks = this.keySetFor(opts.jwksUrl);
    const verifyOptions: JWTVerifyOptions = {
      issuer: opts.issuer,
      audience: opts.audience,
      algorithms: ['RS256'],
    };
    const { payload } = await jwtVerify(token, jwks, verifyOptions);
    return payload;
  }

  private keySetFor(url: string) {
    let set = this.keySets.get(url);
    if (!set) {
      set = createRemoteJWKSet(new URL(url), {
        timeoutDuration: JWKS_FETCH_TIMEOUT_MS,
      });
      this.keySets.set(url, set);
    }
    return set;
  }
}

/** True when the string has the three-segment shape of a compact JWS. */
export function looksLikeJwt(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p));
}
