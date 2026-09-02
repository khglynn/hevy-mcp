/**
 * Every page a person sees: /start (the link the operator sends), /authorize and
 * /approve (the OAuth consent step where they paste their own Hevy key),
 * /privacy, and /admin (owner only). workers-oauth-provider owns the actual
 * OAuth endpoints (/token, /register); this app only renders the login step
 * and completes the grant.
 *
 * Order of checks on /approve: throttle → known client → key shape → invite
 * (only when the deployment sets MCP_INVITE_CODE) → Hevy → membership. With an
 * invite configured, Hevy is only asked about a key when the caller holds the
 * invite or presents a key that connected before; without one, the per-IP
 * throttles are the brake. Kevin's own deployment runs open: the key is the
 * credential, and a stranger connecting only reaches their own Hevy account.
 *
 * Look: "iron and chalk". Near-black ground, gunmetal surfaces, chalk-white
 * type, one safety-orange accent; Barlow Condensed for display (gym signage),
 * Barlow for body. The signature on /start is the barbell rail: three numbered
 * plates for the three real steps. Copy was reviewed by Codex on 2026-09-01.
 */

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { type Context, Hono } from "hono";
import { html } from "hono/html";
import { type ClientLabel, describeClient, identifyClient } from "./clients";
import { FAVICON_SIZE, faviconPngBytes } from "./favicon";
import { OG_HEIGHT, OG_WIDTH, ogPngBytes } from "./og-image";
import { HevyError, validateHevyKey } from "./hevy";
import { PROPS_VERSION } from "./mcp";
import {
  type AppEnv,
  UUID_RE,
  clientIp,
  constantTimeEqual,
  cookie,
  deriveUserId,
  getCookie,
  keyFingerprint,
  log,
  memberKeyFor,
  operatorName,
  randomToken,
  forgetPerson,
  sha256Hex,
  tipUrl,
} from "./util";

type Vars = { nonce: string };
const app = new Hono<{ Bindings: AppEnv; Variables: Vars }>();

const INVITE_COOKIE = "hevy_invite";
const OWNER_COOKIE = "hevy_owner";
const DAY = 24 * 60 * 60;
const MAX_FAILS_PER_HOUR = 20;
const HEVY_DEVELOPER_URL = "https://hevy.com/settings?developer";

