# hevy-mcp — Agent Instructions

**Last verified:** 2026-09-01

A Cloudflare Worker MCP server wrapping the Hevy workout API, where every person connects with their own Hevy API key. Part of the `self-hosted-mcps` collection (see the parent CLAUDE.md for the meta-repo pattern). Its own repo: `khglynn/hevy-mcp`. The 2026-09-01 rebuild is recorded in `claude-plans/2026-09-01-friends-multi-user-decision.md`.

## Architecture

`workers-oauth-provider` (0.10.3, pinned) wraps everything and owns `/token`, `/register`, token verification and revocation. Authenticated `/mcp` traffic reaches `src/index.ts`'s `api` handler with the grant's decrypted props on `ctx.props`; it builds a fresh `McpServer` per request via `createMcpHandler` from `agents/mcp/server` (`src/mcp.ts`). Everything else is the Hono app in `src/pages.ts`: `/start`, `/authorize`, `/approve`, `/privacy`, `/admin`.

- **Stateless per request, on purpose.** `McpAgent` (a Durable Object per session) was deprecated by the Agents SDK in 0.20.0 and, worse for a multi-user server, kept the Hevy key in DO storage addressed by a client-supplied session id. There is no DO now; the key exists only inside the encrypted grant and in memory during a request. Do not reintroduce per-session state.
- **Props shape is versioned.** `{ v: 3, hevyApiKey, keyFingerprint, hevyUserId, name, canWrite, client }` (`HevyProps` in `src/mcp.ts`). Anything else gets an HTTP 401 with `WWW-Authenticate` so the client re-runs OAuth. Bump `PROPS_VERSION` when the shape changes; every existing grant then self-heals through a reconnect instead of breaking silently.
- **userId** is `hevy_` + 32 hex of SHA-256 over Hevy's user id (`deriveUserId`). Never pass the raw id: the provider joins token strings and KV keys on `:`.
- **Client allowlist** lives in `src/clients.ts` and is enforced at `/authorize` and `/approve` (the gate that matters) and via `clientRegistrationCallback` at `/register`. Add a client there, nowhere else.
- **Invite gate is optional, and Kevin's deployment runs open** (decided 2026-09-01 after his first live test: the OAuth pop-up opened in a browser profile without the invite cookie and the field confused him; with bring-your-own-key there is no shared secret to protect, and a stranger connecting only reaches their own account). When `MCP_INVITE_CODE` is set the gate is enforced; when unset, the per-IP throttles are the brake. `/start?invite=…` stores it in the `hevy_invite` cookie (a year); `/authorize` shows the field unless the cookie holds the current code; someone reconnecting with a key they already connected with needs no invite. The cookie is a hint that can only help — a stale one is treated as absent, never as a wrong answer. Order of checks in `/approve`: throttle → known client → invite configured → key shape → invite, or a key this server has seen before (`memberkey:<hash>`) → Hevy → membership record. Hevy is asked about a key only behind the invite or a previously seen key, and failures count against the caller's IP, so `/approve` is never a free key-validation oracle. `disconnect` deletes the member record and the hash of the key in use, so a disconnected person needs the invite link again. `memberkey:` entries carry a 365-day TTL. `/admin` → **Remove person** does the same for every key hash pointing at that user.
- **Dead keys.** `fail()` in `src/mcp.ts` revokes all of a person's grants on a Hevy 401 and returns the reconnect message. `disconnect` does the same on request. Both rely on `env.OAUTH_PROVIDER.listUserGrants` / `revokeGrant`.
- **Writes are opt-in** per grant (`canWrite`). Registering a different tool set per grant is only possible because the server is built per request.

## Library behaviors worth knowing

- `completeAuthorization` revokes the user's earlier grants for the **same client id** by default (`revokeExistingGrants`). For DCR clients (claude.ai registers once per connector) that is the right "re-auth replaces old grant". Since 0.10.3 CIMD clients (Claude Code, ChatGPT) are scoped by redirect URI, so re-authorizing Claude Code on one machine no longer kills the other machine's grant. That cross-machine revocation is the likely cause of the "constant re-auth" that the 90-day token was papering over before this rebuild.
- TTLs are set explicitly in `src/index.ts`: access 7d, refresh 365d, client registration 365d. The refresh clock does **not** slide: the grant's `expiresAt` is written once at code exchange (`dist/oauth-provider.js`, verified 2026-09-01), so a connection is a hard year and the copy says so. The library's own defaults changed in 0.5.0 (refresh 30d, registration 90d); never rely on them.
- `allowPlainPKCE: false`. Discovery must advertise `["S256"]` only.
- Revocation is KV-backed and therefore eventually consistent in production: token reads sit behind KV's ~60s edge cache, and `revokeExistingGrants` / `revokeAllGrants` enumerate with a KV list that can miss a grant written seconds earlier. Seen 2026-09-01: the smoke test's "re-auth revokes the earlier grant" check holds locally and not on production, so it is local-only. A stray grant expires with its year; a revoked token can answer for up to a minute at one edge.
- The provider injects `env.OAUTH_PROVIDER` for both the pages app and the API handler.
- `createMcpHandler` is given `allowedOriginHostnames: "*"`: agents 0.22.0 otherwise allowlists localhost only and 403s every request that carries an Origin header on the custom domain. `/mcp` is bearer-only and cookie-free, so Origin checks buy nothing there.
- A Hevy 401 inside a tool is re-checked against `GET /user/info` before any grant is revoked; only a confirmed dead key tears down the grants carrying that key's fingerprint (`metadata.keyFingerprint`), so a client that already reconnected with a new key keeps working. `disconnect` is the revoke-everything operation.
- Props are v3: `{ v: 3, hevyApiKey, keyFingerprint, hevyUserId, name, canWrite, client }`.

