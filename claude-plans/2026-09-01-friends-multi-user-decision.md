# hevy-mcp for friends — decision brief

**Created:** 2026-09-01 · **Status:** SHIPPED 2026-09-01 · **Call 4 reversed the same night:** Kevin's first live test hit the invite field (the OAuth pop-up opened in a browser profile without the cookie) and he asked why it existed; the deployment now runs open, and the gate stays in the code as an opt-in for other deployers. — all six calls approved as recommended (plus call 7, extract the auth layer into a public template, still to do); live on `hevy.kevinhg.com`, workers.dev hostname kept; old grants purged; repo public. Two corrections during build: the refresh window is a hard year (the library does not slide it), and the invite gate is decided from a hash of the key before Hevy is asked. · **Size:** L

## 1. Where we are

The server at `hevy-mcp.kevinhg.workers.dev` holds one Hevy API key (Kevin's) as a Worker secret. The passphrase decides who may connect; everyone who connects reaches Kevin's account. So the URL plus passphrase would hand a friend Kevin's workouts, not theirs. Making it usable by a friend means each person brings their own Hevy API key, which Hevy only issues to Pro subscribers, from the web app (it stays visible on the Developer page, with a Revoke button — an earlier draft here said "shown once", which was wrong).

The passphrase question (a password-shaped string found next to the MCP URL in an old audit bundle on the SanDisk, 2026-08-31) goes away with this redesign: the shared passphrase is deleted. Git history was scanned across all nine commits for key and passphrase values and is clean.

## 2. Three ways a friend could get Hevy into an AI assistant

| | HevyGPT (official) | chrisdoc/hevy-mcp hosted | Ours, rebuilt |
|---|---|---|---|
| What it is | Hevy's own custom GPT; connect from the Hevy app (Profile → Settings → Integrations) | Open-source MCP with a hosted Worker at `mcp.hevy-mcp.dev/mcp` (450 stars, MIT, pushed 2026-09-01) | This repo, upgraded to bring-your-own-key |
| Works in | ChatGPT only (not the Android ChatGPT app) | Claude and ChatGPT | Claude (ChatGPT works but is a poor fit for non-developers) |
| Needs Hevy Pro + API key | No | Yes | Yes |
| Reads workout history | No (builds and imports plans only) | Yes | Yes |
| Writes | Creates routines (≤4 per import on free Hevy) | Full create/update | Full, with a read-only default |
| Whose server holds the key | Hevy | An unaffiliated individual (privacy policy published; Worker code private) | Kevin |
| Effort for Kevin | Zero | Zero | L build |

Hevy runs a private OAuth for HevyGPT (`hevy.com/oauth/authorize` exists) but publishes no discovery document and no client registration, so third parties cannot use "Sign in with Hevy". Checked 2026-09-01.

**Recommendation.** Tell the friend about HevyGPT today if they use ChatGPT and only want plans built and imported. For anything more (Claude, reading history, logging workouts), build ours. It is already Kevin's infrastructure, the same pattern chrisdoc runs, and the rebuild retires the shared passphrase and a deprecated SDK path at the same time. chrisdoc's hosted service is the honest fallback if Kevin would rather not hold friends' credentials at all.

## 3. The rebuild, in plain words

1. **Bring your own key.** The connect page asks for the person's own Hevy API key, checks it live against Hevy (`GET /v1/user/info`), and stores it encrypted inside their OAuth grant. Nothing of Kevin's is shared. Kevin connects the same way with his own key; the `HEVY_API_KEY` and `MCP_PASSPHRASE` secrets are deleted.
2. **Stateless per request.** Replace the deprecated `McpAgent` Durable Object with `createMcpHandler` from `agents/mcp/server`. Each request builds its Hevy client from the token's decrypted props via `getMcpAuthContext().props`. No key is ever written to Durable Object storage; there is no session object another user could reach; tools can be registered per grant.
3. **Consent, with writes off by default.** The connect page names the client asking (Claude, ChatGPT, Claude Code), says what access means, and has an unchecked "let Claude add and edit workouts" box. Hevy has no delete endpoint, so an overwrite has no undo; that sentence is on the page.
4. **Invite carried in the link, never typed.** Kevin texts `hevy.kevinhg.com/start?invite=…`. The start page stores the invite in a cookie; the connect page reads it and shows the field only if the cookie is missing. Returning people skip it entirely: after a key validates, a Hevy user id that has connected before (recorded at first connect as `member:<hash>` in KV) needs no invite, so a reconnect months later is one paste, not two. The code is generated (`crypto.randomUUID()`), mandatory, and fails closed when unset, matching the repo's existing fail-closed pattern (commit d089312).
5. **Only known clients get the key field.** Redirect hosts are allowlisted at `/authorize` (claude.ai, claude.com, chatgpt.com, and loopback for Claude Code). Anything else sees "this connector only works with Claude and ChatGPT". This closes the phishing path where an attacker registers a client and sends a friend a real-looking link on Kevin's domain.
6. **A dead key heals itself.** When Hevy answers 401 to a tool call, the server revokes that person's grants and returns a plain message with the reconnect link. The next request gets an HTTP 401, which is the signal Claude needs to re-run OAuth. Today a dead key means a connector that looks healthy and errors forever.
7. **Library upgrade first.** `@cloudflare/workers-oauth-provider` 0.4.0 → 0.10.3 pinned (S256-only PKCE, client-registration hook, CIMD fixes ChatGPT needs), `agents` 0.9 → 0.22, MCP server SDK v2 declared explicitly. Set `refreshTokenTTL` on purpose: the library's default changed from never to 30 days in 0.5.0.
8. **Tokens sized for other people's credentials.** Access 7 days, refresh 365 days. *(Corrected during build, 2026-09-01: the library does not slide the refresh clock on use — the grant's expiry is written once at connect — so the earlier "180 days from last use" wording was wrong. The choice became a hard year.)* In practice: Claude swaps the access token silently every week; a prompt appears a year after connecting, or when a client loses its stored connection (reinstall, removed connector). Recovering means the connect page again, which means pasting the Hevy key; if they did not save it, they regenerate one at Hevy, which invalidates the old key everywhere. The start page tells them to save it for exactly this reason. Verify silent refresh in Claude and Claude Code before cutover; the 90-day setting was papering over an undiagnosed refresh problem.
9. **Owner and self-service controls.** `/admin` (separate `OWNER_TOKEN`) lists who is connected with name, client, and connect date, with a revoke button. A `whoami` tool and a `disconnect` tool let a friend check and cut their own connection from chat. Structured logs on connect success/failure and Hevy 401/429, tagged by user, with a redaction helper so a key never lands in Workers Logs.
10. **Front pages.** `/start` (also the homepage): prerequisites, "Get my Hevy key" button, the copyable `/mcp` URL, a paragraph on what is stored and how to leave, and a note that phones cannot add connectors. `/privacy`: what is stored, where, for how long, that Kevin operates the server, and that rotating the key at Hevy revokes instantly.
11. **Exercise-template cache.** One `search_exercise_templates` call costs up to six Hevy requests today. Cache the list per user in KV for six hours so shared Hevy rate limits stop being a concern.
12. **Custom domain before the first invite.** `hevy.kevinhg.com` as a Workers custom domain (the `kevinhg.com` zone is on the personal Cloudflare account, so it is one config line). A later move would force every friend to redo setup with a key Hevy will not show them twice. The `workers.dev` URL keeps working.
13. **Cutover.** Back up the OAuth KV, deploy, purge all grants and tokens so no client holds a token whose props the new code cannot use, reconnect Kevin's own clients, walk the friend path end to end, then send the first invite.
14. **Repo hygiene, then public.** MIT license, README for two audiences (connect to Kevin's instance by invite; deploy your own), CLAUDE.md rewritten for the new model, the personal email replaced with "the personal Cloudflare account", the 2026-06-03 plan's deploy-incident narration trimmed. One smoke test in CI (discovery, unauthenticated 401, wrong invite, bad key) and a weekly unauthenticated canary.

Deliberately skipped: unit tests per tool (thin passthroughs; Hevy is the oracle), per-user Durable Objects, Hevy webhooks (not in the published spec), a users database, dependency bots.

## 4. What the review found that changed the design

Three Opus reviewers (security, non-developer UX, durability) plus a completeness check, with facts verified against installed library code and live endpoints on 2026-09-01.

- The first draft kept the key in a per-session Durable Object. The object is addressed by a client-supplied session id with no owner check, and the key would be captured once at startup, so a rotated key stays stale and a replayed session id could reach another user's account. Going stateless dissolves all of it.
- The first draft made the invite optional ("unset means open"). Combined with a public repo that names the live URL, that is a discoverable service holding strangers' health credentials. Now mandatory and fail-closed.
- The connect page never named the requesting client while client registration is open, which turns Kevin's real domain into a harvest page. Now allowlisted and labeled.
- A rotated key produced a connector that reports healthy forever. Now revokes and 401s.
- `revokeExistingGrants` already defaults to true in the installed library (two reviewers had that wrong). Its live side effect: re-authorizing one client revokes other grants for the same user and client id, which matters for Claude Code across two machines. The 0.10.3 upgrade scopes that by redirect URI.
- `clientRegistrationCallback` does not exist at 0.4.0, so the upgrade is a prerequisite, not polish.
- Two prerequisites no code can fix: Hevy Pro, and a key that only the web app issues. Phones cannot add custom connectors. Both go in the message to the friend, not in an error page they hit mid-flow.

## 5. Kevin's calls

1. **Build ours** (recommended), or point the friend at HevyGPT (ChatGPT, plans only) or chrisdoc's hosted server (anything, third-party custody). These are not exclusive; the friend can use HevyGPT today while ours is built.
2. **Custom domain `hevy.kevinhg.com`** before the first invite (recommended). One line in `wrangler.jsonc`; Cloudflare creates the DNS record on deploy.
3. **Public repo** after the rewrite (recommended yes). The live URL stays invite-only either way.
4. **Invite gate:** mandatory, generated, carried in the link (recommended), or none.
5. **Token lifetimes:** 7-day access, 180-day rotating refresh (recommended). Flagged: if silent refresh proves broken in a client, that is diagnosed, not papered over with a longer token.
6. **Write access:** off by default with a checkbox on the connect page (recommended), or always on.

## 6. Build sequence

Each phase ends with a triple-check, a commit, and a pause for review.

1. **Ground.** Provision a rate-limit binding on the personal (Free) plan to learn whether it exists there; if not, a KV failure counter takes its place. Set a 60-second access token in dev and watch Claude Code and claude.ai refresh, to diagnose the old refresh problem.
2. **Upgrade and go stateless.** Pin the three libraries, replace `McpAgent` with `createMcpHandler`, keep the 16 tools byte-identical in behavior, remove the Durable Object binding with a `deleted_classes` migration. Verify with `wrangler dev`: initialize, tools/list, one read.
3. **Bring your own key.** Connect page, allowlist, invite cookie, consent, error copy by status, success interstitial, props shape `{ v: 2, hevyApiKey, hevyUserId, name, canWrite }`, per-grant tool registration, 401-heals-itself, admin, whoami, disconnect, template cache, security headers, logging with redaction.
4. **Front pages and docs.** `/start`, `/privacy`, README, CLAUDE.md, LICENSE, PRIVACY.md, LESSONS.md entries, the collection README and NOW.md, `tool-catalog.json` URL if the domain moves.
5. **Domain and cutover.** Custom domain, KV backup, deploy, grant purge, Kevin reconnects on each client, full friend walkthrough with a bogus key (must never see Kevin's data) and with Kevin's key, then the invite text.
6. **Public and canary.** Flip visibility, CI smoke test, weekly canary.

## 7. Verified facts (2026-09-01)

- Hevy API is key-only, Pro-only, keys issued at `hevy.com/settings?developer` and shown there persistently with a Revoke button; `GET /v1/user/info` returns `{ data: { id, name, url } }`; bad key → 401 `InvalidApiKey`; no DELETE endpoints; no published rate limit. Hevy's app terms say nothing about API keys or third-party services.
- Claude custom connectors: Free (one connector), Pro, Max, Team, Enterprise; Team/Enterprise only Owners add them; phones use but cannot add; Claude sends S256 PKCE; refresh reactive on 401 and proactive within 5 minutes of expiry. ChatGPT: Developer Mode required; writes only on Business/Enterprise/Edu.
- `workers-oauth-provider`: props encrypted with the token as key material (unconditional); `revokeExistingGrants` defaults true in 0.4.0 and 0.10.3; `clientRegistrationCallback` absent in 0.4.0, present in 0.8.0+; `refreshTokenTTL` default 30 days and `clientRegistrationTTL` 90 days since 0.5.0; plain PKCE advertised by default in 0.4.0.
- `agents` 0.20.0 deprecated `McpAgent`; the stateless handler exposes `getMcpAuthContext().props` sourced from the provider's verified token props (read in the 0.22.0 dist).
- Live KV holds 6 client registrations, 4 grants (all user `owner`), 2 access tokens. `wrangler kv key list` returned `[]` for this namespace while the REST API returned 12 keys; use the API for KV inventory.
- `kevinhg.com` is an active zone on the personal Cloudflare account; deploy credentials work from this Mac.

## 8. Draft message to the friend (Claude path)

> Made you a thing: Claude can read and write your Hevy workouts. Two steps, both on a computer.
>
> 1. hevy.kevinhg.com/start?invite=… — it walks you through getting your Hevy API key (needs Hevy Pro, $2.99/mo).
> 2. In your personal Claude: Settings → Connectors → Add custom connector → paste the URL on that page → paste your key.
>
> It runs on my server. Your key is stored encrypted and only used to talk to Hevy as you; I can technically read it, and revoking the key on Hevy's Developer page cuts it off instantly. Ask it what you benched last week. Tell me if anything is confusing.
