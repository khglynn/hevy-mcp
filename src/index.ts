/**
 * Entry point. workers-oauth-provider wraps everything: it owns /token,
 * /register and token verification, routes authenticated /mcp traffic to the
 * HevyMCP Durable Object, and hands everything else to the auth Hono app
 * (homepage + /authorize passphrase gate).
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import authApp from "./auth";
import { registerHevyTools } from "./mcp";

export class HevyMCP extends McpAgent<Env> {
  server = new McpServer({ name: "hevy-mcp", version: "0.1.0" });

  async init() {
    registerHevyTools(this.server, this.env);
  }
}

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: HevyMCP.serve("/mcp"),
  defaultHandler: authApp,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  // CIMD (ChatGPT's preferred client registration). Requires BOTH this option
  // AND the global_fetch_strictly_public compat flag in wrangler.jsonc. Clients
  // that don't use CIMD fall back to Dynamic Client Registration automatically.
  clientIdMetadataDocumentEnabled: true,
});
