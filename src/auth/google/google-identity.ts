/**
 * The subset of a verified Google ID token that this application uses.
 *
 * Deliberately narrow: only what the sign-in flow needs. The raw token payload
 * never travels beyond GoogleTokenVerifier.
 */
export interface GoogleIdentity {
  /** Verified email address. Used as the account lookup key. */
  email: string;
  /** Google's "name" claim, or the email local-part when that claim is absent. */
  fullName: string;
  /** Always true - the verifier rejects the request otherwise. */
  emailVerified: true;
}
