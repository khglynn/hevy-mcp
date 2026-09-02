# hevy-mcp

A remote MCP server for the [Hevy](https://hevy.com) workout app that anyone can connect to with **their own Hevy API key**. Runs on Cloudflare Workers, speaks real OAuth 2.1 (so Claude, ChatGPT, Claude Code and Cursor all accept it), and holds each person's key encrypted inside their own OAuth grant, plus their Hevy display name so the operator can see who is connected.

Two ways to use it: connect to an instance someone runs for you, or deploy your own in about ten minutes.

## Connect (you were sent an invite link)

You need two things, both on a computer:

1. **Hevy Pro.** The Hevy API is a Pro feature; free accounts can't create a key.
2. **A Hevy API key** from [hevy.com/settings?developer](https://hevy.com/settings?developer) (the website, not the phone app). Save it somewhere — Hevy shows it once.

Then open the invite link you were sent. That page has the steps and a Copy button for the address you'll need. In short:

1. Get your key from Hevy and save it somewhere; Hevy shows it once.
2. In Claude on the web or desktop: **Customize → Connectors → + → Add custom connector**. Paste the address from that page; leave Client ID and Client Secret blank. On a Team or Enterprise account an Owner adds it under Organization settings → Connectors, then you click Connect.
3. Claude opens a page asking for your Hevy key. Paste it and press Connect.

A phone can use the connector once it is added on a computer, but can't add one. There is a checkbox, "let Claude add and edit": leave it off and Claude can only read your workouts; tick it and Claude can log workouts and build routines, but Hevy has no undo, so anything it changes in a saved workout replaces what was there. Using ChatGPT, Claude Code or Cursor? Open the invite link first, then add the same address the way that app adds MCP servers.

Leaving: ask Claude to **"disconnect from Hevy"** — that revokes the connection and deletes the stored key. Or rotate your key at Hevy, which instantly makes the stored copy useless (it is cleared the next time anything tries to use it). See [PRIVACY.md](./PRIVACY.md) for what is stored and for how long.

## Deploy your own

Prerequisites: a free Cloudflare account, Node 22 or newer (wrangler 4.x requires it), and `npx wrangler login` done.

```bash
git clone https://github.com/khglynn/hevy-mcp && cd hevy-mcp
npm install
npx wrangler kv namespace create OAUTH_KV     # paste the id into wrangler.jsonc
# edit wrangler.jsonc: your KV id; change or delete the custom-domain "routes"
# line; delete the "migrations" block (it is this deployment's history, not
# yours); give the three rate-limit "namespace_id"s fresh integers — a reused id
# shares its counter with another Worker in your account
INVITE=$(openssl rand -hex 16); echo "invite code: $INVITE"
printf '%s' "$INVITE" | npx wrangler secret put MCP_INVITE_CODE   # required
OWNER=$(openssl rand -hex 16); echo "owner token: $OWNER"
printf '%s' "$OWNER" | npx wrangler secret put OWNER_TOKEN        # optional, unlocks /admin
printf '%s' "Your Name" | npx wrangler secret put OPERATOR_NAME   # named on the connect + privacy pages
npx wrangler deploy
```

Write the invite code and owner token down now — Cloudflare will not show them to you again.

**Set your name.** The connect and privacy pages tell people who is holding their key ("a server run by …"). Until `OPERATOR_NAME` is set they say "the person who runs this server". It is set as a secret only so it survives deploys and stays out of the repo.

**Your icon.** `src/favicon.ts` holds a 128×128 PNG as a base64 string; replace `FAVICON_PNG_B64` with your own (`base64 < icon.png | tr -d '\n'`). It is the browser-tab icon, the OAuth `logo_uri`, and the MCP server icon; leave it and you ship someone else's mark.

Then send people `https://<your-host>/start?invite=<MCP_INVITE_CODE>`. The invite rides in the link and is remembered by the browser; nobody types it. A key that has connected before never needs it again.

`/admin` (sign in with the owner token) shows who is connected (name, client, read or write, since when), with **Revoke** for one client's grant and **Remove person** to revoke everything they hold and forget them.

Optional: set the repository variable `CANARY_BASE` to your origin for the weekly uptime check in `.github/workflows/canary.yml`, or delete that file.

Local development:

```bash
cp .dev.vars.example .dev.vars   # fill in any values
npm run dev                      # http://localhost:8787
npm run type-check
INVITE=<value from .dev.vars> OWNER_TOKEN=<value> HEVY_API_KEY=<your key> npm run test:smoke
```

The smoke test runs 48 checks (it prints the count it ran) against the dev server, including a full OAuth code exchange, a token refresh, MCP `initialize`, `tools/list` for read-only and write grants, one real Hevy call, and revocation. Without `HEVY_API_KEY` it stops after the 29 unauthenticated checks, which is what CI runs on every push.

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
| account | `disconnect` | Revokes every grant for this person and forgets the key they connected with |
| write | `create_body_measurement` | Weights in kg, circumferences in centimetres (field names carry the unit) |
| read | `get_user_info`, `get_workout_count`, `get_workouts`, `get_workout`, `get_routines`, `get_routine`, `get_routine_folders`, `get_exercise_history`, `get_body_measurements` | Paginated where Hevy paginates (`pageSize` ≤ 10) |
| read | `search_exercise_templates` | Template list cached per user for 6 hours |
| write | `create_workout`, `update_workout`, `create_routine`, `create_routine_folder`, `create_exercise_template` | `update_workout` is a full overwrite; Hevy has no delete or undo |

## Clients

- **Claude** (web, desktop, Claude Code, mobile once added elsewhere): all plans, Free limited to one custom connector; Team and Enterprise need an Owner to add it.
- **ChatGPT (web):** Business, Enterprise and Edu support full MCP including writes; Pro gets read-only MCP in Developer Mode; Plus is not currently supported for custom MCP servers. Platform limits, not this server's.
- **Cursor:** works via its own OAuth callback.

## Limits and honesty

- Hevy's API is unofficial: Pro-only, undocumented rate limits (the client backs off on 429), no delete endpoints, and Hevy says it may change or withdraw it.
- This is a personal project. No support promised. The privacy statement is [PRIVACY.md](./PRIVACY.md).

MIT © Kevin HG. Prior art worth knowing: [chrisdoc/hevy-mcp](https://github.com/chrisdoc/hevy-mcp), a larger project with a local install and its own hosted endpoint.
