// Trims and lowercases an email field before validation runs, so
// "  Jane@Example.com" and "jane@example.com" are the same account.
// Non-string values pass through untouched and are rejected by @IsEmail.
import { Transform } from 'class-transformer';

export function NormalizeEmail(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );
}
