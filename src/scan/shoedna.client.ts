// HTTP adapter for server-side ShoeDNA (analyze, the on-device fallback). The
// endpoint and the credential's NAME come from F7 (IntegrationsService), the
// credential itself from SecretResolver — nothing here reads env.
//
// Only transport lives here: the request/response shapes are the assumed
// contract in shoedna-rules.ts. Every failure surfaces as one of two errors
// so the service can answer 504 vs 502 without knowing about fetch.
//
// Logging: never the credential and never the signed photo URLs (they grant
// read access to the user's photos until they expire).
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ScanConfig } from '../config/scan.config';
import type { ActiveIntegration } from '../integrations/integration.view';
import { SecretResolver } from '../integrations/secret-resolver';
import type { ShoeDnaRequest } from './shoedna-rules';

export const SHOEDNA_IDENTIFY_PATH = '/identify';

/** The call did not answer within SCAN_INFERENCE_TIMEOUT_MS. */
export class InferenceTimeoutError extends Error {
  constructor(ms: number) {
    super(`ShoeDNA did not answer within ${ms} ms`);
    this.name = 'InferenceTimeoutError';
  }
}

/** Network error, non-2xx status or a body that is not JSON. */
export class InferenceFailedError extends Error {
  constructor(detail: string) {
    super(`ShoeDNA call failed: ${detail}`);
    this.name = 'InferenceFailedError';
  }
}

@Injectable()
export class ShoeDnaClient {
  private readonly logger = new Logger(ShoeDnaClient.name);
  private readonly timeoutMs: number;

  constructor(
    private readonly secrets: SecretResolver,
    config: ConfigService,
  ) {
    this.timeoutMs = config.get<ScanConfig>('scan')!.inferenceTimeoutMs;
  }

  /**
   * Returns the parsed JSON body, unvalidated. Throws SecretUnavailableError
   * (credential), InferenceTimeoutError or InferenceFailedError.
   */
  async identify(
    active: ActiveIntegration,
    request: ShoeDnaRequest,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    // Resolved before the clock starts: a slow Secrets Manager call must not
    // eat into the model's time budget.
    if (active.authRef) {
      headers.Authorization = `Bearer ${await this.secrets.resolve(active.authRef)}`;
    }
    if (active.version) headers['X-Model-Version'] = active.version;

    const url = `${active.baseUrl.replace(/\/+$/, '')}${SHOEDNA_IDENTIFY_PATH}`;
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (isTimeout(err)) {
        this.logger.warn(
          `shoe ${request.shoeId}: ShoeDNA timed out after ${this.timeoutMs} ms`,
        );
        throw new InferenceTimeoutError(this.timeoutMs);
      }
      this.logger.error(
        `shoe ${request.shoeId}: ShoeDNA unreachable: ${errName(err)}`,
      );
      throw new InferenceFailedError('endpoint unreachable');
    }

    if (!res.ok) {
      this.logger.error(
        `shoe ${request.shoeId}: ShoeDNA answered ${res.status} in ${Date.now() - started} ms`,
      );
      throw new InferenceFailedError(`status ${res.status}`);
    }
    try {
      const body: unknown = await res.json();
      this.logger.log(
        `shoe ${request.shoeId}: ShoeDNA answered in ${Date.now() - started} ms`,
      );
      return body;
    } catch (err) {
      // The timeout also covers reading the body.
      if (isTimeout(err)) throw new InferenceTimeoutError(this.timeoutMs);
      throw new InferenceFailedError('response is not JSON');
    }
  }
}

function isTimeout(err: unknown): boolean {
  const name = errName(err);
  return name === 'TimeoutError' || name === 'AbortError';
}

/** By `name`, not instanceof: the abort reason is a DOMException, which is
 *  not an Error subclass in every realm (jest's sandbox, for one). */
function errName(err: unknown): string {
  const name =
    typeof err === 'object' && err !== null
      ? (err as { name?: unknown }).name
      : undefined;
  return typeof name === 'string' ? name : String(err);
}
