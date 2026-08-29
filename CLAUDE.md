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

The connector-card icon comes from **`logo_uri` in the OAuth discovery metadata** (`/.well-known/oauth-authorization-server` + `/.well-known/oauth-protected-resource`), pointed at an **unauthenticated `/favicon.png`** — NOT the `serverInfo.icons` field (hosts read that only post-connect, with uneven support). `workers-oauth-provider` doesn't expose `logo_uri`, so `index.ts` wraps the provider's `fetch` and injects it into the discovery docs — matching paths by **prefix** so the path-specific `oauth-protected-resource/mcp` (where the 401's `WWW-Authenticate` sends clients) is branded too. The PNG is base64-embedded in `src/favicon.ts` — swap that string to change the icon.

**Status (2026-06-04): implemented + verified server-side, but Claude still shows a globe for this connector — UNRESOLVED.** Likely Claude's host support is incomplete (the source PR warns icon support is uneven), or a re-add caching nuance (a test re-add didn't re-prompt for the passphrase, so cached state may not have re-fetched metadata; a fully clean re-add or a different account might surface it). Mechanism left in place (correct + future-proof).

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
