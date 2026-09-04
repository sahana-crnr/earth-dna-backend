import type { SocialProvider } from '../../user/entities/user.entity';

/**
 * The subset of a verified social-provider token that this application uses.
 *
 * Deliberately narrow, same as GoogleIdentity: only what the sign-in flow needs.
 * Raw token payloads never travel beyond their verifier.
 */
export interface SocialIdentity {
  provider: SocialProvider;
  /** The provider's stable user ID (`sub`). Primary account lookup key. */
  providerUserId: string;
  /**
   * Email as asserted by the provider, or null when the account has none /
   * the user withheld it. Facebook only returns confirmed addresses; Apple's may
   * be a private relay address, which is real and deliverable.
   */
  email: string | null;
  /** Display name, never empty - verifiers fall back to the email local-part. */
  fullName: string;
}

/** Shared name fallback: provider name claim, else email local-part, else a constant. */
export function resolveFullName(
  name: string | undefined | null,
  email: string | null,
): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  const local = email?.split('@')[0]?.trim();
  if (local) return local;
  return 'Earth DNA User';
}
