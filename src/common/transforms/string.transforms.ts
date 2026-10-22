// Shared string clean-up used by DTO @Transform()s, the users entity and config.

/** class-transformer callback: trims strings, leaves anything else as is. */
export const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** The one canonical form an email is stored and compared in. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