// ---------- security headers on every page (nosniff/referrer/HSTS are added for ALL routes in index.ts) ----------
app.use("*", async (c, next) => {
  const nonce = randomToken();
  c.set("nonce", nonce);
  await next();
  c.header(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`,
  );
  if (!STATIC_PATHS.has(c.req.path)) c.header("Cache-Control", "no-store");
});

/** Images that may be cached; every page is no-store. */
const STATIC_PATHS = new Set(["/favicon.png", "/favicon.ico", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png", "/og.png"]);

// ---------- layout ----------
/** Link-preview tags for pages people paste into chats. The image URL must be absolute, so the origin is required. */
interface ShareMeta {
  origin: string;
  description: string;
}

const shareTags = (title: string, share: ShareMeta) => html`<meta property="og:type" content="website" />
      <meta property="og:site_name" content="${new URL(share.origin).host}" />
      <meta property="og:title" content="${title}" />
      <meta property="og:description" content="${share.description}" />
      <meta property="og:image" content="${share.origin}/og.png" />
      <meta property="og:image:width" content="${OG_WIDTH}" />
      <meta property="og:image:height" content="${OG_HEIGHT}" />
      <meta property="og:image:alt" content="${title}" />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="description" content="${share.description}" />`;

const layout = (body: unknown, title: string, page: string, share?: ShareMeta) => html`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <meta name="theme-color" content="#0b0d11" />
      <title>${title}</title>
      <link rel="icon" href="/favicon.png" type="image/png" sizes="${FAVICON_SIZE}x${FAVICON_SIZE}" />
      <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      ${share ? shareTags(title, share) : ""}
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Barlow:wght@400;500;600&display=swap" />
      <style>
        :root {
          --iron: #0b0d11; --plate: #14181e; --plate-2: #1b2028; --edge: #262d36;
          --chalk: #f3efe6; --ash: #8d96a1; --tape: #ff7a1a; --tape-ink: #1a0f05;
          --lift: #43d17a; --fault: #ff5f5f;
          color-scheme: dark;
        }
        * { box-sizing: border-box; }
        html { background: var(--iron); }
        body { margin: 0; background: var(--iron); color: var(--chalk); font-family: "Barlow", "Helvetica Neue", Arial, sans-serif; font-size: 17px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
        main { max-width: 640px; margin: 0 auto; padding: 56px 22px 72px; }
        .eyebrow { display: inline-flex; align-items: center; gap: 10px; font-family: "Barlow Condensed", "Arial Narrow", sans-serif; font-weight: 700; font-size: 15px; letter-spacing: .14em; text-transform: uppercase; color: var(--tape); }
        .eyebrow::before { content: ""; width: 26px; height: 3px; background: var(--tape); }
        h1 { font-family: "Barlow Condensed", "Arial Narrow", sans-serif; font-weight: 800; font-size: clamp(44px, 9vw, 68px); line-height: .95; letter-spacing: -.01em; text-transform: uppercase; margin: 14px 0 18px; text-wrap: balance; }
        h2 { font-family: "Barlow Condensed", "Arial Narrow", sans-serif; font-weight: 700; font-size: 26px; line-height: 1.05; letter-spacing: .01em; text-transform: uppercase; margin: 0 0 6px; }
        p { margin: 0 0 12px; max-width: 58ch; }
        .lede { font-size: 19px; color: var(--chalk); max-width: 46ch; }
        .fine { color: var(--ash); font-size: 15px; }
        a { color: var(--chalk); text-decoration-color: var(--tape); text-underline-offset: 3px; }
        a:hover { color: var(--tape); }
        b { font-weight: 600; }

        .pre { display: flex; gap: 12px; align-items: baseline; margin: 30px 0 0; padding: 14px 16px; border: 1px solid var(--edge); border-radius: 6px; background: var(--plate); }
        .pre .k { font-family: "Barlow Condensed", sans-serif; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--tape); font-size: 15px; white-space: nowrap; }
        .pre p { margin: 0; }

        /* the barbell rail: three plates for three real steps */
        .rail { list-style: none; margin: 34px 0 0; padding: 0; position: relative; }
        .rail::before { content: ""; position: absolute; left: 25px; top: 24px; bottom: 24px; width: 4px; background: var(--edge); border-radius: 2px; }
        .step { position: relative; display: grid; grid-template-columns: 54px 1fr; gap: 18px; padding: 0 0 34px; }
        .step:last-child { padding-bottom: 0; }
        .plate { width: 54px; height: 54px; border-radius: 50%; background: var(--plate-2); border: 4px solid var(--tape); box-shadow: inset 0 0 0 4px var(--iron); display: grid; place-items: center; font-family: "Barlow Condensed", sans-serif; font-weight: 800; font-size: 24px; color: var(--chalk); position: relative; z-index: 1; }
        .step .body { padding-top: 8px; }

        .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 13px 20px; border-radius: 6px; border: 0; background: var(--tape); color: var(--tape-ink); font-family: "Barlow Condensed", sans-serif; font-weight: 800; font-size: 19px; letter-spacing: .06em; text-transform: uppercase; text-decoration: none; cursor: pointer; }
        .btn:hover { filter: brightness(1.08); }
        .btn:focus-visible, input:focus-visible, .copy:focus-visible { outline: 3px solid var(--tape); outline-offset: 2px; }
        .btn.ghost { background: transparent; color: var(--chalk); box-shadow: inset 0 0 0 2px var(--edge); }
        .btn.ghost:hover { box-shadow: inset 0 0 0 2px var(--tape); color: var(--tape); }
        .btn.wide { width: 100%; padding: 16px; font-size: 22px; margin-top: 20px; }
        .btn[disabled] { opacity: .6; cursor: default; }

        .url { display: flex; gap: 8px; align-items: stretch; margin: 12px 0 10px; }
        .url code { flex: 1; background: var(--iron); border: 1px solid var(--edge); border-radius: 6px; padding: 12px 14px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 16px; overflow-x: auto; white-space: nowrap; color: var(--chalk); }
        .copy { background: var(--plate-2); border: 1px solid var(--edge); color: var(--chalk); border-radius: 6px; padding: 0 16px; cursor: pointer; font-family: "Barlow Condensed", sans-serif; font-weight: 700; font-size: 17px; letter-spacing: .06em; text-transform: uppercase; }
        .copy:hover { border-color: var(--tape); color: var(--tape); }

        label { display: block; font-family: "Barlow Condensed", sans-serif; font-weight: 700; font-size: 18px; letter-spacing: .06em; text-transform: uppercase; color: var(--ash); margin: 22px 0 8px; }
        .field { position: relative; }
        input[type=text], input[type=password] { width: 100%; padding: 14px 76px 14px 14px; border-radius: 6px; border: 1px solid var(--edge); background: var(--iron); color: var(--chalk); font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 17px; }
        input[type=text]:focus, input[type=password]:focus { border-color: var(--tape); outline: none; }
        .toggle { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); background: transparent; border: 0; color: var(--ash); font-family: "Barlow Condensed", sans-serif; font-weight: 700; font-size: 15px; letter-spacing: .06em; text-transform: uppercase; cursor: pointer; padding: 6px 8px; border-radius: 4px; }
        .toggle:hover { color: var(--chalk); background: var(--plate-2); }

        fieldset { border: 0; padding: 0; margin: 22px 0 0; }
        legend { font-family: "Barlow Condensed", sans-serif; font-weight: 700; font-size: 18px; letter-spacing: .06em; text-transform: uppercase; color: var(--ash); padding: 0; margin-bottom: 8px; }
        .opt { display: grid; grid-template-columns: 22px 1fr; gap: 12px; align-items: start; background: var(--plate); border: 1px solid var(--edge); border-radius: 6px; padding: 12px 14px; margin: 0 0 8px; cursor: pointer; font-family: "Barlow", sans-serif; font-size: 16px; letter-spacing: 0; text-transform: none; color: var(--chalk); }
        .opt:has(input:checked) { border-color: var(--tape); }
        .opt input { margin: 3px 0 0; accent-color: var(--tape); }
        .opt small { display: block; color: var(--ash); font-size: 14px; margin-top: 2px; }

        .banner { border-radius: 6px; padding: 12px 14px; font-size: 15px; margin: 18px 0 0; border: 1px solid; }
        .banner.ok { border-color: var(--lift); color: var(--lift); background: rgba(67,209,122,.08); }
        .banner.err { border-color: var(--fault); color: #ffb3b3; background: rgba(255,95,95,.08); }
        .banner.note { border-color: var(--edge); color: var(--chalk); background: var(--plate); }
        #mobile { display: none; }

        .strip { margin-top: 44px; padding-top: 20px; border-top: 1px solid var(--edge); }
        .strip p { color: var(--ash); font-size: 15px; max-width: none; }
        .strip a { white-space: nowrap; }
        sup a { text-decoration: none; color: var(--tape); font-weight: 700; }
        .preview { margin: 0 0 18px; }
        .tip { margin-top: 8px; color: var(--ash); font-size: 15px; }
        .tip a { color: var(--ash); text-decoration: underline; text-decoration-color: var(--edge); text-decoration-thickness: 1px; text-underline-offset: 3px; }
        .tip a:hover { color: var(--tape); text-decoration-color: var(--tape); }
        table { width: 100%; border-collapse: collapse; font-size: 15px; }
        th { font-family: "Barlow Condensed", sans-serif; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--ash); font-size: 15px; }
        th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--edge); vertical-align: top; }
        .small { font-size: 13px; color: var(--ash); font-family: ui-monospace, Menlo, monospace; }
        .stamp { font-family: "Barlow Condensed", sans-serif; font-weight: 800; font-size: clamp(64px, 14vw, 110px); line-height: .9; text-transform: uppercase; color: var(--tape); margin: 0 0 8px; }
        @media (prefers-reduced-motion: no-preference) { .btn, .copy, .opt { transition: filter .15s, border-color .15s, color .15s, box-shadow .15s; } }
        @media (max-width: 480px) { main { padding: 36px 16px 56px; } .step { grid-template-columns: 46px 1fr; gap: 14px; } .plate { width: 46px; height: 46px; font-size: 21px; } .rail::before { left: 21px; } }
      </style>
    </head>
    <body>
      <main data-page="${page}">${body}</main>
    </body>
  </html>`;

// ---------- static bits ----------
app.get("/favicon.png", (c) =>
  c.body(faviconPngBytes(), 200, { "content-type": "image/png", "cache-control": "public, max-age=86400" }),
);
app.get("/favicon.ico", (c) =>
  c.body(faviconPngBytes(), 200, { "content-type": "image/png", "cache-control": "public, max-age=86400" }),
);
app.get("/apple-touch-icon.png", (c) =>
  c.body(faviconPngBytes(), 200, { "content-type": "image/png", "cache-control": "public, max-age=86400" }),
);
app.get("/apple-touch-icon-precomposed.png", (c) =>
  c.body(faviconPngBytes(), 200, { "content-type": "image/png", "cache-control": "public, max-age=86400" }),
);
app.get("/og.png", (c) =>
  c.body(ogPngBytes(), 200, { "content-type": "image/png", "cache-control": "public, max-age=86400" }),
);

// ---------- /start — the link the operator sends ----------
function startPage(origin: string, inviteState: "ok" | "bad" | "none", operator: string, tip: string | null, nonce: string) {
  return layout(
    html`<h1>Connect Hevy<br />to Claude.</h1>
      <p class="lede">Build routines, add exercises, log workouts, and pull your whole Hevy history into any<sup><a href="#any-ai">*</a></sup> AI assistant.</p>
      ${inviteState === "ok" ? html`<div class="banner ok">Invite saved. Follow the steps below.</div>` : ""}
      ${inviteState === "bad" ? html`<div class="banner err">This invite link isn't right. Open the original link exactly as it was sent to you.</div>` : ""}
      <div id="mobile" class="banner note">Open this link on a computer. You can't finish setup on a phone.</div>

      <div class="pre"><span class="k">Before you start</span><p>You need Hevy Pro to get a key.</p></div>

      <ol class="rail">
        <li class="step">
          <span class="plate">1</span>
          <div class="body">
            <h2>Copy your Hevy key</h2>
            <p>On Hevy's website, go to Settings → <b>Developer</b>. Copy the key next to Revoke. It stays there until you revoke it.</p>
            <a class="btn ghost" href="${HEVY_DEVELOPER_URL}" target="_blank" rel="noopener noreferrer">Open Hevy's Developer page ↗</a>
          </div>
        </li>
        <li class="step">
          <span class="plate">2</span>
          <div class="body">
            <h2>Add the connector to Claude</h2>
            <p>In Claude, go to <b>Customize → Connectors → + → Add custom connector</b>. Paste the address below. Claude fills in the sign-in settings; keep the defaults and continue.</p>
            <div class="url"><code id="mcpurl">${origin}/mcp</code><button class="copy" id="copy" type="button">Copy</button></div>
            <p class="fine">Personal Claude plans work, including Free, which allows one custom connector. On Team or Enterprise, an Owner must add it first under Organization settings → Connectors. Set it up on the web or desktop app; then you can use it on your phone.</p>
          </div>
        </li>
        <li class="step">
          <span class="plate">3</span>
          <div class="body">
            <h2>Connect your account</h2>
            <p>Claude opens this server's connection page. Paste your key, choose Read only or Read + write, then select Connect.</p>
          </div>
        </li>
      </ol>

      <section class="strip">
        <p id="any-ai">* Claude on the web, desktop, or Claude Code. Also ChatGPT (full access on Business, Enterprise, and Edu; read-only on Pro) and Cursor: add the same address in that app.</p>
        <p>This server runs on ${operator}'s Cloudflare account. It stores your key in encrypted form and uses it only to reach Hevy for you. ${operator} could technically read the key. To leave, tell Claude "disconnect from Hevy" or revoke the key on Hevy's Developer page. <a href="/privacy">See what's stored and for how long →</a></p>
        ${tip ? html`<p class="tip">Built by ${operator}. <a href="${tip}" target="_blank" rel="noopener noreferrer">Buy him a coffee?</a></p>` : ""}
      </section>
      <script nonce="${nonce}">
        (function () {
          var b = document.getElementById("copy"), u = document.getElementById("mcpurl");
          if (b && u) b.addEventListener("click", function () {
            navigator.clipboard.writeText(u.textContent).then(function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1500); });
          });
          if (/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)) { var m = document.getElementById("mobile"); if (m) m.style.display = "block"; }
        })();
      </script>`,
    "Connect Hevy to Claude",
    "start",
    { origin, description: "Build routines, log workouts, and pull your whole Hevy history into any AI assistant. Bring your own Hevy API key." },
  );
}

app.get("/", (c) => handleStart(c));
app.get("/start", (c) => handleStart(c));

function handleStart(c: Context<{ Bindings: AppEnv; Variables: Vars }>) {
  const origin = new URL(c.req.url).origin;
  const invite = c.req.query("invite");
  let state: "ok" | "bad" | "none" = "none";
  if (invite && c.env.MCP_INVITE_CODE) {
    if (constantTimeEqual(invite, c.env.MCP_INVITE_CODE)) {
      state = "ok";
      c.header("Set-Cookie", cookie(INVITE_COOKIE, invite, 365 * DAY));
    } else {
      state = "bad";
      log("start.bad_invite", {});
    }
  }
  return c.html(startPage(origin, state, operatorName(c.env), tipUrl(c.env), c.get("nonce")));
}

// ---------- /privacy ----------
app.get("/privacy", (c) => {
  const operator = operatorName(c.env);
  const tip = tipUrl(c.env);
  return c.html(
    layout(
      html`<h1>What this<br />server keeps.</h1>
        <p><b>Your Hevy API key.</b> Stored encrypted in Cloudflare. Only your connected app can unlock it, and only while a request is on its way to Hevy. It is never logged and never stored in the clear.</p>
        <p><b>Your name and connection details.</b> Your Hevy display name, one-way fingerprints of your account and key, the date you connected, and the app you used. That is how ${operator} sees who is connected, and how you reconnect later.</p>
        <p><b>Not your workouts.</b> Nothing from your training log is stored here; requests go to Hevy and back. One exception: your exercise list is cached for six hours so the server doesn't ask Hevy for it on every search.</p>
        <h2 style="margin-top:28px">How long</h2>
        <p>One year from the day you connect, however often you use it. Your app refreshes its short-term access every seven days in the background; that doesn't extend the year. After a year the connection and the encrypted key are deleted and your assistant asks for the key again. Disconnecting deletes everything sooner.</p>
        <h2 style="margin-top:28px">Who can read it</h2>
        <p>${operator} runs this server and could technically read your key while it is in use. Nobody else can read the stored copy. It is a personal project with no support promise, and Hevy's developer access is unofficial: Hevy may change or remove it.</p>
        <h2 style="margin-top:28px">Leaving</h2>
        <p><b>Tell your assistant "disconnect from Hevy".</b> Removes that app's connection; other apps you connected keep working. Say "disconnect from Hevy everywhere" to remove every app, delete the stored key, and forget you.</p>
        <p><b>Or revoke the key on <a href="${HEVY_DEVELOPER_URL}" target="_blank" rel="noopener noreferrer">Hevy's Developer page</a>.</b> It stops working everywhere at once; this server drops its copy the next time an app tries to use it.</p>
        <p>Removing the connection inside Claude does not delete the stored key.</p>
        <section class="strip">
          <p><a href="/start">← Back to the start page</a></p>
          ${tip ? html`<p class="tip">Built by ${operator}. <a href="${tip}" target="_blank" rel="noopener noreferrer">Buy him a coffee?</a></p>` : ""}
        </section>`,
      "What this server keeps",
      "privacy",
      { origin: new URL(c.req.url).origin, description: "Your Hevy API key, encrypted per connection, nothing else. What this server stores, for how long, and how to leave." },
    ),
  );
});

// ---------- /authorize — the OAuth consent step ----------
interface ConnectPageOpts {
  origin: string;
  client: ClientLabel;
  req: AuthRequest;
  showInvite: boolean;
  operator: string;
  nonce: string;
  error?: string;
  canWrite?: boolean;
  /** Render-only: the button is disabled and a banner says so. */
  preview?: boolean;
}

function connectPage(o: ConnectPageOpts) {
  const who = describeClient(o.client);
  return layout(
    html`<h1>Connect Hevy<br />to ${o.client}.</h1>
      <p class="lede">You're connecting <b>${who}</b> to your own Hevy account. No one else's account is involved.</p>
      ${o.preview ? html`<div class="banner note preview">Preview only. The real version of this page opens from ${o.client} when you add the connector.</div>` : ""}
      ${o.error ? html`<div class="banner err">${o.error}</div>` : ""}
      <form action="/approve" method="POST" id="f">
        <input type="hidden" name="oauthReqInfo" value="${JSON.stringify(o.req)}" />
        <label for="hevy_key">Hevy API key</label>
        <div class="field">
          <input type="text" id="hevy_key" name="hevy_key" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                 autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" required />
          <button type="button" id="toggle" class="toggle" aria-label="Hide key">Hide</button>
        </div>
        <p class="fine" style="margin-top:8px">On Hevy's website, go to Settings → Developer and copy your key. Hevy Pro is required. <a href="${HEVY_DEVELOPER_URL}" target="_blank" rel="noopener noreferrer">Open Hevy's Developer page ↗</a></p>
        ${o.showInvite
          ? html`<label for="invite">Invite code</label>
              <input type="text" id="invite" name="invite" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
              <p class="fine" style="margin-top:8px">Paste the invite code, or open the invite link in this browser and return here. If you connected before with this same key, leave it blank.</p>`
          : ""}
        <fieldset>
          <legend>Choose access</legend>
          <label class="opt"><input type="radio" name="can_write" value="on" ${o.canWrite === false ? "" : "checked"} /><span>Read + write<small>${o.client} can log workouts and build routines as well as read them. Hevy has no undo. Editing a saved workout replaces what was there.</small></span></label>
          <label class="opt"><input type="radio" name="can_write" value="" ${o.canWrite === false ? "checked" : ""} /><span>Read only<small>${o.client} can view your workouts, routines, and measurements but can't change them.</small></span></label>
        </fieldset>
        <button type="submit" class="btn wide" id="submit" ${o.preview ? "disabled" : ""}>Connect</button>
      </form>
      <section class="strip">
        <p>This server stores your key in encrypted form and uses it only to reach Hevy for you. ${o.operator} runs the server and could technically read the key. To leave, tell ${who} "disconnect from Hevy" or revoke the key on Hevy's Developer page. <a href="/privacy">See what's stored and for how long →</a></p>
      </section>
      <script nonce="${o.nonce}">
        (function () {
          var i = document.getElementById("hevy_key"), t = document.getElementById("toggle"), f = document.getElementById("f"), s = document.getElementById("submit");
          if (t && i) t.addEventListener("click", function () {
            var hiding = i.type === "text"; i.type = hiding ? "password" : "text"; t.textContent = hiding ? "Show" : "Hide"; i.focus();
          });
          if (f && s) f.addEventListener("submit", function () { s.disabled = true; s.textContent = "Checking with Hevy…"; });
        })();
      </script>`,
    `Connect Hevy to ${o.client}`,
    "connect",
    { origin: o.origin, description: "Paste your Hevy API key, choose read-only or read + write, and you're connected." },
  );
}

const expiredPage = () =>
  layout(
    html`<h1>Connection page expired.</h1>
      <p>Return to your assistant and choose Connect again. If this keeps happening, open <a href="/start">the start page</a> and follow the steps again.</p>`,
    "Connection page expired",
    "expired",
  );

const refusalPage = (operator: string) =>
  layout(
    html`<h1>We didn't recognise<br />this app.</h1>
      <p>This server connects only to Claude, ChatGPT, Claude Code, and Cursor, so it did not show the key form. If you are using one of those apps, tell ${operator}.</p>`,
    "App not recognised",
    "refused",
  );

/** A render-only look at the consent page, for design review. */
app.get("/preview/connect", (c) => {
  const origin = new URL(c.req.url).origin;
  const req = { responseType: "code", clientId: "preview", redirectUri: "https://claude.ai/api/mcp/auth_callback", scope: [], state: "preview" } as unknown as AuthRequest;
  return c.html(
    connectPage({ origin, client: "Claude", req, showInvite: false, operator: operatorName(c.env), nonce: c.get("nonce"), preview: true }),
  );
});

app.get("/authorize", async (c) => {
  const origin = new URL(c.req.url).origin;
  let req: AuthRequest;
  try {
    req = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (e) {
    log("authorize.invalid_request", { error: String(e) });
    return c.html(expiredPage(), 400);
  }
  const client = identifyClient(req.redirectUri);
  if (!client) {
    log("authorize.unknown_client", { clientId: req.clientId, redirectUri: req.redirectUri });
    return c.html(refusalPage(operatorName(c.env)), 403);
  }
  const inviteCookie = getCookie(c.req.raw, INVITE_COOKIE);
  const inviteRequired = !!c.env.MCP_INVITE_CODE;
  const haveInvite = !!(inviteRequired && inviteCookie && constantTimeEqual(inviteCookie, c.env.MCP_INVITE_CODE as string));
  return c.html(connectPage({ origin, client, req, showInvite: inviteRequired && !haveInvite, operator: operatorName(c.env), nonce: c.get("nonce") }));
});

// ---------- /approve — validate, then complete the grant ----------
function describeHevyFailure(e: unknown): string {
  if (e instanceof HevyError) {
    if (e.status === 401)
      return "Hevy didn't recognise that key. Copy it again from Hevy → Settings → Developer, and make sure there are no spaces before or after it.";
    if (e.status === 403) return "Hevy says this key is inactive. Your Hevy Pro subscription may have expired. Renew Pro, then try the same key again.";
    if (e.status === 429) return "Hevy is receiving too many requests. Your key is fine. Wait a minute, then select Connect again.";
  }
  return "We couldn't reach Hevy. Your key may still be fine. Wait a minute, then try again.";
}

async function bumpFails(env: AppEnv, key: string): Promise<void> {
  const n = Number((await env.OAUTH_KV.get(key)) ?? 0) + 1;
  await env.OAUTH_KV.put(key, String(n), { expirationTtl: 60 * 60 });
}

function successPage(name: string, redirectTo: string, canWrite: boolean, client: string, operator: string, tip: string | null) {
  return layout(
    html`<meta http-equiv="refresh" content="4;url=${redirectTo}" />
      <div class="stamp">Connected</div>
      <h2>Connected as ${name || "your Hevy account"}</h2>
      <p>${canWrite ? `You can now ask ${client} to read your workouts and add or edit them.` : `${client} can now read your workouts. To let it add or edit them, reconnect and choose Read + write.`}</p>
      <p class="fine">Returning to ${client}… If nothing happens, <a href="${redirectTo}">continue</a>. Wrong Hevy account? <a href="/start">Start over</a>.</p>
      ${tip ? html`<p class="tip">Built by ${operator}. <a href="${tip}" target="_blank" rel="noopener noreferrer">Buy him a coffee?</a></p>` : ""}`,
    "Connected",
    "connected",
  );
}

app.post("/approve", async (c) => {
  const origin = new URL(c.req.url).origin;
  const ip = clientIp(c.req.raw);

  // Brakes first. The rate-limit binding is best-effort (per Cloudflare
  // location); the KV counter is best-effort too (read-modify-write, eventually
  // consistent) — it bounds sustained abuse over an hour, not a burst.
  const failKey = `approve-fail:${ip}`;
  const [rl, fails] = await Promise.all([
    rateLimit(c.env.APPROVE_RL, ip),
    c.env.OAUTH_KV.get(failKey).then((v) => Number(v ?? 0)),
  ]);
  if (!rl.success || fails >= MAX_FAILS_PER_HOUR) {
    log("approve.throttled", { fails, rateLimited: !rl.success });
    return c.html(
      layout(
        html`<h1>Too many tries.</h1>
          <p>Wait one minute, then try again. If it still fails, tell ${operatorName(c.env)}.</p>`,
        "Too many tries",
        "throttled",
      ),
      429,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.html(expiredPage(), 400);
  }
  let req: AuthRequest | null = null;
  try {
    req = JSON.parse(String(body.oauthReqInfo)) as AuthRequest;
  } catch {
    req = null;
  }
  if (!req || typeof req.redirectUri !== "string") return c.html(expiredPage(), 400);

  const client = identifyClient(req.redirectUri);
  if (!client) {
    log("approve.unknown_client", { clientId: req.clientId, redirectUri: req.redirectUri });
    return c.html(refusalPage(operatorName(c.env)), 403);
  }

  const canWrite = body.can_write === "on";
  const key = String(body.hevy_key ?? "").trim();
  // Invite gate, only when this deployment configured one. The cookie is a hint
  // that can only help: a stale one (rotated invite) is treated as absent, never
  // as a wrong answer. Only a typed code can be "wrong".
  const inviteRequired = !!c.env.MCP_INVITE_CODE;
  const inviteCode = c.env.MCP_INVITE_CODE ?? "";
  const typedInvite = String(body.invite ?? "").trim();
  const cookieInvite = getCookie(c.req.raw, INVITE_COOKIE) || "";
  const typedOk = inviteRequired && typedInvite.length > 0 && constantTimeEqual(typedInvite, inviteCode);
  const inviteOk = !inviteRequired || typedOk || (cookieInvite.length > 0 && constantTimeEqual(cookieInvite, inviteCode));
  if (typedOk) c.header("Set-Cookie", cookie(INVITE_COOKIE, typedInvite, 365 * DAY));

  const again = (error: string, status: 400 | 401 | 403 | 503) =>
    c.html(connectPage({ origin, client, req: req as AuthRequest, showInvite: inviteRequired && !inviteOk, operator: operatorName(c.env), nonce: c.get("nonce"), error, canWrite }), status);

  if (!UUID_RE.test(key)) {
    return again(
      "That doesn't look like a Hevy key. Copy the full key from Hevy → Settings → Developer. It should look like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.",
      400,
    );
  }

  if (!inviteOk && typedInvite.length > 0) {
    await bumpFails(c.env, failKey);
    log("approve.bad_invite", { client });
    return again("That invite code isn't right. Open the original invite link in this browser, then try again.", 403);
  }

  // Invite configured but not presented: only a key this server has seen before
  // gets as far as Hevy. Decided from a hash of the key, so a stranger cannot
  // use this page to ask Hevy whether an arbitrary key is valid.
  const memberKey = await memberKeyFor(key);
  if (!inviteOk) {
    const seenBefore = await c.env.OAUTH_KV.get(memberKey);
    if (!seenBefore) {
      await bumpFails(c.env, failKey);
      log("approve.invite_missing", { client });
      return again("This server is invite-only. Open the invite link you were sent in this browser, then return here and connect. If you last connected with a different key, you need the invite link again.", 403);
    }
  }

  // Ask Hevy who owns the key. A 401 means the key is bad, full stop; anything
  // else is Hevy's problem or ours and must not read as "your key is wrong".
  let user;
  try {
    user = await validateHevyKey(key);
  } catch (e) {
    const status = e instanceof HevyError ? e.status : 0;
    if (status === 401) await bumpFails(c.env, failKey);
    log("approve.key_rejected", { client, status });
    const credentialProblem = status === 401 || status === 403;
    return again(describeHevyFailure(e), credentialProblem ? 401 : 503);
  }

  const userId = await deriveUserId(user.id);
  const memberRecordKey = `member:${userId}`;
  const existing = await c.env.OAUTH_KV.get<{ firstConnectedAt?: string }>(memberRecordKey, "json");

  const now = new Date().toISOString();
  const fingerprint = await keyFingerprint(key);
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: req,
    userId,
    metadata: { name: user.name, client, canWrite, connectedAt: now, keyFingerprint: fingerprint },
    scope: req.scope,
    props: { v: PROPS_VERSION, hevyApiKey: key, keyFingerprint: fingerprint, hevyUserId: userId, name: user.name, canWrite, client },
    // The library default revokes this person's earlier grants for the same
    // client id + redirect URI. Claude.ai is ONE client id for every claude.ai
    // account, so with the default a second claude.ai account connecting the
    // same Hevy key silently logged the first one out (Worker logs, 2026-09-02:
    // 401, refresh 400, "Authentication required"). Every connection is its
    // own grant; stale ones expire with their refresh token.
    revokeExistingGrants: false,
  });
  await Promise.all([
    c.env.OAUTH_KV.put(
      memberRecordKey,
      JSON.stringify({ name: user.name, firstConnectedAt: existing?.firstConnectedAt ?? now, lastConnectedAt: now }),
      { expirationTtl: 365 * DAY }, // the privacy page promises a year; each connect restarts it
    ),
    c.env.OAUTH_KV.put(memberKey, userId, { expirationTtl: 365 * DAY }),
  ]);
  log("approve.connected", { userId, client, canWrite, returning: !!existing });
  return c.html(successPage(user.name, redirectTo, canWrite, client, operatorName(c.env), tipUrl(c.env)));
});

// ---------- /admin — owner only ----------
// Login is a POST with the token in the body (never a query string, which
// lands in logs and browser history). The cookie holds an opaque session id
// whose hash lives in KV for a day, scoped to /admin.
async function rateLimit(binding: RateLimit | undefined, key: string): Promise<{ success: boolean }> {
  if (!binding) return { success: true };
  try {
    return await binding.limit({ key });
  } catch {
    return { success: true };
  }
}

async function ownerOk(c: Context<{ Bindings: AppEnv; Variables: Vars }>): Promise<boolean> {
  if (!c.env.OWNER_TOKEN) return false;
  const sid = getCookie(c.req.raw, OWNER_COOKIE);
  if (!sid) return false;
  const stored = await c.env.OAUTH_KV.get(`adminsession:${await sha256Hex(sid)}`);
  return stored === "1";
}

const adminLoginPage = (error?: string) =>
  layout(
    html`<div class="eyebrow">Hevy → Claude · owner</div>
      <h1>Owner sign-in.</h1>
      ${error ? html`<div class="banner err">${error}</div>` : ""}
      <form method="POST" action="/admin/login">
        <label for="token">Owner token</label>
        <input type="password" id="token" name="token" autocomplete="off" required />
        <button type="submit" class="btn wide">Sign in</button>
      </form>`,
    "Owner sign-in",
    "admin-login",
  );

app.get("/admin/login", (c) => (c.env.OWNER_TOKEN ? c.html(adminLoginPage()) : c.notFound()));

app.post("/admin/login", async (c) => {
  if (!c.env.OWNER_TOKEN) return c.notFound();
  const ip = clientIp(c.req.raw);
  const rl = await rateLimit(c.env.ADMIN_RL, ip);
  if (!rl.success) {
    log("admin.throttled", {});
    return c.html(adminLoginPage("Too many attempts. Wait a minute."), 429);
  }
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.html(adminLoginPage("We couldn't read that sign-in. Try again."), 400);
  }
  const token = String(body.token ?? "");
  if (!token || !constantTimeEqual(token, c.env.OWNER_TOKEN)) {
    log("admin.denied", {});
    return c.html(adminLoginPage("That token isn't right."), 401);
  }
  const sid = randomToken();
  await c.env.OAUTH_KV.put(`adminsession:${await sha256Hex(sid)}`, "1", { expirationTtl: DAY });
  c.header("Set-Cookie", cookie(OWNER_COOKIE, sid, DAY, "/admin"));
  log("admin.signed_in", {});
  return c.redirect("/admin");
});

interface GrantRecord {
  id: string;
  clientId: string;
  userId: string;
  createdAt: number;
  metadata?: { name?: string; client?: string; canWrite?: boolean; connectedAt?: string };
}

async function listPrefix<T>(kv: KVNamespace, prefix: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) {
      const v = await kv.get<T>(k.name, "json");
      if (v) out.push(v);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

app.get("/admin", async (c) => {
  if (!c.env.OWNER_TOKEN) return c.notFound();
  if (!(await ownerOk(c))) return c.redirect("/admin/login");

  const grants = await listPrefix<GrantRecord>(c.env.OAUTH_KV, "grant:");
  grants.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const inviteOn = !!c.env.MCP_INVITE_CODE;
  const rows = grants.map(
    (g) => html`<tr>
      <td>${g.metadata?.name ?? "—"}<br /><span class="small">${g.userId}</span></td>
      <td>${g.metadata?.client ?? "—"}<br /><span class="small">${g.clientId.length > 28 ? g.clientId.slice(0, 28) + "…" : g.clientId}</span></td>
      <td>${g.metadata?.canWrite ? "read + write" : "read only"}</td>
      <td>${g.createdAt ? new Date(g.createdAt * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—"}<br /><span class="small">grant …${g.id.slice(-6)}</span></td>
      <td style="white-space:nowrap">
        <form method="POST" action="/admin/revoke" style="margin:0;display:inline">
          <input type="hidden" name="userId" value="${g.userId}" /><input type="hidden" name="grantId" value="${g.id}" />
          <button class="copy" type="submit" style="padding:6px 10px">Disconnect app</button>
        </form>
        <form method="POST" action="/admin/remove" class="remove" style="margin:0;display:inline" data-name="${g.metadata?.name ?? g.userId}">
          <input type="hidden" name="userId" value="${g.userId}" />
          <button class="copy" type="submit" style="padding:6px 10px" title="Disconnect every app and forget this person">Remove person</button>
        </form>
      </td>
    </tr>`,
  );
  return c.html(
    layout(
      html`<div class="eyebrow">Hevy → Claude · owner</div>
        <h1>Connected accounts</h1>
        <p class="fine">Connected apps: ${grants.length}. <b>Disconnect app</b> disconnects that app and deletes the key stored with that connection; the person can reconnect from /start. <b>Remove person</b> disconnects all of their apps and forgets their account${inviteOn ? ", so they will need the invite link to reconnect" : ""}.</p>
        <div style="overflow-x:auto;margin-top:18px">
          <table>
            <thead><tr><th>Who</th><th>App</th><th>Access</th><th>Since</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <script nonce="${c.get("nonce")}">
          document.querySelectorAll("form.remove").forEach(function (f) {
            f.addEventListener("submit", function (e) {
              if (!confirm("Disconnect every app for " + (f.getAttribute("data-name") || "this person") + " and forget them?")) e.preventDefault();
            });
          });
        </script>`,
      "Connected accounts",
      "admin",
    ),
  );
});

app.post("/admin/revoke", async (c) => {
  if (!c.env.OWNER_TOKEN || !(await ownerOk(c))) return c.notFound();
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const userId = String(body.userId ?? "");
  const grantId = String(body.grantId ?? "");
  if (userId && grantId) {
    await c.env.OAUTH_PROVIDER.revokeGrant(grantId, userId);
    log("admin.revoked", { userId, grantId });
  }
  return c.redirect("/admin");
});

/** Forget a person entirely: every grant, the membership record, every key hash pointing at them, the template cache. */
app.post("/admin/remove", async (c) => {
  if (!c.env.OWNER_TOKEN || !(await ownerOk(c))) return c.notFound();
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const userId = String(body.userId ?? "");
  if (userId) {
    const { revoked, keysForgotten } = await forgetPerson(c.env, userId);
    log("admin.removed", { userId, revoked, keysForgotten });
  }
  return c.redirect("/admin");
});

export default app;
