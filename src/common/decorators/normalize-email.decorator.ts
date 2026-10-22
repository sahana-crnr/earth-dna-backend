// Trims and lowercases an email field before validation runs, so
// "  Jane@Example.com" and "jane@example.com" are the same account. This is a
// convenience for request DTOs; UserService normalises again when it creates a
// user, so no write path depends on it.
import { Transform } from 'class-transformer';
import { normalizeEmail, trim } from '../transforms/string.transforms';

export function NormalizeEmail(): PropertyDecorator {
  return Transform((params: { value: unknown }) => {
    const value = trim(params);
    return typeof value === 'string' ? normalizeEmail(value) : value;
  });
}
