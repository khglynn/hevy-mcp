# hevy-mcp — Agent Instructions

**Last verified:** 2026-06-03

A Cloudflare Worker MCP server wrapping the Hevy workout API. Part of the `self-hosted-mcps` collection (see the parent CLAUDE.md for the meta-repo pattern). This is its own repo: `khglynn/hevy-mcp`.

## Architecture

`workers-oauth-provider` wraps everything (owns `/token`, `/register`, token verification). Authenticated `/mcp` traffic routes to the `HevyMCP` Durable Object (an `McpAgent`); everything else goes to the `auth.ts` Hono app (homepage + `/authorize` passphrase screen). Tools live in `mcp.ts` and call the Hevy API through `hevy.ts`.

- **Auth is self-issued.** It's real OAuth 2.1 + PKCE (so Claude and ChatGPT both accept it), but the only credential is `MCP_PASSPHRASE`. No third-party IdP.
- **Single Hevy key.** Every authorized user (just Kevin) shares the server-side `HEVY_API_KEY`. The OAuth gate decides *who can connect*; the Hevy key decides *what they reach* (Kevin's account).

## CIMD needs TWO things (easy to half-do)

For ChatGPT's preferred client registration (CIMD), both are required — having only one silently disables it:
1. `clientIdMetadataDocumentEnabled: true` in the `OAuthProvider` options (`src/index.ts`).
2. `global_fetch_strictly_public` in `compatibility_flags` (`wrangler.jsonc`).

Verify it's on: the AS metadata reports `client_id_metadata_document_supported: true`. DCR is the fallback and works on both clients regardless.

## Secrets — never commit

`HEVY_API_KEY`, `MCP_PASSPHRASE` live in `.dev.vars` (local, gitignored) and `wrangler secret put` (prod). When setting a secret, pipe with `printf '%s'` (no trailing newline — a newline in the passphrase breaks the gate). Before any `git add`, confirm `.dev.vars` is ignored.

## Deploy = personal Cloudflare, token unset

This deploys to `kevin@trimm.co`'s personal account. An unlabeled `CLOUDFLARE_API_TOKEN` may be exported in the shell — it overrides the browser login and is of unknown account. **Always prefix wrangler with `env -u CLOUDFLARE_API_TOKEN`**, and run `wrangler whoami` to confirm the account before deploying. Never deploy this to a Tecovas account.

## Hevy API realities (baked into hevy.ts)

- Base `https://api.hevyapp.com/v1`, auth header `api-key`. **Requires Hevy Pro.**
- `pageSize` max 10 everywhere except `exercise_templates` (100) — use the pagination loop, don't assume one page.
- Undocumented low rate limit → 429s. The client backs off; prefer narrow queries.
- No DELETE endpoints; routine folders have no update; body-measurement PUT is a full overwrite.
- Webhooks are live but absent from the published spec — verify against a real account before adding (v2).

## ChatGPT caveat

Writes from ChatGPT need a Business/Enterprise plan; Plus/Pro is read-only. Not a server bug — don't try to "fix" it server-side.
