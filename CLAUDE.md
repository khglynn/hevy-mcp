# hevy-mcp — Agent Instructions

**Last verified:** 2026-09-01

A Cloudflare Worker MCP server wrapping the Hevy workout API, where every person connects with their own Hevy API key. Part of the `self-hosted-mcps` collection (see the parent CLAUDE.md for the meta-repo pattern). Its own repo: `khglynn/hevy-mcp`. The 2026-09-01 rebuild is recorded in `claude-plans/2026-09-01-friends-multi-user-decision.md`.

## Architecture

`workers-oauth-provider` (0.10.3, pinned) wraps everything and owns `/token`, `/register`, token verification and revocation. Authenticated `/mcp` traffic reaches `src/index.ts`'s `api` handler with the grant's decrypted props on `ctx.props`; it builds a fresh `McpServer` per request via `createMcpHandler` from `agents/mcp/server` (`src/mcp.ts`). Everything else is the Hono app in `src/pages.ts`: `/start`, `/authorize`, `/approve`, `/privacy`, `/admin`.

- **Stateless per request, on purpose.** `McpAgent` (a Durable Object per session) was deprecated by the Agents SDK in 0.20.0 and, worse for a multi-user server, kept the Hevy key in DO storage addressed by a client-supplied session id. There is no DO now; the key exists only inside the encrypted grant and in memory during a request. Do not reintroduce per-session state.
- **Props shape is versioned.** `{ v: 2, hevyApiKey, hevyUserId, name, canWrite, client }` (`HevyProps` in `src/mcp.ts`). Anything else gets an HTTP 401 with `WWW-Authenticate` so the client re-runs OAuth. Bump `PROPS_VERSION` when the shape changes; every existing grant then self-heals through a reconnect instead of breaking silently.
- **userId** is `hevy_` + 32 hex of SHA-256 over Hevy's user id (`deriveUserId`). Never pass the raw id: the provider joins token strings and KV keys on `:`.
- **Client allowlist** lives in `src/clients.ts` and is enforced at `/authorize` and `/approve` (the gate that matters) and via `clientRegistrationCallback` at `/register`. Add a client there, nowhere else.
- **Invite gate.** `MCP_INVITE_CODE` is required; `/approve` returns 503 when it is unset (fail closed, same as commit d089312 did for the old passphrase). `/start?invite=…` stores it in the `hevy_invite` cookie; `/authorize` shows the field only when the cookie is missing; a returning member (`member:<userId>` in KV) needs no invite. Order of checks in `/approve`: throttle → known client → invite configured → key shape → invite, or a key this server has seen before (`memberkey:<hash>`) → Hevy → membership record. Hevy is asked about a key only behind the invite or a previously seen key, and failures count against the caller's IP, so `/approve` is never a free key-validation oracle. `disconnect` deletes the member and memberkey records too, so a disconnected person needs the invite link again.
- **Dead keys.** `fail()` in `src/mcp.ts` revokes all of a person's grants on a Hevy 401 and returns the reconnect message. `disconnect` does the same on request. Both rely on `env.OAUTH_PROVIDER.listUserGrants` / `revokeGrant`.
- **Writes are opt-in** per grant (`canWrite`). Registering a different tool set per grant is only possible because the server is built per request.

## Library behaviors worth knowing

- `completeAuthorization` revokes the user's earlier grants for the **same client id** by default (`revokeExistingGrants`). For DCR clients (claude.ai registers once per connector) that is the right "re-auth replaces old grant". Since 0.10.3 CIMD clients (Claude Code, ChatGPT) are scoped by redirect URI, so re-authorizing Claude Code on one machine no longer kills the other machine's grant. That cross-machine revocation is the likely cause of the "constant re-auth" that the 90-day token was papering over before this rebuild.
- TTLs are set explicitly in `src/index.ts`: access 7d, refresh 365d, client registration 365d. The refresh clock does **not** slide: the grant's `expiresAt` is written once at code exchange (`dist/oauth-provider.js`, verified 2026-09-01), so a connection is a hard year and the copy says so. The library's own defaults changed in 0.5.0 (refresh 30d, registration 90d); never rely on them.
- `allowPlainPKCE: false`. Discovery must advertise `["S256"]` only.
- The provider injects `env.OAUTH_PROVIDER` for both the pages app and the API handler.