## Secrets — never commit

`MCP_INVITE_CODE` (optional; unset on Kevin's deployment), `OWNER_TOKEN` (optional) and `OPERATOR_NAME` (optional; Kevin's name on the pages, set with `wrangler secret put` only so it survives deploys and stays out of the public repo — there is no `vars` entry) live in `.dev.vars` (gitignored; `.dev.vars.example` shows the shape) and in `wrangler secret put` for prod. `/admin` signs in by POST form and keeps an opaque session id (hashed in KV, one day, cookie scoped to `/admin`); login attempts are throttled by `ADMIN_RL` and logged as `admin.denied`. Pipe with `printf '%s'` or `tr -d '\n'` — a trailing newline breaks constant-time compares. The old `HEVY_API_KEY` and `MCP_PASSPHRASE` secrets are gone; delete them from the deployed Worker at cutover.

## Deploy = personal Cloudflare, qualified token

```bash
source ~/.env && export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN_PERSONAL" CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID_PERSONAL"
npx wrangler whoami   # must show the personal account (not a Tecovas one) before any deploy
npx wrangler deploy
```

Never deploy this to a Tecovas account. `wrangler.jsonc` carries the custom domain `hevy.kevinhg.com` (the zone is on the personal account; deploy creates the DNS record) and the `v2` migration that deletes the old `HevyMCP` Durable Object class.

**Cutover checklist (2026-09-01 rebuild):** `node scripts/kv-snapshot-and-purge.mjs` (snapshot to the gitignored `backups/`), deploy, `--purge` so no client holds pre-v2 props, set the new secrets, delete the two old ones, reconnect Kevin's own clients, run the smoke test against prod with a real key, then send the first invite. `OPERATOR_NAME` is a `vars` entry in `wrangler.jsonc`, not a secret. Rollback: `npx wrangler rollback`; note grants in KV survive a rollback, so an auth-shape change needs a purge either way.

## Testing

`npm run test:smoke` against `wrangler dev` (48 checks locally, one fewer against production; see `test/smoke.mjs`). With `HEVY_API_KEY` it walks the whole path: DCR, `/authorize`, `/approve`, code exchange, refresh, MCP `initialize`, `tools/list` for both grant kinds, a real Hevy read, and revocation; admin runs whenever `OWNER_TOKEN` is set. CI runs the 29 unauthenticated checks on push. A weekly canary hits production discovery and the 401 via the repo variable `CANARY_BASE`; GitHub silently disables scheduled workflows after 60 days without a commit, so re-enable it from the Actions tab (or `workflow_dispatch`) when the repo has been quiet.

`wrangler kv key list` returned `[]` for the live namespace while the REST API showed keys (2026-09-01). Inventory KV through the API.

## Icon

Claude renders a connector's icon from the parent domain's site icon, not from anything the server declares (research in the collection's LESSONS.md, 2026-08-10 and 2026-08-29). The custom domain `hevy.kevinhg.com` is what gives the connector Kevin's mark. `logo_uri` injection and `serverInfo.icons` stay in place at near-zero cost.

## Hevy API realities (baked into hevy.ts)

- Base `https://api.hevyapp.com/v1`, header `api-key` (a UUID). **Requires Hevy Pro.** `GET /user/info` returns `{ data: { id, name, url } }`; a bad key is a 401 with body `InvalidApiKey`.
- `pageSize` max 10 everywhere except `exercise_templates` (100). The template list is cached per user in KV (`tplcache:<userId>`, 6h) and dropped when a custom template is created.
- Undocumented low rate limit → 429s; the client backs off. No DELETE endpoints; routine folders have no update; body-measurement PUT is a full overwrite; Hevy's read endpoint omits `rep_range` and `rpe` even though the spec lists them.

## ChatGPT caveat

Per OpenAI's help article (checked 2026-09-01): Business, Enterprise and Edu get full MCP including writes; Pro gets read-only MCP in Developer Mode; Plus is not listed as supporting custom MCP servers at all. Not a server bug — don't try to "fix" it server-side, and don't promise ChatGPT to a non-developer. Discovery advertises `offline_access` (`scopesSupported`) because OpenAI keys refresh on it.
