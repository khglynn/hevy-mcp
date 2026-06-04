# hevy-mcp

Self-hosted MCP server wrapping the [Hevy](https://hevy.com) workout API. Runs on Cloudflare Workers, gated by a self-issued OAuth passphrase, and connects to **both Claude and ChatGPT**.

**Live:** `https://hevy-mcp.kevinhg.workers.dev/mcp` · **Account:** personal Cloudflare (`kevin@trimm.co`)

## What it does

16 tools over the Hevy API — 10 read, 6 write:

- **Read:** workouts (list / by-id / count), routines (list / by-id), routine folders, exercise-template search, exercise history, body measurements, user info
- **Write:** log a workout, update a workout, create routine / routine folder / custom exercise template / body measurement

Reads work in both clients. Writes work from Claude; from ChatGPT they need a Business/Enterprise plan (Plus/Pro is read-only — a ChatGPT platform limit, not a server one).

## How it's built

| Piece | Role |
|-------|------|
| `@cloudflare/workers-oauth-provider` | Real OAuth 2.1 + PKCE + DCR/CIMD. The "login" is a single passphrase you set — no Google/GitHub. |
| `McpAgent` (Agents SDK) + SQLite Durable Object | The MCP server, one DO per session. Free tier. |
| `src/hevy.ts` | Hevy API client — handles pagination (`pageSize ≤ 10`) and 429 backoff. |
| Secrets | `HEVY_API_KEY` (your Hevy Pro key) + `MCP_PASSPHRASE` (the gate). Server-side, never in git. |

```
src/
  index.ts   OAuthProvider wiring + the HevyMCP Durable Object
  mcp.ts     the 16 tools (each wrapped so Hevy errors surface, not swallow)
  hevy.ts    Hevy API client (pagination + backoff)
  auth.ts    passphrase /authorize screen + /approve
```

## Connect

**Claude.ai:** Settings → Connectors → Add custom connector → paste the `/mcp` URL (leave Client ID/Secret blank) → enter the passphrase.

**ChatGPT:** Settings → Apps & Connectors → Advanced → Developer Mode (web only) → add the `/mcp` URL → OAuth → passphrase.

## Develop

```bash
npm install
npm run dev            # local at http://localhost:8787 (uses .dev.vars secrets)
npm run type-check
```

`.dev.vars` holds `HEVY_API_KEY` + `MCP_PASSPHRASE` for local dev — it is **gitignored**.

## Deploy

Deploys to the **personal** Cloudflare account. Because an unlabeled `CLOUDFLARE_API_TOKEN` may sit in the shell env, every command unsets it so it uses the browser login:

```bash
env -u CLOUDFLARE_API_TOKEN npx wrangler whoami     # confirm kevin@trimm.co first
env -u CLOUDFLARE_API_TOKEN npx wrangler deploy
# secrets (one-time / on change), piped without trailing newline:
printf '%s' "<key>"  | env -u CLOUDFLARE_API_TOKEN npx wrangler secret put HEVY_API_KEY
printf '%s' "<pass>" | env -u CLOUDFLARE_API_TOKEN npx wrangler secret put MCP_PASSPHRASE
```

## Notes / limits

- Hevy API requires **Hevy Pro**; the key lives at `hevy.com/settings?developer`.
- Hevy's rate limit is undocumented and low — the client backs off on 429.
- Webhooks exist but aren't in Hevy's published spec — deferred to v2.
- `create_exercise_template` enums are validated server-side by Hevy; an error response lists valid values.
