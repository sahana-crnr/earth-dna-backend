// F7 admin account. There is exactly one admin and its credentials live only
// in env (AWS Secrets Manager → ECS task definition `secrets[]` on deployed
// environments); AdminBootstrapService syncs them into the users table on boot.
//
// A missing email or a password shorter than ADMIN_PASSWORD_MIN_LENGTH is
// treated as a deploy mistake, not an instruction: the bootstrap logs a warning
// and leaves the current admin as it is, so a broken secret cannot lock
// everyone out of the admin panel. Removing the admin takes the explicit
// ADMIN_DISABLE=true. Neither refuses to boot (cf. validateJwtSecret) because
// the admin is optional - the app keeps serving every USER route.
import { registerAs } from '@nestjs/config';

export const ADMIN_PASSWORD_MIN_LENGTH = 12;

export interface AdminConfig {
  /** null = not configured; the existing admin (if any) is kept. */
  email: string | null;
  password: string | null;
  /** ADMIN_DISABLE=true: demote every admin, ignore the credentials. */
  disabled: boolean;
}

export default registerAs(
  'admin',
  (): AdminConfig => ({
    email: process.env.ADMIN_EMAIL?.trim() || null,
    password: process.env.ADMIN_PASSWORD || null,
    disabled: process.env.ADMIN_DISABLE?.trim().toLowerCase() === 'true',
  }),
);
