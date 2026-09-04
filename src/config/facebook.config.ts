// Facebook Login config.
//
// FACEBOOK_APP_ID is the "aud" claim of a Limited Login OIDC token (iOS) and the
// app_id that Graph API debug_token must report for a classic access token
// (Android). FACEBOOK_APP_SECRET is needed ONLY for the classic (opaque) token
// path: it forms the app access token used to call debug_token, and the
// appsecret_proof sent with /me.
//
// An empty appId makes FacebookTokenVerifier fail closed on BOTH paths. An empty
// appSecret disables only the opaque path - iOS JWT sign-in keeps working.
import { registerAs } from '@nestjs/config';

export default registerAs('facebook', () => ({
  appId: (process.env.FACEBOOK_APP_ID ?? '').trim(),
  appSecret: (process.env.FACEBOOK_APP_SECRET ?? '').trim(),
}));
