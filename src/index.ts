/**
 * Entry point. workers-oauth-provider wraps everything: it owns /token,
 * /register and token verification, routes authenticated /mcp traffic to the
 * stateless MCP handler with the grant's decrypted props on ctx.props, and
 * hands everything else to the Hono pages app (start, authorize, privacy,
 * admin).
 *
 * The provider's fetch is wrapped once more to inject connector branding
 * (`logo_uri`) into the OAuth discovery metadata.
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { identifyClient } from "./clients";
import pages from "./pages";
import { buildServer, isHevyProps } from "./mcp";
import { type AppEnv, clientIp, log, sha256Hex } from "./util";

const DAY = 24 * 60 * 60;

/**
 * Authenticated /mcp requests. The provider has already validated the bearer
 * token and decrypted its props onto ctx.props. Anything that is not a v2
 * grant (a pre-cutover token with empty props, say) gets an HTTP 401 so the
 * client re-runs OAuth instead of sending `api-key: undefined` to Hevy.
 */
const api = {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const origin = new URL(request.url).origin;
    const props = (ctx as ExecutionContext & { props?: unknown }).props;
    if (!isHevyProps(props)) {
      log("mcp.reconnect_required", { reason: props && typeof props === "object" ? "props_shape" : "no_props" });
      return new Response(
        JSON.stringify({ error: "invalid_token", error_description: "Reconnect this connector and paste your Hevy API key." }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": `Bearer error="invalid_token", error_description="reconnect required", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        },
      );
    }
    // /mcp is bearer-only and reads no cookies, so browser CSRF / DNS rebinding —
    // the threat Origin validation defends against — does not apply. Without
    // this, agents 0.22.0 allowlists localhost only, and every request that
    // carries an Origin header is 403'd on the custom domain.
    // The provider's access tokens are `userId:grantId:secret`; the token record
    // is keyed by the token's SHA-256. Both are what `disconnect` needs to
    // revoke exactly this connection.
    const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const parts = bearer.split(":");
    const grant =
      parts.length === 3 && parts[0] === props.hevyUserId
        ? { id: parts[1], tokenKey: `token:${parts[0]}:${parts[1]}:${await sha256Hex(bearer)}` }
        : undefined;
    // The provider validates a bearer against its token record alone, and a
    // grant can hold several access tokens (each refresh mints one). Revoking
    // a grant deletes the token records it can list, but KV lists are
    // eventually consistent, so a straggler could outlive its grant by up to
    // seven days. One extra read closes that: no grant, no service.
    if (grant && (await env.OAUTH_KV.get(`grant:${props.hevyUserId}:${grant.id}`)) === null) {
      log("mcp.reconnect_required", { reason: "grant_revoked" });
      return new Response(
        JSON.stringify({ error: "invalid_token", error_description: "This connection was disconnected. Reconnect the connector." }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": `Bearer error="invalid_token", error_description="connection revoked", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        },
      );
    }
    const handler = createMcpHandler(() => buildServer({ env, props, origin, grant }), {
      route: "/mcp",
      allowedOriginHostnames: "*",
    });
    return handler(request, env, ctx);
  },
};

const provider = new OAuthProvider<AppEnv>({
  apiRoute: "/mcp",
  apiHandler: api,
  defaultHandler: pages,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  // CIMD (ChatGPT's and Claude Code's preferred client registration). Requires
  // BOTH this option AND the global_fetch_strictly_public compat flag in
  // wrangler.jsonc. Clients that don't use CIMD fall back to DCR.
  clientIdMetadataDocumentEnabled: true,
  // Advertise offline_access so clients that key refresh on it (ChatGPT) keep
  // refreshing past the 7-day access token instead of asking to reconnect.
  scopesSupported: ["offline_access"],
  // S256 only. Claude and ChatGPT always send S256; `plain` protects nothing.
  allowPlainPKCE: false,
  // A token here is also the decryption key for someone's Hevy credential, so
  // access tokens are short and clients refresh them silently. The refresh
  // token's clock does NOT slide on use (verified in 0.10.3: the grant's
  // expiresAt is written once, at code exchange), so this is a hard lifetime:
  // a year from the day someone connects, then they paste their key again.
  accessTokenTTL: 7 * DAY,
  refreshTokenTTL: 365 * DAY,
  // DCR client records (claude.ai registers once per connector) outlive grants.
  clientRegistrationTTL: 365 * DAY,
  // Belt and braces for the allowlist enforced at /authorize: a dynamic
  // registration whose redirect URIs aren't all recognised clients is refused.
  clientRegistrationCallback: ({ clientMetadata }) => {
    const uris = clientMetadata.redirect_uris;
    const allKnown =
      Array.isArray(uris) && uris.length > 0 && uris.every((u) => typeof u === "string" && identifyClient(u) !== null);
    if (allKnown) return;
    log("oauth.registration_refused", { redirect_uris: uris });
    return {
      code: "invalid_redirect_uri",
      description: "This server only connects to Claude, ChatGPT, Claude Code and Cursor.",
      status: 400,
    };
  },
  onError: ({ code, description, status }) => {
    log("oauth.error", { code, description, status });
  },
});

// Connector-card branding. Hosts read `logo_uri` from the OAuth discovery
// metadata PRE-auth. The provider doesn't expose that field, so it is injected
// into the two .well-known documents, pointed at the unauthenticated
// /favicon.png. Match the root forms AND the path-specific variants (RFC
// 9728/8414) — e.g. /.well-known/oauth-protected-resource/mcp, which is where
// the 401's WWW-Authenticate sends MCP clients.
function isOAuthMetadataPath(pathname: string): boolean {
  return (
    pathname.startsWith("/.well-known/oauth-authorization-server") ||
    pathname.startsWith("/.well-known/oauth-protected-resource")
  );
}

/** Headers every response gets, including the provider's own endpoints (/token, /register, /mcp). */
function withBaseHeaders(res: Response, url: URL): Response {
  const headers = new Headers(res.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  if (url.protocol === "https:") headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Dynamic client registration is unauthenticated and writes a year-long KV
    // record per call, so it gets its own brake (per source, best effort).
    if (request.method === "POST" && url.pathname === "/register" && env.REGISTER_RL) {
      const rl = await env.REGISTER_RL.limit({ key: clientIp(request) }).catch(() => ({ success: true }));
      if (!rl.success) {
        log("oauth.registration_throttled", {});
        return withBaseHeaders(
          new Response(JSON.stringify({ error: "temporarily_unavailable", error_description: "Too many registrations; try again in a minute." }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "60" },
          }),
          url,
        );
      }
    }
    const res = await provider.fetch(request, env, ctx);
    if (request.method === "GET" && isOAuthMetadataPath(url.pathname) && res.ok) {
      try {
        const meta = (await res.clone().json()) as Record<string, unknown>;
        meta.logo_uri = `${url.origin}/favicon.png`;
        if (url.pathname.includes("authorization-server")) {
          meta.service_documentation = `${url.origin}/`;
        }
        const headers = new Headers(res.headers);
        headers.delete("content-length");
        return withBaseHeaders(new Response(JSON.stringify(meta), { status: res.status, headers }), url);
      } catch {
        return withBaseHeaders(res, url); // if the body isn't JSON for any reason, pass it through
      }
    }
    return withBaseHeaders(res, url);
  },
} satisfies ExportedHandler<AppEnv>;
