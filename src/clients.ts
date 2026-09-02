/**
 * The clients this server will hand a key-collection page to. The page that
 * asks a person for their Hevy API key must only render for a redirect we
 * recognise; otherwise anyone could register a client and send a friend a
 * real-looking link on this domain. Enforced at /authorize and /approve
 * (the gate that matters) and at /register (belt and braces).
 */

export type ClientLabel = "Claude" | "ChatGPT" | "Claude Code" | "Cursor";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function identifyClient(redirectUri: string): ClientLabel | null {
  let u: URL;
  try {
    u = new URL(redirectUri);
  } catch {
    return null;
  }
  // claude.ai / claude.com web, desktop and mobile share one fixed callback.
  if ((u.origin === "https://claude.ai" || u.origin === "https://claude.com") && u.pathname === "/api/mcp/auth_callback") {
    return "Claude";
  }
  // ChatGPT: per-connector callback, or the stable redirect for RFC 9207 servers.
  if (
    u.origin === "https://chatgpt.com" &&
    (u.pathname.startsWith("/connector/oauth/") || u.pathname === "/connector_platform_oauth_redirect")
  ) {
    return "ChatGPT";
  }
  // Claude Code (and other local CLIs) use an RFC 8252 loopback redirect on an ephemeral port.
  if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname) && u.pathname === "/callback") {
    return "Claude Code";
  }
  if (
    redirectUri === "cursor://anysphere.cursor-mcp/oauth/callback" ||
    (u.origin === "https://www.cursor.com" && u.pathname === "/agents/mcp/oauth/callback")
  ) {
    return "Cursor";
  }
  return null;
}

/** What the consent screen says the client will be able to do, in the person's words. */
export function describeClient(label: ClientLabel): string {
  switch (label) {
    case "Claude Code":
      return "Claude Code, an app on your computer";
    default:
      return label;
  }
}
