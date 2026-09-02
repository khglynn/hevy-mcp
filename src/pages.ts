/**
 * Every page a person sees: /start (the link the operator sends), /authorize and
 * /approve (the OAuth consent step where they paste their own Hevy key),
 * /privacy, and /admin (owner only). workers-oauth-provider owns the actual
 * OAuth endpoints (/token, /register); this app only renders the login step
 * and completes the grant.
 *
 * Order of checks on /approve is deliberate: throttle → known client → invite
 * configured → key shape → invite (or a key this server has seen before) →
 * Hevy → membership. Hevy is only asked about a key when the caller holds the
 * invite or presents a key that connected before, and failures are counted,
 * so the page cannot be used as a free "is this Hevy key valid?" oracle.
 *
 * Look: "iron and chalk". Near-black ground, gunmetal surfaces, chalk-white
 * type, one safety-orange accent; Barlow Condensed for display (gym signage),
 * Barlow for body. The signature on /start is the barbell rail: three numbered
 * plates for the three real steps.
 */

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { type Context, Hono } from "hono";
import { html } from "hono/html";
import { type ClientLabel, describeClient, identifyClient } from "./clients";
import { faviconPngBytes } from "./favicon";
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
  revokeAllGrants,
  sha256Hex,
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
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`,
  );
  if (!c.req.path.startsWith("/favicon")) c.header("Cache-Control", "no-store");
});

// ---------- layout ----------
const layout = (body: unknown, title: string, page: string) => html`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${title}</title>
      <link rel="icon" href="/favicon.png" type="image/png" />
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

        /* the barbell rail: three plates for three real steps */
        .rail { list-style: none; margin: 40px 0 0; padding: 0; position: relative; }
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
        .strip p { color: var(--ash); font-size: 15px; }
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

// ---------- /start — the link the operator sends ----------
function startPage(origin: string, inviteState: "ok" | "bad" | "none", operator: string, nonce: string) {
  return layout(
    html`<div class="eyebrow">Hevy → Claude · invite only</div>
      <h1>Your lifting log,<br />in Claude's hands.</h1>
      <p class="lede">Ask what you benched last week. Have it build the next block. Log a session without typing it twice.</p>
      ${inviteState === "ok" ? html`<div class="banner ok">Invite saved in this browser. You're good to connect.</div>` : ""}
      ${inviteState === "bad" ? html`<div class="banner err">That invite link isn't right. Open the link exactly as it was sent to you.</div>` : ""}
      <div id="mobile" class="banner note">You'll need a computer for this: Hevy's key page and Claude's connector settings are both desktop-only. Send yourself this link.</div>

      <ol class="rail">
        <li class="step">
          <span class="plate">1</span>
          <div class="body">
            <h2>Hevy Pro</h2>
            <p>The API is a Pro feature. Free Hevy accounts can't switch it on.</p>
          </div>
        </li>
        <li class="step">
          <span class="plate">2</span>
          <div class="body">
            <h2>Copy your API key</h2>
            <p>Hevy → Settings → <b>Developer</b>. The key sits on that page whenever you need it, next to a button that revokes it.</p>
            <a class="btn ghost" href="${HEVY_DEVELOPER_URL}" target="_blank" rel="noopener noreferrer">Open Hevy's Developer page ↗</a>
          </div>
        </li>
        <li class="step">
          <span class="plate">3</span>
          <div class="body">
            <h2>Add the connector in Claude</h2>
            <p><b>Customize → Connectors → + → Add custom connector.</b> Paste this address. Claude detects the sign-in settings by itself; keep the defaults and continue.</p>
            <div class="url"><code id="mcpurl">${origin}/mcp</code><button class="copy" id="copy" type="button">Copy</button></div>
            <p class="fine">Any personal plan, including Free (one custom connector). On a Team or Enterprise account an Owner adds it under Organization settings → Connectors first. Add it on the web or desktop app; your phone picks it up after.</p>
          </div>
        </li>
      </ol>

      <p style="margin-top:34px">Claude then opens a page from this server. Paste your key, pick read-only or read + write, and you're connected.</p>

      <section class="strip">
        <p>Runs on ${operator}'s own Cloudflare. Your key is stored encrypted and used only to reach Hevy for you; ${operator} could technically read it. Leave any time — tell Claude "disconnect from Hevy", or revoke the key on Hevy's Developer page. <a href="/privacy">What's kept, and for how long →</a></p>
        <p>Using ChatGPT, Claude Code or Cursor? Same address, added the way that app adds MCP servers.</p>
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
    "Hevy → Claude",
    "start",
  );
}

