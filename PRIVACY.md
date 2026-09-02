# What this server stores

*Last updated 2026-09-01. The same text is served at `/privacy` on every deployment.*

**Your Hevy API key.** Encrypted inside the OAuth grant your client holds, in Cloudflare KV. The encryption key is derived from your client's token, so the stored copy is unreadable without it. The key is decrypted only for the moment a request from your client is served; it is never written anywhere else and never logged (logs redact anything shaped like a key).

**Your Hevy display name and a hash of your Hevy user id**, so the operator can see who is connected, plus the date you connected and which app connected (Claude, ChatGPT, Claude Code, Cursor).

**Nothing from your workouts.** Requests go straight to Hevy and back; no workout, routine or measurement data is kept. A list of exercise names is cached for a few hours per person to spare Hevy repeated lookups.

## How long

Access tokens last 7 days and are refreshed silently by your client. A refresh token lasts 180 days from its last use. After six months of no use the grant expires and the stored key goes with it.

## Who can read it

The person operating the deployment could technically read a key while a request is in flight. Nobody else can. There is no support promise. The Hevy API itself is unofficial: Pro-only, undocumented limits, and Hevy says it may change or withdraw it.

## Leaving

- Ask Claude to **"disconnect from Hevy"** — this revokes every connection and deletes the stored key with it.
- Rotate your key at [hevy.com/settings?developer](https://hevy.com/settings?developer) — that cuts off this server and anything else holding the old key, instantly.
- Removing the connector in Claude alone does not delete the stored key; use one of the two steps above.
