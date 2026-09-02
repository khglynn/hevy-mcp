# hevy-mcp

A remote MCP server for the [Hevy](https://hevy.com) workout app that anyone can connect to with **their own Hevy API key**. Runs on Cloudflare Workers, speaks real OAuth 2.1 (so Claude, ChatGPT, Claude Code and Cursor all accept it), and holds each person's key encrypted inside their own OAuth grant, plus their Hevy display name so the operator can see who is connected.

Two ways to use it: connect to an instance someone runs for you, or deploy your own in about ten minutes.

## Connect (you were sent an invite link)

You need two things, both on a computer:

1. **Hevy Pro.** The Hevy API is a Pro feature; free accounts can't create a key.
2. **A Hevy API key** from [hevy.com/settings?developer](https://hevy.com/settings?developer) (the website, not the phone app). Save it somewhere — Hevy shows it once.

Then open the invite link you were sent. That page walks you through it: get your key from Hevy, copy the connector address it shows you into Claude (Settings → Connectors → Add custom connector), and paste your key when Claude asks. Use a personal Claude account on the web or desktop app — work and school accounts usually block custom connectors, and phones can use a connector but can't add one. Tick "let Claude add and edit" only if you want it to log workouts and create routines; Hevy has no undo.

Leaving: ask Claude to **"disconnect from Hevy"** — that revokes the connection and deletes the stored key. Or rotate your key at Hevy, which instantly makes the stored copy useless (it is cleared the next time anything tries to use it). See [PRIVACY.md](./PRIVACY.md) for what is stored and for how long.

## Deploy your own

Prerequisites: a free Cloudflare account, Node 22 or newer (wrangler 4.x requires it), and `npx wrangler login` done.

```bash
git clone https://github.com/khglynn/hevy-mcp && cd hevy-mcp
npm install
npx wrangler kv namespace create OAUTH_KV     # paste the id into wrangler.jsonc
# edit wrangler.jsonc: your KV id; OPERATOR_NAME = you; change or delete the
# custom-domain "routes" line; delete the "migrations" block (it is this
# deployment's history, not yours)
INVITE=$(openssl rand -hex 16); echo "invite code: $INVITE"
printf '%s' "$INVITE" | npx wrangler secret put MCP_INVITE_CODE   # required
OWNER=$(openssl rand -hex 16); echo "owner token: $OWNER"
printf '%s' "$OWNER" | npx wrangler secret put OWNER_TOKEN        # optional, unlocks /admin
npx wrangler deploy
```

Write both values down now — Cloudflare will not show them to you again. Swap `src/favicon.ts` for your own 128px PNG if you want your mark on the pages.

Then send people `https://<your-host>/start?invite=<MCP_INVITE_CODE>`. The invite rides in the link and is remembered by the browser; nobody types it. A key that has connected before never needs it again.

`/admin?token=<OWNER_TOKEN>` shows who is connected (name, client, read or write, since when) with a revoke button.

Optional: set the repository variable `CANARY_BASE` to your origin for the weekly uptime check in `.github/workflows/canary.yml`, or delete that file.

Local development:

```bash
cp .dev.vars.example .dev.vars   # fill in any values
npm run dev                      # http://localhost:8787
npm run type-check
INVITE=<value from .dev.vars> OWNER_TOKEN=<value> HEVY_API_KEY=<your key> npm run test:smoke
```

The smoke test runs 43 checks against the dev server, including a full OAuth code exchange, a token refresh, MCP `initialize`, `tools/list` for read-only and write grants, one real Hevy call, and revocation. Without `HEVY_API_KEY` it stops after the 26 unauthenticated checks, which is what CI runs on every push.

## How it works

```
Claude ──OAuth──▶ /authorize (paste Hevy key, choose read-only or write)
                   └─ key validated against Hevy → stored ENCRYPTED in the grant
Claude ──token──▶ /mcp ──▶ fresh McpServer per request ──▶ api.hevyapp.com
```

- **Per request, no sessions.** `createMcpHandler` (Cloudflare Agents SDK) builds a new server on every call from the token's decrypted props. Nothing is written to Durable Object storage; there is no session another user could reach.
- **The key is the credential.** `@cloudflare/workers-oauth-provider` encrypts grant props with the access token as key material. A stored grant is unreadable without a live token.
- **Only known clients get the key form.** Redirect URIs are allowlisted (claude.ai, claude.com, chatgpt.com, loopback for Claude Code, Cursor) at `/authorize` and at `/register`. Anything else sees a refusal, not a key field.
- **Hevy is never a free oracle.** A key reaches Hevy for validation only when the caller holds the invite or presents a key this server has seen before; failures are counted per IP.
- **A dead key heals itself.** If Hevy answers 401 to a tool call, the server revokes that person's grants and explains; the client's next request gets HTTP 401 and re-runs OAuth.
- **Tokens:** 7-day access, refreshed silently; the connection itself lasts a year from the day of connecting (the refresh clock does not slide), then the person pastes their key again. S256 PKCE only.
- **Writes are opt-in.** The six write tools exist only on grants where the box was ticked.

## Tools

| | Tool | Notes |
|---|---|---|
| account | `whoami` | Which Hevy account, which client, read or write |
| account | `disconnect` | Revokes every grant for this person and forgets they connected |
| read | `get_user_info`, `get_workout_count`, `get_workouts`, `get_workout`, `get_routines`, `get_routine`, `get_routine_folders`, `get_exercise_history`, `get_body_measurements` | Paginated where Hevy paginates (`pageSize` ≤ 10) |
| read | `search_exercise_templates` | Template list cached per user for 6 hours |
| write | `create_workout`, `update_workout`, `create_routine`, `create_routine_folder`, `create_exercise_template`, `create_body_measurement` | `update_workout` is a full overwrite; Hevy has no delete or undo |

## Clients

- **Claude** (web, desktop, Claude Code, mobile once added elsewhere): all plans, Free limited to one custom connector; Team and Enterprise need an Owner to add it.
- **ChatGPT:** works, but needs Developer Mode, and write tools only run on Business, Enterprise and Edu plans (Plus and Pro are read-only). Not a server limit.
- **Cursor:** works via its own OAuth callback.

## Limits and honesty

- Hevy's API is unofficial: Pro-only, undocumented rate limits (the client backs off on 429), no delete endpoints, and Hevy says it may change or withdraw it.
- This is a personal project. No support promised. The privacy statement is [PRIVACY.md](./PRIVACY.md).

MIT © Kevin HG. Prior art worth knowing: [chrisdoc/hevy-mcp](https://github.com/chrisdoc/hevy-mcp), a larger project with a local install and its own hosted endpoint.
