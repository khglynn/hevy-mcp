/**
 * Self-handled OAuth front end. workers-oauth-provider owns the real OAuth 2.1
 * endpoints (/token, /register) and token issuance; this Hono app only renders
 * the /authorize login and validates a single passphrase before completing the
 * grant. That's enough to satisfy ChatGPT's and Claude's OAuth requirements
 * while keeping the gate to "just me."
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { html } from "hono/html";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

const app = new Hono<{ Bindings: Bindings }>();

const layout = (body: unknown, title: string) => html`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${title}</title>
      <style>
        body { font-family: system-ui, sans-serif; background: #0f1115; color: #e6e6e6;
               display: flex; min-height: 100vh; margin: 0; align-items: center; justify-content: center; }
        .card { background: #181b21; padding: 2rem 2.25rem; border-radius: 12px;
                box-shadow: 0 10px 40px rgba(0,0,0,.4); width: 320px; }
        h1 { font-size: 1.15rem; margin: 0 0 .25rem; }
        p { color: #9aa0aa; font-size: .85rem; margin: 0 0 1.25rem; }
        input { width: 100%; box-sizing: border-box; padding: .65rem .75rem; border-radius: 8px;
                border: 1px solid #2a2f38; background: #0f1115; color: #e6e6e6; font-size: .95rem; }
        button { width: 100%; margin-top: 1rem; padding: .7rem; border: 0; border-radius: 8px;
                 background: #4f8cff; color: #fff; font-weight: 600; font-size: .95rem; cursor: pointer; }
        .err { color: #ff7a7a; font-size: .85rem; margin-bottom: .75rem; }
        code { color: #c8d2e0; }
      </style>
    </head>
    <body>
      <div class="card">${body}</div>
    </body>
  </html>`;

// Homepage — confirms the server is up.
app.get("/", (c) =>
  c.html(
    layout(
      html`<h1>Hevy MCP</h1>
        <p>Running. Add <code>${new URL(c.req.url).origin}/mcp</code> as a custom connector in Claude or ChatGPT.</p>`,
      "Hevy MCP",
    ),
  ),
);

// OAuth authorize screen — ask for the passphrase.
app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  return c.html(loginScreen(oauthReqInfo));
});

// Validate the passphrase, then complete the OAuth grant.
app.post("/approve", async (c) => {
  const body = await c.req.parseBody();
  const passphrase = String(body.passphrase ?? "");

  let oauthReqInfo: AuthRequest | null = null;
  try {
    oauthReqInfo = JSON.parse(String(body.oauthReqInfo)) as AuthRequest;
  } catch {
    oauthReqInfo = null;
  }
  if (!oauthReqInfo) return c.html(layout(html`<p class="err">Invalid authorization request.</p>`, "Hevy MCP"), 400);

  if (passphrase !== c.env.MCP_PASSPHRASE) {
    return c.html(loginScreen(oauthReqInfo, "Incorrect passphrase."), 401);
  }

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: "owner",
    metadata: { label: "Hevy MCP owner" },
    scope: oauthReqInfo.scope,
    props: {},
  });
  return c.redirect(redirectTo);
});

function loginScreen(oauthReqInfo: AuthRequest, error?: string) {
  return layout(
    html`<h1>Connect Hevy MCP</h1>
      <p>Enter the passphrase to authorize this client.</p>
      ${error ? html`<div class="err">${error}</div>` : ""}
      <form action="/approve" method="POST">
        <input type="hidden" name="oauthReqInfo" value="${JSON.stringify(oauthReqInfo)}" />
        <input
          type="password"
          name="passphrase"
          placeholder="Passphrase"
          autocomplete="current-password"
          autofocus
          required
        />
        <button type="submit">Authorize</button>
      </form>`,
    "Authorize Hevy MCP",
  );
}

export default app;
