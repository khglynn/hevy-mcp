# hevy-mcp

A remote MCP server for the [Hevy](https://hevy.com) workout app that anyone can connect to with **their own Hevy API key**. Runs on Cloudflare Workers, speaks real OAuth 2.1 (so Claude, ChatGPT, Claude Code and Cursor all accept it), and holds each person's key encrypted inside their own OAuth grant, plus their Hevy display name so the operator can see who is connected.

Two ways to use it: connect to an instance someone runs for you, or deploy your own in about ten minutes.

## Connect (you were sent a link)

Use a computer for setup. You need Hevy Pro.

1. Open the link you were sent. It shows the connection address with a Copy button.
2. On Hevy's website, go to Settings → Developer. Copy the API key next to Revoke. The key stays there until you revoke it.
3. In Claude on the web or desktop, go to **Customize → Connectors → + → Add custom connector**. Paste the address from the page. Claude fills in the sign-in settings; keep **Always required** and **Anthropic's hosted client metadata**, then continue.
4. Claude opens the connection page. Paste your Hevy key, choose **Read only** or **Read + write**, and select **Connect**.
5. Claude shows a brief success page, then returns you to the app.

On Team or Enterprise, an Owner must first add the connector under **Organization settings → Connectors**. You can then select **Connect**.

Choose **Read only** if you only want Claude to view workouts, routines, and measurements. Choose **Read + write** if you also want it to log workouts and build routines. Hevy has no undo: editing a saved workout replaces what was there.

You must set this up on a computer. After that, you can use the connection on your phone. Using ChatGPT, Claude Code, or Cursor? Add the same address in that app.

To leave, tell your assistant **"disconnect from Hevy"**. This disconnects every app using this server and deletes the stored key. You can also revoke the key on Hevy's Developer page. Revoking it makes every stored copy stop working immediately; this server clears its copy the next time an app tries to use it. See [PRIVACY.md](./PRIVACY.md) for what is stored and for how long.

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
OWNER=$(openssl rand -hex 16); echo "owner token: $OWNER"
printf '%s' "$OWNER" | npx wrangler secret put OWNER_TOKEN        # optional, unlocks /admin
printf '%s' "Your Name" | npx wrangler secret put OPERATOR_NAME   # named on the connect + privacy pages
printf '%s' "https://buymeacoffee.com/you" | npx wrangler secret put TIP_URL   # optional tip link on three pages
npx wrangler deploy
```

Write the owner token down now — Cloudflare will not show it again.

**Open or invite-only.** Out of the box anyone who has the address can connect their own Hevy account (they only ever reach their own data; per-IP throttles are the brake). To require an invite instead, set `MCP_INVITE_CODE` (`openssl rand -hex 16 | tr -d '\n' | npx wrangler secret put MCP_INVITE_CODE`) and send people `https://<your-host>/start?invite=<code>`; the link saves the invite in their browser and the connect page asks for it only when that browser lacks it. The trade: an OAuth pop-up that opens in a different browser profile will ask for the code, which is exactly the confusion that made the maintainer's own deployment run open.

**Set your name.** The connect and privacy pages tell people who is holding their key ("a server run by …"). Until `OPERATOR_NAME` is set they say "the person who runs this server". It is set as a secret only so it survives deploys and stays out of the repo.

**Your icon.** `src/favicon.ts` holds a 128×128 PNG as a base64 string; replace `FAVICON_PNG_B64` with your own (`base64 < icon.png | tr -d '\n'`). It is the browser-tab icon, the OAuth `logo_uri`, and the MCP server icon; leave it and you ship someone else's mark.

Then send people `https://<your-host>/start`.

`/admin` (sign in with the owner token) shows who is connected (name, app, access, since when), with **Disconnect app** for one app and **Remove person** to disconnect everything they hold and forget them.

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
- **Throttled, and optionally gated.** Failed connection attempts are counted per IP and rate-limited; with `MCP_INVITE_CODE` set, a key reaches Hevy for validation only when the caller holds the invite or presents a key this server has seen before.
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
