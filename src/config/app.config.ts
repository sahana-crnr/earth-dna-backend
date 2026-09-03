// App-level config (port, API prefix, JWT secret/expiry). Loaded via ConfigModule
// and accessible anywhere using ConfigService with the "app.*" namespace.
import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT ?? '1234', 10),
  apiPrefix: process.env.API_PREFIX || 'api/v1',
  jwtSecret: process.env.JWT_SECRET ?? 'fallback-secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
  refreshTokenExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN ?? '30d',
}));
