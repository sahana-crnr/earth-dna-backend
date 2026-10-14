// F7 admin account. There is exactly one admin and its credentials live only
// in env (AWS Secrets Manager → ECS task definition `secrets[]` on deployed
// environments); AdminBootstrapService syncs them into the users table on boot.
//
// Fails CLOSED, unlike the scan limits: a missing email or a password shorter
// than ADMIN_PASSWORD_MIN_LENGTH means "no admin", and the bootstrap demotes
// any existing one. It does not refuse to boot (cf. validateJwtSecret) because
// the admin is optional - the app keeps serving every USER route.
import { registerAs } from '@nestjs/config';

export const ADMIN_PASSWORD_MIN_LENGTH = 12;

export interface AdminConfig {
  /** null = no admin on this environment. */
  email: string | null;
  password: string | null;
}

export default registerAs(
  'admin',
  (): AdminConfig => ({
    email: process.env.ADMIN_EMAIL?.trim() || null,
    password: process.env.ADMIN_PASSWORD || null,
  }),
);
