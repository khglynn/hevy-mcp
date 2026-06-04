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

/** Constant-time compare so the passphrase can't be recovered via response timing. */
function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // The passphrase length is not the secret; the content comparison below is
  // constant-time for equal-length inputs.
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

const layout = (body: unknown, title: string) => html`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${title}</title>
      <link rel="icon" href="/icon.svg" type="image/svg+xml" />
      <style>
        body { font-family: system-ui, sans-serif; background: #0f1115; color: #e6e6e6;
               display: flex; min-height: 100vh; margin: 0; align-items: center; justify-content: center; }
        .card { background: #181b21; padding: 2rem 2.25rem; border-radius: 12px;
                box-shadow: 0 10px 40px rgba(0,0,0,.4); width: 320px; }
        h1 { font-size: 1.15rem; margin: 0 0 .25rem; }
        p { color: #9aa0aa; font-size: .85rem; margin: 0 0 1.25rem; }
        .field { position: relative; }
        input { width: 100%; box-sizing: border-box; padding: .65rem 3.6rem .65rem .75rem; border-radius: 8px;
                border: 1px solid #2a2f38; background: #0f1115; color: #e6e6e6; font-size: .95rem; }
        .toggle { position: absolute; right: .4rem; top: 50%; transform: translateY(-50%);
                  background: transparent; border: 0; color: #9aa0aa; font-size: .8rem; font-weight: 500;
                  cursor: pointer; padding: .3rem .45rem; border-radius: 6px; }
        .toggle:hover { color: #e6e6e6; background: #232833; }
        .btn { width: 100%; margin-top: 1rem; padding: .7rem; border: 0; border-radius: 8px;
               background: #4f8cff; color: #fff; font-weight: 600; font-size: .95rem; cursor: pointer; }
        .btn:hover { background: #3f7cf0; }
        .err { color: #ff7a7a; font-size: .85rem; margin-bottom: .75rem; }
        code { color: #c8d2e0; }
      </style>
    </head>
    <body>
      <div class="card">${body}</div>
    </body>
  </html>`;

// Server/connector icon (a simple dumbbell). Referenced by serverInfo.icons
// and the page favicon. Served unauthenticated — it's just an icon.
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#4f8cff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5v11M3.5 9v6M17.5 6.5v11M20.5 9v6M6.5 12h11"/></svg>`;

app.get("/icon.svg", (c) =>
  c.body(ICON_SVG, 200, {
    "content-type": "image/svg+xml",
    "cache-control": "public, max-age=86400",
  }),
);

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

// Validate the passphrase (constant-time), then complete the OAuth grant.
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

  if (!constantTimeEqual(passphrase, c.env.MCP_PASSPHRASE)) {
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
        <div class="field">
          <input
            type="password"
            id="passphrase"
            name="passphrase"
            placeholder="Passphrase"
            autocomplete="current-password"
            autofocus
            required
          />
          <button type="button" id="toggle" class="toggle" aria-label="Show passphrase">Show</button>
        </div>
        <button type="submit" class="btn">Authorize</button>
      </form>
      <script>
        (function () {
          var i = document.getElementById("passphrase");
          var t = document.getElementById("toggle");
          if (!i || !t) return;
          t.addEventListener("click", function () {
            var showing = i.type === "password";
            i.type = showing ? "text" : "password";
            t.textContent = showing ? "Hide" : "Show";
            i.focus();
          });
        })();
      </script>`,
    "Authorize Hevy MCP",
  );
}

export default app;
