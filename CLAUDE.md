# hevy-mcp — Agent Instructions

**Last verified:** 2026-08-29

A Cloudflare Worker MCP server wrapping the Hevy workout API. Part of the `self-hosted-mcps` collection (see the parent CLAUDE.md for the meta-repo pattern). This is its own repo: `khglynn/hevy-mcp`.

## Architecture

`workers-oauth-provider` wraps everything (owns `/token`, `/register`, token verification). Authenticated `/mcp` traffic routes to the `HevyMCP` Durable Object (an `McpAgent`); everything else goes to the `auth.ts` Hono app (homepage + `/authorize` passphrase screen). Tools live in `mcp.ts` and call the Hevy API through `hevy.ts`.

- **Auth is self-issued.** It's real OAuth 2.1 + PKCE (so Claude and ChatGPT both accept it), but the only credential is `MCP_PASSPHRASE`. No third-party IdP.
- **Single Hevy key.** Every authorized user (just Kevin) shares the server-side `HEVY_API_KEY`. The OAuth gate decides *who can connect*; the Hevy key decides *what they reach* (Kevin's account).
- **Access tokens live 90 days** (`accessTokenTTL` in `src/index.ts`, set 2026-08-29). The library default (1 hour) plus unreliable client-side silent refresh meant Kevin re-entered the passphrase nearly every Claude Code session. Refresh tokens keep the library default (no expiry). Tradeoff accepted knowingly: a leaked bearer token is live for up to 90 days, against a single-user server fronting gym data — if that calculus changes, this is the knob.

## CIMD needs TWO things (easy to half-do)

For ChatGPT's preferred client registration (CIMD), both are required — having only one silently disables it:
1. `clientIdMetadataDocumentEnabled: true` in the `OAuthProvider` options (`src/index.ts`).
2. `global_fetch_strictly_public` in `compatibility_flags` (`wrangler.jsonc`).

Verify it's on: the AS metadata reports `client_id_metadata_document_supported: true`. DCR is the fallback and works on both clients regardless.

## Icon (connector branding)

**Status (re-researched 2026-08-29; supersedes the 2026-06-04 note):** every server-declared lever — `serverInfo.icons` (SEP-973), `logo_uri` in the OAuth discovery metadata, a served `/favicon.png` — is confirmed **non-functional for Claude's connector-card icon** (claude.ai issue #152: 85 comments, zero Anthropic replies; Claude Code: 3+ icon feature requests stale-bot-closed, nothing in the changelog). The levers that ARE real, per the LESSONS.md research in the parent repo (2026-08-10) + fresh verification:
- **claude.ai parent-domain fallback** — a connector served from a `kevinhg.com` subdomain inherits the kevinhg.com site icon on the connect/auth screens (observed live with spotify-mcp). Getting this here means a Workers custom domain (e.g. `hevy-mcp.kevinhg.com`) — a kevinhg.com DNS change, Kevin's call, and the connector URL changes with it.
- **VS Code renders `serverInfo.icons` today** — the one mainstream host that ships SEP-973.

So the plumbing stays exactly as built (spec-correct, future-proof): `serverInfo.icons` in `index.ts`, `logo_uri` injected into both `.well-known` docs by prefix-matching (covers the path-specific `oauth-protected-resource/mcp` the 401's `WWW-Authenticate` points at), PNG base64-embedded in `src/favicon.ts`. **The embedded PNG is Kevin's own mark as of 2026-08-29** (was Hevy's app icon before); swap that one string to change it.

## Secrets — never commit

`HEVY_API_KEY`, `MCP_PASSPHRASE` live in `.dev.vars` (local, gitignored) and `wrangler secret put` (prod). When setting a secret, pipe with `printf '%s'` (no trailing newline — a newline in the passphrase breaks the gate). Before any `git add`, confirm `.dev.vars` is ignored.

## Deploy = personal Cloudflare, qualified token

This deploys to `kevin@trimm.co`'s personal account. Since the 2026-07-27 account split, `~/.env` carries only account-qualified names — use the personal pair explicitly and confirm before deploying:

```bash
source ~/.env && export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN_PERSONAL" CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID_PERSONAL"
npx wrangler whoami   # must say Kevin@trimm.co before any deploy
npx wrangler deploy
```

Browser OAuth login may be absent on a given machine (it was 2026-08-29); the qualified token path works regardless. Never deploy this to a Tecovas account. *(Superseded guidance: the old "always `env -u CLOUDFLARE_API_TOKEN`" rule guarded against a pre-split unqualified token of unknown account; that ambient export no longer exists.)*

## Hevy API realities (baked into hevy.ts)

- Base `https://api.hevyapp.com/v1`, auth header `api-key`. **Requires Hevy Pro.**
- `pageSize` max 10 everywhere except `exercise_templates` (100) — use the pagination loop, don't assume one page.
- Undocumented low rate limit → 429s. The client backs off; prefer narrow queries.
- No DELETE endpoints; routine folders have no update; body-measurement PUT is a full overwrite.
- Webhooks are live but absent from the published spec — verify against a real account before adding (v2).

## ChatGPT caveat

Writes from ChatGPT need a Business/Enterprise plan; Plus/Pro is read-only. Not a server bug — don't try to "fix" it server-side.
