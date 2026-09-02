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
 */

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { type Context, Hono } from "hono";
import { html, raw } from "hono/html";
import { type ClientLabel, describeClient, identifyClient } from "./clients";
import { faviconPngBytes } from "./favicon";
import { HevyError, validateHevyKey } from "./hevy";
import { PROPS_VERSION } from "./mcp";
import { type AppEnv, UUID_RE, clientIp, constantTimeEqual, cookie, deriveUserId, getCookie, log, memberKeyFor, operatorName, randomToken, revokeAllGrants, sha256Hex } from "./util";

type Vars = { nonce: string };
const app = new Hono<{ Bindings: AppEnv; Variables: Vars }>();

const INVITE_COOKIE = "hevy_invite";
const OWNER_COOKIE = "hevy_owner";
const DAY = 24 * 60 * 60;
const MAX_FAILS_PER_HOUR = 20;

// ---------- security headers on every page (nosniff/referrer/HSTS are added for ALL routes in index.ts) ----------
app.use("*", async (c, next) => {
  const nonce = randomToken();
  c.set("nonce", nonce);
  await next();
  c.header(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`,
  );
  if (!c.req.path.startsWith("/favicon")) c.header("Cache-Control", "no-store");
});

// ---------- layout ----------
const layout = (body: unknown, title: string) => html`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${title}</title>
      <link rel="icon" href="/favicon.png" type="image/png" />
      <style>
        :root { color-scheme: dark; }
        body { font-family: system-ui, sans-serif; background: #0f1115; color: #e6e6e6; margin: 0;
               display: flex; min-height: 100vh; align-items: flex-start; justify-content: center; padding: 32px 16px; box-sizing: border-box; }
        .card { background: #181b21; padding: 28px 30px; border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,.4);
                width: 100%; max-width: 460px; line-height: 1.5; }
        h1 { font-size: 1.3rem; margin: 0 0 .5rem; }
        h2 { font-size: 1rem; margin: 1.4rem 0 .4rem; }
        p { margin: 0 0 .9rem; color: #c8d2e0; font-size: .95rem; }
        .muted { color: #9aa0aa; font-size: .85rem; }
        ol, ul { padding-left: 1.2rem; margin: 0 0 .9rem; color: #c8d2e0; font-size: .95rem; }
        li { margin-bottom: .45rem; }
        label { display: block; font-weight: 600; margin: .9rem 0 .35rem; font-size: .92rem; }
        .field { position: relative; }
        input[type=text], input[type=password] { width: 100%; box-sizing: border-box; padding: .65rem 3.6rem .65rem .75rem; border-radius: 8px;
                border: 1px solid #2a2f38; background: #0f1115; color: #e6e6e6; font-size: .95rem; font-family: ui-monospace, monospace; }
        .toggle { position: absolute; right: .4rem; top: 50%; transform: translateY(-50%); background: transparent; border: 0;
                  color: #9aa0aa; font-size: .8rem; font-weight: 500; cursor: pointer; padding: .3rem .45rem; border-radius: 6px; }
        .toggle:hover { color: #e6e6e6; background: #232833; }
        .check { display: flex; gap: .6rem; align-items: flex-start; margin: 1rem 0 .3rem; font-size: .92rem; color: #e6e6e6; }
        .check input { margin-top: .25rem; }
        .btn { display: inline-block; width: 100%; box-sizing: border-box; margin-top: 1rem; padding: .75rem; border: 0; border-radius: 8px;
               background: #4f8cff; color: #fff; font-weight: 600; font-size: .95rem; cursor: pointer; text-align: center; text-decoration: none; }
        .btn:hover { background: #3f7cf0; }
        .btn[disabled] { opacity: .6; cursor: default; }
        .btn.secondary { background: #232833; color: #e6e6e6; }
        .err { background: #3a1d1d; border: 1px solid #6b2b2b; color: #ffb3b3; border-radius: 8px; padding: .7rem .8rem; font-size: .9rem; margin-bottom: .9rem; }
        .ok { background: #163524; border: 1px solid #245c3c; color: #b8f0cf; border-radius: 8px; padding: .7rem .8rem; font-size: .9rem; margin-bottom: .9rem; }
        .note { background: #1f2430; border-radius: 8px; padding: .7rem .8rem; font-size: .88rem; color: #c8d2e0; margin: .6rem 0 .9rem; }
        .url { display: flex; gap: .5rem; align-items: center; }
        .url code { flex: 1; background: #0f1115; border: 1px solid #2a2f38; border-radius: 8px; padding: .6rem .7rem; font-size: .9rem; overflow-x: auto; white-space: nowrap; }
        .copy { background: #232833; border: 0; color: #e6e6e6; border-radius: 8px; padding: .6rem .8rem; cursor: pointer; font-size: .85rem; }
        code { color: #c8d2e0; font-family: ui-monospace, monospace; }
        a { color: #8ab4ff; }
        table { width: 100%; border-collapse: collapse; font-size: .85rem; }
        th, td { text-align: left; padding: .4rem .3rem; border-bottom: 1px solid #2a2f38; vertical-align: top; }
        .small { font-size: .8rem; color: #9aa0aa; }
        #mobile { display: none; }
      </style>
    </head>
    <body>
      <div class="card">${body}</div>
    </body>
  </html>`;

// ---------- static bits ----------
app.get("/favicon.png", (c) =>
  c.body(faviconPngBytes(), 200, { "content-type": "image/png", "cache-control": "public, max-age=86400" }),
);
app.get("/favicon.ico", (c) =>
  c.body(faviconPngBytes(), 200, { "content-type": "image/png", "cache-control": "public, max-age=86400" }),
);

// ---------- /start — the link Kevin sends ----------
function startPage(origin: string, inviteState: "ok" | "bad" | "none", operator: string, nonce: string) {
  return layout(
    html`<h1>Connect Hevy to Claude</h1>
      <p>Ask Claude about your actual training — what you lifted last week, what to do next — and log sessions without typing them twice.</p>
      ${inviteState === "ok" ? html`<div class="ok">Invite saved in this browser. You're good to connect.</div>` : ""}
      ${inviteState === "bad" ? html`<div class="err">That invite link isn't right. Check the message you were sent and open the link exactly as it was sent.</div>` : ""}
      <div id="mobile" class="note">You'll need a computer for these steps — Hevy's key page and Claude's connector settings are both desktop-only. Email yourself this link.</div>

      <h2>Two things you need, both on a computer</h2>
      <ol>
        <li><b>Hevy Pro.</b> The data connection is a Pro feature (about $3/month or $75 once). Free Hevy accounts can't switch it on.</li>
        <li><b>A Hevy API key.</b> A long code you copy from Hevy's website — not the phone app.</li>
      </ol>
      <a class="btn" href="https://hevy.com/settings?developer" target="_blank" rel="noopener noreferrer">Get my Hevy key ↗</a>
      <p class="muted" style="margin-top:.6rem">Log in, open <b>Developer</b>, create a key. <b>Copy it into your notes or password manager first</b> — Hevy only shows it once. No Developer section? That account isn't on Pro.</p>

      <h2>Then, in Claude</h2>
      <p>Settings → Connectors → Add custom connector, and paste this:</p>
      <div class="url"><code id="mcpurl">${origin}/mcp</code><button class="copy" id="copy" type="button">Copy</button></div>
      <p class="muted" style="margin-top:.6rem">Leave Client ID and Secret blank. Use your <b>personal</b> Claude account — work and school accounts usually block custom connectors. Any personal plan works, including Free (Free allows one custom connector). Add it on the web or desktop app; once added it shows up on your phone too.</p>
      <p>A page opens asking for your key. Paste it, choose whether Claude may add and edit workouts, and you're connected.</p>

      <h2>What happens to your key</h2>
      <p class="muted">This runs on a server operated by ${operator}, on Cloudflare. Your key is stored encrypted and used only to talk to Hevy for you. ${operator} could technically read it. To cut it off instantly, rotate the key at Hevy — or ask Claude to "disconnect from Hevy". <a href="/privacy">What's stored and for how long →</a></p>
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
      html`<h1>What this server stores</h1>
        <p><b>Your Hevy API key.</b> Encrypted inside the OAuth grant your client holds, in Cloudflare KV. The encryption key is derived from your client's token, so the stored copy is unreadable without it. The key is decrypted only for the moment a request from your client is served; it is never written anywhere else and never logged (logs redact anything shaped like a key).</p>
        <p><b>Your Hevy display name, a hash of your Hevy user id, and a hash of your key</b>, so the operator can see who is connected and so you can reconnect later without a fresh invite, plus the date you connected and which app connected (Claude, ChatGPT, Claude Code, Cursor).</p>
        <p><b>Nothing from your workouts.</b> Requests go straight to Hevy and back; no workout, routine or measurement data is kept here. A copy of your exercise list — Hevy's built-ins plus any custom exercises you've made — is cached unencrypted for six hours per person to spare Hevy repeated lookups.</p>
        <h2>How long</h2>
        <p>Access tokens last 7 days and are refreshed silently by your client. The connection itself lasts a year from the day you connect, however often you use it; after that Claude asks you to paste your Hevy key again, and the stored key is gone with the expired connection. Save your key somewhere you can find it. The record that your account has connected before (name, hashed id, a hash of the key you used, dates) is kept for a year so you can reconnect without a fresh invite, or until you disconnect.</p>
        <h2>Who can read it</h2>
        <p>${operator} operates this server on a personal Cloudflare account and could technically read a key while a request is in flight. Nobody else can. There is no support promise; the Hevy API itself is unofficial and Hevy says it may change or withdraw it.</p>
        <h2>Leaving</h2>
        <ul>
          <li>Ask Claude to <b>"disconnect from Hevy"</b> — this revokes every connection, deletes the stored key, and forgets the key you connected with.</li>
          <li>Rotate your key at <a href="https://hevy.com/settings?developer" target="_blank" rel="noopener noreferrer">hevy.com/settings?developer</a> — that instantly makes the stored copy useless to this server and anything else holding the old key; it is cleared the next time anything tries to use it.</li>
          <li>Removing the connector in Claude alone does not delete the stored key; use one of the two steps above.</li>
        </ul>
        <p class="muted"><a href="/start">← Back</a></p>`,
      "Hevy MCP — what's stored",
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
  return layout(
    html`<h1>Connect your Hevy account</h1>
      <p><b>${describeClient(o.client)}</b> is asking to use your Hevy data. It's your key and your data — nobody else's is involved.</p>
      ${o.error ? html`<div class="err">${o.error}</div>` : ""}
      <form action="/approve" method="POST" id="f">
        <input type="hidden" name="oauthReqInfo" value="${JSON.stringify(o.req)}" />
        <label for="hevy_key">Your Hevy API key</label>
        <div class="field">
          <input type="text" id="hevy_key" name="hevy_key" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                 autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" required />
          <button type="button" id="toggle" class="toggle" aria-label="Hide key">Hide</button>
        </div>
        <p class="muted" style="margin-top:.4rem">A long code with dashes from Hevy → Settings → Developer (needs Hevy Pro). <a href="https://hevy.com/settings?developer" target="_blank" rel="noopener noreferrer">Open Hevy settings ↗</a> Save a copy before you paste — Hevy only shows it once.</p>
        ${o.showInvite
          ? html`<label for="invite">Invite code</label>
              <input type="text" id="invite" name="invite" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
              <p class="muted" style="margin-top:.4rem">From the invite link you were sent. Opening that link in this browser fills this in for you. Connected before with this key? Leave it blank.</p>`
          : ""}
        <label class="check"><input type="checkbox" name="can_write" ${o.canWrite ? "checked" : ""} />
          <span>Let Claude add and edit workouts, routines and measurements.<br /><span class="muted">Leave off for read-only — Claude can look, not touch. Heads up: Hevy has no undo. Edits Claude makes to a saved workout replace what was there.</span></span></label>
        <button type="submit" class="btn" id="submit">Connect</button>
      </form>
      <p class="muted" style="margin-top:1rem">Your key is stored encrypted on a server run by ${o.operator} and used only to call Hevy on your behalf. ${o.operator} could technically read it. Leave any time by asking Claude to "disconnect from Hevy" or rotating the key at Hevy. <a href="/privacy">Details →</a></p>
      <script nonce="${o.nonce}">
        (function () {
          var i = document.getElementById("hevy_key"), t = document.getElementById("toggle"), f = document.getElementById("f"), s = document.getElementById("submit");
          if (t && i) t.addEventListener("click", function () {
            var hiding = i.type === "text"; i.type = hiding ? "password" : "text"; t.textContent = hiding ? "Show" : "Hide"; i.focus();
          });
          if (f && s) f.addEventListener("submit", function () { s.disabled = true; s.textContent = "Checking with Hevy…"; });
        })();
      </script>`,
    "Connect your Hevy account",
  );
}

const expiredPage = () =>
  layout(
    html`<h1>This page expired</h1>
      <p>Head back to Claude and start Connect again. If it keeps happening, open <a href="/start">the start page</a> first.</p>`,
    "Hevy MCP",
  );

const refusalPage = (operator: string) =>
  layout(
    html`<h1>This connector doesn't recognise that app</h1>
      <p>The app asking for access isn't one this server recognises, so it won't show the key form. It works with Claude, ChatGPT, Claude Code and Cursor. If you're using one of those and see this, tell ${operator}.</p>`,
    "Hevy MCP",
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
      return "Hevy didn't recognise that key. Check you copied the whole thing with no spaces on the ends — or create a fresh one in Hevy → Settings → Developer.";
    if (e.status === 403)
      return "Hevy says this key isn't active. That usually means the Hevy Pro subscription behind it has lapsed. Renew Pro and try again — the same key should start working.";
    if (e.status === 429) return "Hevy is asking us to slow down. Nothing's wrong with your key — wait a minute and hit Connect again.";
  }
  return "Couldn't reach Hevy just now. That's on Hevy's side, not your key — don't regenerate it. Try again in a minute.";
}

async function bumpFails(env: AppEnv, key: string): Promise<void> {
  const n = Number((await env.OAUTH_KV.get(key)) ?? 0) + 1;
  await env.OAUTH_KV.put(key, String(n), { expirationTtl: 60 * 60 });
}

function successPage(name: string, redirectTo: string, canWrite: boolean) {
  return layout(
    html`<meta http-equiv="refresh" content="2;url=${redirectTo}" />
      <h1>Connected as ${name || "your Hevy account"}</h1>
      <p>${canWrite ? "Claude can read your workouts and add or edit them." : "Claude can read your workouts. Reconnect with the box ticked if you want it to add or edit later."}</p>
      <p>Sending you back… <a href="${redirectTo}">continue</a> if nothing happens.</p>
      <p class="muted">Not you? <a href="/start">Start over</a>.</p>`,
    "Connected",
  );
}

app.post("/approve", async (c) => {
  const origin = new URL(c.req.url).origin;
  const ip = clientIp(c.req.raw);

  // Brakes first. The rate-limit binding is best-effort (per Cloudflare
  // location); the KV counter backs it up across locations.
  // The KV counter is best-effort (read-modify-write, eventually consistent);
  // it bounds sustained abuse over an hour, not a burst — the binding does that.
  const failKey = `approve-fail:${ip}`;
  const [rl, fails] = await Promise.all([
    rateLimit(c.env.APPROVE_RL, ip),
    c.env.OAUTH_KV.get(failKey).then((v) => Number(v ?? 0)),
  ]);
  if (!rl.success || fails >= MAX_FAILS_PER_HOUR) {
    log("approve.throttled", { fails, rateLimited: !rl.success });
    return c.html(
      layout(
        html`<h1>Too many tries from your network</h1>
          <p>Give it a minute, then try again. If you've pasted the key a few times and it keeps failing, tell ${operatorName(c.env)} — something's wrong on our end.</p>`,
        "Hevy MCP",
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
      layout(html`<h1>Not accepting connections right now</h1><p>The server isn't fully configured. Tell ${operatorName(c.env)}.</p>`, "Hevy MCP"),
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

  const again = (error: string, status: 400 | 401 | 403) =>
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

  // Ask Hevy who owns the key. A 401 means the key is bad, full stop.
  let user;
  try {
    user = await validateHevyKey(key);
  } catch (e) {
    const status = e instanceof HevyError ? e.status : 0;
    if (status === 401) await bumpFails(c.env, failKey);
    log("approve.key_rejected", { client, status });
    return again(describeHevyFailure(e), 401);
  }

  const userId = await deriveUserId(user.id);
  const memberRecordKey = `member:${userId}`;
  const existing = await c.env.OAUTH_KV.get<{ firstConnectedAt?: string }>(memberRecordKey, "json");

  const now = new Date().toISOString();
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: req,
    userId,
    metadata: { name: user.name, client, canWrite, connectedAt: now },
    scope: req.scope,
    props: { v: PROPS_VERSION, hevyApiKey: key, hevyUserId: userId, name: user.name, canWrite, client },
  });
  await Promise.all([
    c.env.OAUTH_KV.put(
      memberRecordKey,
      JSON.stringify({ name: user.name, firstConnectedAt: existing?.firstConnectedAt ?? now, lastConnectedAt: now }),
    ),
    c.env.OAUTH_KV.put(memberKey, userId, { expirationTtl: 365 * DAY }),
  ]);
  log("approve.connected", { userId, client, canWrite, returning: !!existing });
  return c.html(successPage(user.name, redirectTo, canWrite));
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
    html`<h1>Owner sign-in</h1>
      ${error ? html`<div class="err">${error}</div>` : ""}
      <form method="POST" action="/admin/login">
        <label for="token">Owner token</label>
        <input type="password" id="token" name="token" autocomplete="off" required />
        <button type="submit" class="btn">Sign in</button>
      </form>`,
    "Hevy MCP — admin",
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
          <button class="copy" type="submit">Revoke</button>
        </form>
        <form method="POST" action="/admin/remove" style="margin:0;display:inline">
          <input type="hidden" name="userId" value="${g.userId}" />
          <button class="copy" type="submit" title="Revoke every grant for this person and forget them">Remove person</button>
        </form>
      </td>
    </tr>`,
  );
  return c.html(
    layout(
      html`<h1>Connected accounts</h1>
        <p class="muted">${grants.length} grant(s). <b>Revoke</b> kills one client's tokens and the encrypted key inside them; the person can reconnect from /start without an invite. <b>Remove person</b> revokes every grant they hold and forgets them, so reconnecting needs the invite link again.</p>
        <div style="overflow-x:auto">
          <table>
            <thead><tr><th>Who</th><th>Client</th><th>Access</th><th>Since</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`,
      "Hevy MCP — admin",
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

// `raw` is imported for future use in templates that need pre-escaped HTML.
void raw;
