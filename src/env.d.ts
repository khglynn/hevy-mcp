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
  /** Who runs this deployment, as named on the connect and privacy pages. Set as a secret so it survives deploys and stays out of the repo. */
  OPERATOR_NAME?: string;
  /** Optional. An https link (Buy Me a Coffee, Ko-fi) shown lightly on a few pages. */
  TIP_URL?: string;
}