app.get("/", (c) => handleStart(c));
app.get("/start", (c) => handleStart(c));

function handleStart(c: Context<{ Bindings: AppEnv; Variables: Vars }>) {
  const origin = new URL(c.req.url).origin;
  const invite = c.req.query("invite");
  let state: "ok" | "bad" | "none" = "none";
  if (invite) {
    if (c.env.MCP_INVITE_CODE && constantTimeEqual(invite, c.env.MCP_INVITE_CODE)) {
      state = "ok";
      c.header("Set-Cookie", cookie(INVITE_COOKIE, invite, 365 * DAY));
    } else {
      state = "bad";
      log("start.bad_invite", {});
    }
  }
  return c.html(startPage(origin, state, operatorName(c.env), c.get("nonce")));
}

// ---------- /privacy ----------
app.get("/privacy", (c) => {
  const operator = operatorName(c.env);
  return c.html(
    layout(
      html`<div class="eyebrow">Hevy → Claude · what's kept</div>
        <h1>What this server stores.</h1>
        <p><b>Your Hevy API key.</b> Encrypted inside the OAuth grant your client holds, in Cloudflare KV. The encryption key is derived from your client's token, so the stored copy is unreadable without it. The key is decrypted only for the moment a request from your client is served; it is never written anywhere else and never logged (logs redact anything shaped like a key).</p>
        <p><b>Your Hevy display name, a hash of your Hevy user id, and a hash of your key</b>, so the operator can see who is connected and so you can reconnect later without a fresh invite, plus the date you connected and which app connected (Claude, ChatGPT, Claude Code, Cursor).</p>
        <p><b>Nothing from your workouts.</b> Requests go straight to Hevy and back; no workout, routine or measurement data is kept here. A copy of your exercise list — Hevy's built-ins plus any custom exercises you've made — is cached unencrypted for six hours per person to spare Hevy repeated lookups.</p>
        <h2 style="margin-top:28px">How long</h2>
        <p>Access tokens last 7 days and are refreshed silently by your client. The connection itself lasts a year from the day you connect, however often you use it; after that your assistant asks you to paste your Hevy key again, and the stored key is gone with the expired connection. The record that your account has connected before (name, hashed id, a hash of the key you used, dates) is kept for a year so you can reconnect without a fresh invite, or until you disconnect.</p>
        <h2 style="margin-top:28px">Who can read it</h2>
        <p>${operator} operates this server on a personal Cloudflare account and could technically read a key while a request is in flight. Nobody else can. There is no support promise; the Hevy API itself is unofficial and Hevy says it may change or withdraw it.</p>
        <h2 style="margin-top:28px">Leaving</h2>
        <p><b>Tell your assistant "disconnect from Hevy".</b> That revokes every connection, deletes the stored key, and forgets the key you connected with.</p>
        <p><b>Or revoke the key on <a href="${HEVY_DEVELOPER_URL}" target="_blank" rel="noopener noreferrer">Hevy's Developer page</a>.</b> The stored copy is useless from that moment, to this server and to anything else holding it; it is cleared the next time anything tries to use it.</p>
        <p>Removing the connector in Claude alone does not delete the stored key; use one of the two steps above.</p>
        <p class="fine" style="margin-top:28px"><a href="/start">← Back to the start page</a></p>`,
      "Hevy → Claude · what's kept",
      "privacy",
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
}

function connectPage(o: ConnectPageOpts) {
  const who = describeClient(o.client);
  return layout(
    html`<div class="eyebrow">Hevy → ${o.client}</div>
      <h1>${o.client} wants<br />your Hevy log.</h1>
      <p class="lede"><b>${who}</b> is asking to use your Hevy account. Your key, your data — nobody else's is involved.</p>
      ${o.error ? html`<div class="banner err">${o.error}</div>` : ""}
      <form action="/approve" method="POST" id="f">
        <input type="hidden" name="oauthReqInfo" value="${JSON.stringify(o.req)}" />
        <label for="hevy_key">Hevy API key</label>
        <div class="field">
          <input type="text" id="hevy_key" name="hevy_key" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                 autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" required />
          <button type="button" id="toggle" class="toggle" aria-label="Hide key">Hide</button>
        </div>
        <p class="fine" style="margin-top:8px">Copy it from Hevy → Settings → Developer (needs Hevy Pro). <a href="${HEVY_DEVELOPER_URL}" target="_blank" rel="noopener noreferrer">Open Hevy's Developer page ↗</a></p>
        ${o.showInvite
          ? html`<label for="invite">Invite code</label>
              <input type="text" id="invite" name="invite" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
              <p class="fine" style="margin-top:8px">From the invite link you were sent; opening that link in this browser fills it in for you. Connected before with this same key? Leave it blank.</p>`
          : ""}
        <fieldset>
          <legend>Access</legend>
          <label class="opt"><input type="radio" name="can_write" value="" ${o.canWrite ? "" : "checked"} /><span>Read only<small>${o.client} can look at your workouts, routines and measurements. Not touch.</small></span></label>
          <label class="opt"><input type="radio" name="can_write" value="on" ${o.canWrite ? "checked" : ""} /><span>Read + write<small>${o.client} can also log workouts and build routines. Hevy has no undo: an edit to a saved workout replaces what was there.</small></span></label>
        </fieldset>
        <button type="submit" class="btn wide" id="submit">Connect</button>
      </form>
      <section class="strip">
        <p>Stored encrypted on a server run by ${o.operator}, used only to reach Hevy for you; ${o.operator} could technically read it. Leave any time — tell ${who} "disconnect from Hevy", or revoke the key on Hevy's Developer page. <a href="/privacy">Details →</a></p>
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
  );
}

const expiredPage = () =>
  layout(
    html`<div class="eyebrow">Hevy → Claude</div>
      <h1>This page expired.</h1>
      <p>Go back to your assistant and start Connect again. If it keeps happening, open <a href="/start">the start page</a> first.</p>`,
    "Hevy → Claude",
    "expired",
  );

const refusalPage = (operator: string) =>
  layout(
    html`<div class="eyebrow">Hevy → ?</div>
      <h1>Don't know that app.</h1>
      <p>The app asking for access isn't one this server recognises, so it won't show the key form. It works with Claude, ChatGPT, Claude Code and Cursor. If you're using one of those and see this, tell ${operator}.</p>`,
    "Hevy → Claude",
    "refused",
  );

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
  const haveInvite = !!(c.env.MCP_INVITE_CODE && inviteCookie && constantTimeEqual(inviteCookie, c.env.MCP_INVITE_CODE));
  return c.html(connectPage({ origin, client, req, showInvite: !haveInvite, operator: operatorName(c.env), nonce: c.get("nonce") }));
});

// ---------- /approve — validate, then complete the grant ----------
function describeHevyFailure(e: unknown): string {
  if (e instanceof HevyError) {
    if (e.status === 401)
      return "Hevy didn't recognise that key. Check you copied the whole thing with no spaces on the ends, or open Hevy's Developer page and copy it again.";
    if (e.status === 403)
      return "Hevy says this key isn't active. That usually means the Hevy Pro subscription behind it has lapsed. Renew Pro and try again — the same key should start working.";
    if (e.status === 429) return "Hevy is asking us to slow down. Nothing's wrong with your key — wait a minute and hit Connect again.";
  }
  return "Couldn't reach Hevy just now. That's on Hevy's side, not your key — nothing to change. Try again in a minute.";
}

async function bumpFails(env: AppEnv, key: string): Promise<void> {
  const n = Number((await env.OAUTH_KV.get(key)) ?? 0) + 1;
  await env.OAUTH_KV.put(key, String(n), { expirationTtl: 60 * 60 });
}

function successPage(name: string, redirectTo: string, canWrite: boolean, client: string) {
  return layout(
    html`<meta http-equiv="refresh" content="2;url=${redirectTo}" />
      <div class="eyebrow">Hevy → ${client}</div>
      <div class="stamp">Connected</div>
      <h2>Connected as ${name || "your Hevy account"}</h2>
      <p>${canWrite ? `${client} can read your workouts and add or edit them.` : `${client} can read your workouts. Reconnect with "Read + write" if you want it to add or edit later.`}</p>
      <p class="fine">Sending you back… <a href="${redirectTo}">continue</a> if nothing happens. Not you? <a href="/start">Start over</a>.</p>`,
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
        html`<div class="eyebrow">Hevy → Claude</div>
          <h1>Too many tries.</h1>
          <p>Give it a minute, then try again. If you've pasted the key a few times and it keeps failing, tell ${operatorName(c.env)} — something's wrong on our end.</p>`,
        "Hevy → Claude",
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

  // Fail CLOSED: with no invite configured, nobody connects.
  if (!c.env.MCP_INVITE_CODE) {
    log("approve.no_invite_configured", {});
    return c.html(
      layout(
        html`<div class="eyebrow">Hevy → Claude</div><h1>Not taking connections right now.</h1><p>The server isn't fully configured. Tell ${operatorName(c.env)}.</p>`,
        "Hevy → Claude",
        "unconfigured",
      ),
      503,
    );
  }

  const canWrite = body.can_write === "on";
  const key = String(body.hevy_key ?? "").trim();
  // The cookie is a hint that can only help: a stale one (rotated invite) is
  // treated as absent, never as a wrong answer. Only a typed code can be "wrong".
  const typedInvite = String(body.invite ?? "").trim();
  const cookieInvite = getCookie(c.req.raw, INVITE_COOKIE) || "";
  const typedOk = typedInvite.length > 0 && constantTimeEqual(typedInvite, c.env.MCP_INVITE_CODE);
  const inviteOk = typedOk || (cookieInvite.length > 0 && constantTimeEqual(cookieInvite, c.env.MCP_INVITE_CODE));
  if (typedOk) c.header("Set-Cookie", cookie(INVITE_COOKIE, typedInvite, 365 * DAY));

  const again = (error: string, status: 400 | 401 | 403 | 503) =>
    c.html(connectPage({ origin, client, req: req as AuthRequest, showInvite: !inviteOk, operator: operatorName(c.env), nonce: c.get("nonce"), error, canWrite }), status);

  if (!UUID_RE.test(key)) {
    return again(
      "That doesn't look like a Hevy key. It's a long code with dashes, like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx — copy it from Hevy → Settings → Developer.",
      400,
    );
  }

  if (!inviteOk && typedInvite.length > 0) {
    await bumpFails(c.env, failKey);
    log("approve.bad_invite", { client });
    return again("That invite code isn't right. Check the message you were sent, or open the link in it.", 403);
  }

  // No invite: only a key this server has seen before gets as far as Hevy.
  // Decided from a hash of the key, so a stranger cannot use this page to ask
  // Hevy whether an arbitrary key is valid.
  const memberKey = await memberKeyFor(key);
  if (!inviteOk) {
    const seenBefore = await c.env.OAUTH_KV.get(memberKey);
    if (!seenBefore) {
      await bumpFails(c.env, failKey);
      log("approve.invite_missing", { client });
      return again("This server is invite-only. Open the invite link you were sent first (it remembers the invite in this browser), then come back and connect. If you connected before with a different key, you need the link again.", 403);
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
  return c.html(successPage(user.name, redirectTo, canWrite, client));
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

const adminLoginPage = (nonce: string, error?: string) =>
  layout(
    html`<div class="eyebrow">Hevy → Claude · owner</div>
      <h1>Owner sign-in.</h1>
      ${error ? html`<div class="banner err">${error}</div>` : ""}
      <form method="POST" action="/admin/login">
        <label for="token">Owner token</label>
        <input type="password" id="token" name="token" autocomplete="off" required />
        <button type="submit" class="btn wide">Sign in</button>
      </form>`,
    "Hevy → Claude · owner",
    "admin-login",
  );

app.get("/admin/login", (c) => (c.env.OWNER_TOKEN ? c.html(adminLoginPage(c.get("nonce"))) : c.notFound()));

app.post("/admin/login", async (c) => {
  if (!c.env.OWNER_TOKEN) return c.notFound();
  const ip = clientIp(c.req.raw);
  const rl = await rateLimit(c.env.ADMIN_RL, ip);
  if (!rl.success) {
    log("admin.throttled", {});
    return c.html(adminLoginPage(c.get("nonce"), "Too many attempts. Wait a minute."), 429);
  }
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.html(adminLoginPage(c.get("nonce"), "That didn't come through. Try again."), 400);
  }
  const token = String(body.token ?? "");
  if (!token || !constantTimeEqual(token, c.env.OWNER_TOKEN)) {
    log("admin.denied", {});
    return c.html(adminLoginPage(c.get("nonce"), "That token isn't right."), 401);
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
  const rows = grants.map(
    (g) => html`<tr>
      <td>${g.metadata?.name ?? "—"}<br /><span class="small">${g.userId}</span></td>
      <td>${g.metadata?.client ?? "—"}<br /><span class="small">${g.clientId.length > 28 ? g.clientId.slice(0, 28) + "…" : g.clientId}</span></td>
      <td>${g.metadata?.canWrite ? "read + write" : "read"}</td>
      <td>${g.createdAt ? new Date(g.createdAt * 1000).toISOString().slice(0, 10) : "—"}</td>
      <td style="white-space:nowrap">
        <form method="POST" action="/admin/revoke" style="margin:0;display:inline">
          <input type="hidden" name="userId" value="${g.userId}" /><input type="hidden" name="grantId" value="${g.id}" />
          <button class="copy" type="submit" style="padding:6px 10px">Revoke</button>
        </form>
        <form method="POST" action="/admin/remove" style="margin:0;display:inline">
          <input type="hidden" name="userId" value="${g.userId}" />
          <button class="copy" type="submit" style="padding:6px 10px" title="Revoke every grant for this person and forget them">Remove person</button>
        </form>
      </td>
    </tr>`,
  );
  return c.html(
    layout(
      html`<div class="eyebrow">Hevy → Claude · owner</div>
        <h1>Connected accounts.</h1>
        <p class="fine">${grants.length} grant(s). <b>Revoke</b> kills one client's tokens and the encrypted key inside them; the person can reconnect from /start without an invite. <b>Remove person</b> revokes every grant they hold and forgets them, so reconnecting needs the invite link again.</p>
        <div style="overflow-x:auto;margin-top:18px">
          <table>
            <thead><tr><th>Who</th><th>Client</th><th>Access</th><th>Since</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`,
      "Hevy → Claude · owner",
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
    const revoked = await revokeAllGrants(c.env, userId);
    const deletions: Promise<void>[] = [c.env.OAUTH_KV.delete(`member:${userId}`), c.env.OAUTH_KV.delete(`tplcache:${userId}`)];
    let cursor: string | undefined;
    do {
      const page = await c.env.OAUTH_KV.list({ prefix: "memberkey:", cursor });
      for (const k of page.keys) {
        if ((await c.env.OAUTH_KV.get(k.name)) === userId) deletions.push(c.env.OAUTH_KV.delete(k.name));
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    await Promise.all(deletions);
    log("admin.removed", { userId, revoked });
  }
  return c.redirect("/admin");
});

export default app;
