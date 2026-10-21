// Secrets Manager implementation of SecretResolver. The SDK signs with the
// first credentials its default chain finds, and env keys come before the ECS
// task role: on dev2 the task definition injects AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY (IAM user earth-dna-be-ses-ue1-dev2), so THAT user —
// not the task role — needs secretsmanager:GetSecretValue on the secret.
// A grant on the task role alone is silently unused and every call becomes
// 503 INFERENCE_CREDENTIAL_UNAVAILABLE (the same trap S3 hit in F1).
//
// The grant is per secret, not earthdna/be/*: the same prefix holds the JWT
// and admin credentials, which leaked static keys must not reach. dev2 grants
// only earthdna/be/shoedna-api-key-ue1-dev2-* (inline policy
// shoedna-secret-read-ue1-dev2; the -* covers the suffix AWS appends). A new
// consumer (ValueLens) gets its own secret and its own grant.
//
// The SDK has no request timeout by default, and the lookup runs before the
// inference timeout starts, so the client gets explicit connection / request
// timeouts: a hung Secrets Manager call fails fast as a 503 instead of holding
// the request until the load balancer cuts it.
//
// Two accepted secret shapes: a plain string (the key itself), or JSON with an
// `apiKey` field — the console's "key/value" mode writes the latter, and
// neither should be a deploy-blocking surprise.
//
// Values are cached per name for CACHE_MS so an inference call does not pay a
// Secrets Manager round trip each time, while a rotated key is still picked up
// within minutes without a redeploy. Failures are never cached.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { StorageConfig } from '../config/storage.config';
import { SecretResolver, SecretUnavailableError } from './secret-resolver';

const CACHE_MS = 5 * 60 * 1000;
const CONNECTION_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 5_000;

@Injectable()
export class AwsSecretResolver extends SecretResolver {
  private readonly logger = new Logger(AwsSecretResolver.name);
  private readonly client: SecretsManagerClient;
  private readonly cache = new Map<string, { value: string; until: number }>();

  constructor(config: ConfigService) {
    super();
    // AWS_REGION is already read by the storage namespace; one region per task.
    const region = config.get<StorageConfig>('storage')?.region ?? 'us-east-1';
    this.client = new SecretsManagerClient({
      region,
      requestHandler: {
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        requestTimeout: REQUEST_TIMEOUT_MS,
      },
    });
  }

  async resolve(name: string): Promise<string> {
    const hit = this.cache.get(name);
    if (hit && hit.until > Date.now()) return hit.value;

    let value: string | null;
    try {
      const out = await this.client.send(
        new GetSecretValueCommand({ SecretId: name }),
      );
      value = extractKey(out.SecretString);
    } catch (err) {
      // The error names the secret, never its value.
      this.logger.error(`GetSecretValue ${name} failed: ${String(err)}`);
      throw new SecretUnavailableError(name, err);
    }
    if (!value) {
      this.logger.error(`secret ${name} is empty or has no apiKey field`);
      throw new SecretUnavailableError(name);
    }
    this.cache.set(name, { value, until: Date.now() + CACHE_MS });
    return value;
  }
}

/** Plain string, or JSON `{ "apiKey": "…" }`. Anything else → null. */
export function extractKey(secret: string | undefined): string | null {
  const s = (secret ?? '').trim();
  if (!s) return null;
  if (!s.startsWith('{')) return s;
  try {
    const parsed = JSON.parse(s) as unknown;
    const key =
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>).apiKey
        : undefined;
    return typeof key === 'string' && key.trim() ? key.trim() : null;
  } catch {
    return null;
  }
}
