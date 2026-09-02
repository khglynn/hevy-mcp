# What this server stores

*Last updated 2026-09-01. The page served at `/privacy` on every deployment carries this text with the operator's name filled in.*

**Your Hevy API key.** Encrypted inside the OAuth grant your client holds, in Cloudflare KV. The encryption key is derived from your client's token, so the stored copy is unreadable without it. The key is decrypted only for the moment a request from your client is served; it is never written anywhere else and never logged (logs redact anything shaped like a key).

**Your Hevy display name, a hash of your Hevy user id, and a hash of your key**, so the operator can see who is connected and so you can reconnect later without a fresh invite, plus the date you connected and which app connected (Claude, ChatGPT, Claude Code, Cursor).

**Nothing from your workouts.** Requests go straight to Hevy and back; no workout, routine or measurement data is kept. A copy of your exercise list (Hevy's built-ins plus any custom exercises you've made) is cached unencrypted for six hours per person to spare Hevy repeated lookups.

## How long

Access tokens last 7 days and are refreshed silently by your client. The connection itself lasts a year from the day you connect, however often you use it; after that Claude asks you to paste your Hevy key again, and the stored key is gone with the expired connection. Save your key somewhere you can find it. The record that your account has connected before (name, hashed id, hashed key, dates) stays until you disconnect.

## Who can read it

The person operating the deployment could technically read a key while a request is in flight. Nobody else can. There is no support promise. The Hevy API itself is unofficial: Pro-only, undocumented limits, and Hevy says it may change or withdraw it.

## Leaving

- Ask Claude to **"disconnect from Hevy"** — this revokes every connection, deletes the stored key, and forgets that you ever connected.
- Rotate your key at [hevy.com/settings?developer](https://hevy.com/settings?developer) — that instantly makes the stored copy useless to this server and anything else holding the old key; it is cleared the next time anything tries to use it.
- Removing the connector in Claude alone does not delete the stored key; use one of the two steps above.
