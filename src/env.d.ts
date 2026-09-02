/**
 * Secrets set with `wrangler secret put` (prod) or `.dev.vars` (local).
 * `wrangler types` only sees these when a .dev.vars exists, so they are
 * declared here to keep the build honest on a fresh clone.
 */
interface Env {
  /** Required. The server refuses every new connection when unset. */
  MCP_INVITE_CODE?: string;
  /** Optional. Unlocks /admin; /admin is a 404 when unset. */
  OWNER_TOKEN?: string;
}
