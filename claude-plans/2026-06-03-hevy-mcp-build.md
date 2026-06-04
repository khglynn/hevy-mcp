# hevy-mcp — build record

**Created:** 2026-06-03
**Status:** Deployed + verified live

## Goal

A self-hosted Hevy MCP that works in **both Claude and ChatGPT**, hosted on Kevin's **personal** Cloudflare.

## Key decision: authless vs OAuth → OAuth passphrase gate

Verified (today, against official docs) that the research doc's "use a bearer token for personal" advice is outdated: neither Claude nor ChatGPT accepts a static API key / bearer for a hosted connector anymore — only **no-auth** or **OAuth 2.1 + PKCE**. Since the server holds a key that can *write* to Hevy, an authless public URL was unacceptable. Chose **self-handled OAuth** (passphrase gate via `workers-oauth-provider`) — real OAuth both clients accept, gated to "just me," and a reusable template for future MCPs.

## What was built

- TypeScript Worker: `McpAgent` (SQLite Durable Object) + `@cloudflare/workers-oauth-provider@0.4.0`, scaffolded off Cloudflare's `remote-mcp-server` demo, mock login replaced with a passphrase check.
- `src/hevy.ts` API client: pagination loop + 429 backoff. Tool schemas generated from the Hevy OpenAPI spec (sets, exercises, body measurements all match).
- 16 tools (10 read / 6 write), each error-wrapped so Hevy failures surface as readable tool errors.

## Verification

- Typecheck clean; local `wrangler dev` boot; OAuth discovery + gate confirmed.
- All 10 read endpoints hit live against Kevin's account (426 workouts).
- Deployed → `https://hevy-mcp.kevinhg.workers.dev`. Live checks: homepage 200, `/mcp` 401, DCR register → `/authorize` passphrase screen → wrong passphrase rejected (401), CIMD + PKCE S256 advertised.

## Notable gotchas (also in the collection LESSONS.md)

- **CIMD needs two switches** (the OAuthProvider option *and* the compat flag) — Codex review gate caught the half-fix.
- **Account safety:** an unlabeled `CLOUDFLARE_API_TOKEN` in the env couldn't be traced to an account; used browser login + `whoami` confirmation + `env -u CLOUDFLARE_API_TOKEN` on every deploy to guarantee personal.
- **New workers.dev subdomain** (`kevinhg`) took ~55s for its TLS cert to propagate before the URL responded.

## v2 / follow-ups

- Webhooks (live but not in the published spec — verify against a real account first).
- Enrich `create_exercise_template` enums (currently strings validated server-side).
- Consider upgrading `workers-oauth-provider` 0.4.0 → 0.7.x if a feature warrants it.
