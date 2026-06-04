/**
 * Entry point. workers-oauth-provider wraps everything: it owns /token,
 * /register and token verification, routes authenticated /mcp traffic to the
 * HevyMCP Durable Object, and hands everything else to the auth Hono app
 * (homepage + /authorize passphrase gate).
 *
 * We also wrap the provider's fetch to inject connector branding (`logo_uri`)
 * into the OAuth discovery metadata — that's what gives the connector a real
 * icon instead of a generic globe (see the branding note below).
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import authApp from "./auth";
import { FAVICON_DATA_URI } from "./favicon";
import { registerHevyTools } from "./mcp";

export class HevyMCP extends McpAgent<Env> {
  // serverInfo title + icons (MCP 2025-11 spec). NOTE: a host reads serverInfo
  // icons only AFTER connecting, and support is uneven. The connector-CARD icon
  // (pre-auth, in the connectors list) comes from `logo_uri` in the OAuth
  // metadata, injected below. See CLAUDE.md "Icon".
  server = new McpServer({
    name: "hevy-mcp",
    version: "0.1.0",
    title: "Hevy",
    icons: [{ src: FAVICON_DATA_URI, mimeType: "image/png", sizes: ["128x128"] }],
  });

  async init() {
    registerHevyTools(this.server, this.env);
  }
}

const provider = new OAuthProvider({
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

// Connector-card branding. Hosts (Claude, ChatGPT) read `logo_uri` from the
// OAuth discovery metadata PRE-auth to show a custom icon instead of a generic
// globe. The provider doesn't expose that field, so we inject it into the two
// .well-known documents, pointed at the unauthenticated /favicon.png. This is
// the mechanism real-world connectors use today; serverInfo.icons (above) is
// the post-connect fallback for clients that read it.
const BRANDED_METADATA = new Set([
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
]);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const res = await provider.fetch(request, env, ctx);
    const url = new URL(request.url);
    if (request.method === "GET" && BRANDED_METADATA.has(url.pathname) && res.ok) {
      try {
        const meta = (await res.clone().json()) as Record<string, unknown>;
        meta.logo_uri = `${url.origin}/favicon.png`;
        if (url.pathname.endsWith("authorization-server")) {
          meta.service_documentation = `${url.origin}/`;
        }
        const headers = new Headers(res.headers);
        headers.delete("content-length");
        return new Response(JSON.stringify(meta), { status: res.status, headers });
      } catch {
        return res; // if the body isn't JSON for any reason, pass it through
      }
    }
    return res;
  },
};
