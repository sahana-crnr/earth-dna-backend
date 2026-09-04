// Sign in with Apple config. APPLE_CLIENT_IDS is the list of values accepted as
// the "aud" claim of an incoming Apple identity token. For a native iOS app that
// is the app's bundle ID. It is a LIST because the bundle ID is expected to change
// (com.example.earthDnaApp today - see tracker T5) and both old and new builds
// must keep signing in during the transition.
//
// Same fail-closed rule as Google: an empty list rejects every token.
import { registerAs } from '@nestjs/config';
import { parseClientIds } from './google.config';

export default registerAs('apple', () => ({
  clientIds: parseClientIds(process.env.APPLE_CLIENT_IDS),
}));
