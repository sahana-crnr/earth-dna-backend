// Port for turning an integration's `authRef` (a secret's *name*, F7) into the
// credential itself. Abstract class as the DI token, the PhotoStorage pattern:
// production binds AwsSecretResolver, tests bind a fake. Lives with F7 because
// every consumer (server ShoeDNA now, ValueLens in F5) resolves the same way.

/** Thrown for any lookup failure; callers map it to a 503 with their own code. */
export class SecretUnavailableError extends Error {
  constructor(name: string, cause?: unknown) {
    super(`secret ${name} could not be read`);
    this.name = 'SecretUnavailableError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export abstract class SecretResolver {
  /** The credential stored under `name`. Never log the return value. */
  abstract resolve(name: string): Promise<string>;
}