## Secrets — never commit

`MCP_INVITE_CODE` (required) and `OWNER_TOKEN` (optional) live in `.dev.vars` (gitignored; `.dev.vars.example` shows the shape) and in `wrangler secret put` for prod. Pipe with `printf '%s'` or `tr -d '\n'` — a trailing newline breaks constant-time compares. The old `HEVY_API_KEY` and `MCP_PASSPHRASE` secrets are gone; delete them from the deployed Worker at cutover.

## Deploy = personal Cloudflare, qualified token

```bash
source ~/.env && export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN_PERSONAL" CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID_PERSONAL"
npx wrangler whoami   # must show the personal account (not a Tecovas one) before any deploy
npx wrangler deploy
```

Never deploy this to a Tecovas account. `wrangler.jsonc` carries the custom domain `hevy.kevinhg.com` (the zone is on the personal account; deploy creates the DNS record) and the `v2` migration that deletes the old `HevyMCP` Durable Object class.

**Cutover checklist (2026-09-01 rebuild):** `node scripts/kv-snapshot-and-purge.mjs` (snapshot to the gitignored `backups/`), deploy, `--purge` so no client holds pre-v2 props, set the new secrets, delete the two old ones, reconnect Kevin's own clients, run the smoke test against prod with a real key, then send the first invite. `OPERATOR_NAME` is a `vars` entry in `wrangler.jsonc`, not a secret. Rollback: `npx wrangler rollback`; note grants in KV survive a rollback, so an auth-shape change needs a purge either way.

## Testing

`npm run test:smoke` against `wrangler dev` (43 checks; see `test/smoke.mjs`). With `HEVY_API_KEY` it walks the whole path: DCR, `/authorize`, `/approve`, code exchange, refresh, MCP `initialize`, `tools/list` for both grant kinds, a real Hevy read, and revocation; admin runs whenever `OWNER_TOKEN` is set. CI runs the 26 unauthenticated checks on push. A weekly canary hits production discovery and the 401 via the repo variable `CANARY_BASE`; GitHub silently disables scheduled workflows after 60 days without a commit, so re-enable it from the Actions tab (or `workflow_dispatch`) when the repo has been quiet.

`wrangler kv key list` returned `[]` for the live namespace while the REST API showed keys (2026-09-01). Inventory KV through the API.

## Icon

Claude renders a connector's icon from the parent domain's site icon, not from anything the server declares (research in the collection's LESSONS.md, 2026-08-10 and 2026-08-29). The custom domain `hevy.kevinhg.com` is what gives the connector Kevin's mark. `logo_uri` injection and `serverInfo.icons` stay in place at near-zero cost.

## Hevy API realities (baked into hevy.ts)

- Base `https://api.hevyapp.com/v1`, header `api-key` (a UUID). **Requires Hevy Pro.** `GET /user/info` returns `{ data: { id, name, url } }`; a bad key is a 401 with body `InvalidApiKey`.
- `pageSize` max 10 everywhere except `exercise_templates` (100). The template list is cached per user in KV (`tplcache:<userId>`, 6h) and dropped when a custom template is created.
- Undocumented low rate limit → 429s; the client backs off. No DELETE endpoints; routine folders have no update; body-measurement PUT is a full overwrite; Hevy's read endpoint omits `rep_range` and `rpe` even though the spec lists them.

## ChatGPT caveat

Writes from ChatGPT need a Business/Enterprise/Edu plan; Plus/Pro is read-only, and Developer Mode is required on every plan. Not a server bug — don't try to "fix" it server-side, and don't promise ChatGPT to a non-developer.
