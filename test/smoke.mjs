#!/usr/bin/env node
/**
 * End-to-end smoke test against a running server (wrangler dev by default).
 *
 *   BASE=http://localhost:8787 INVITE=<MCP_INVITE_CODE> node test/smoke.mjs
 *   HEVY_API_KEY=<real key>  → also runs the full OAuth + MCP round trip
 *
 * Covers the paths that actually break: discovery metadata, unauthenticated
 * /mcp → 401, client allowlist at /register and /authorize, invite gate,
 * key-shape check, Hevy rejection copy, and (with a real key) code exchange,
 * initialize, tools/list per write setting, and one tool call.
 */

import { createHash, randomBytes } from "node:crypto";

const BASE = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
const INVITE = process.env.INVITE ?? "";
const HEVY_API_KEY = process.env.HEVY_API_KEY ?? "";

let failures = 0;
let passes = 0;
/**
 * Production KV serves a cached copy of a key for up to ~60s after it was
 * written or deleted, so a check that depends on a fresh write or a revocation
 * can lag there. Poll until `until` holds (at most 90s in production; one
 * attempt locally, where Miniflare's KV is immediately consistent). Only the
 * named stale state (`stale`) is retried; any other answer, a 500 say, is
 * returned at once so the cache wait cannot hide an unrelated failure.
 */
async function settles(attempt, until, stale) {
  const maxMs = /localhost|127\.0\.0\.1/.test(BASE) ? 0 : 90_000;
  const started = Date.now();
  let last = await attempt();
  while (!until(last) && stale(last) && Date.now() - started < maxMs) {
    await new Promise((r) => setTimeout(r, 3000));
    last = await attempt();
  }
  const waited = Date.now() - started;
  return { result: last, note: waited > 3000 ? ` (settled after ${Math.round(waited / 1000)}s: KV cache)` : "" };
}

function check(name, cond, detail = "") {
  if (cond) {
    passes++;
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const form = (obj) => new URLSearchParams(obj).toString();
const unescape = (h) => h.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const textOf = async (r) => unescape(await r.text());

async function main() {
  console.log(`smoke → ${BASE}`);

  // --- discovery ---
  const as = await fetch(`${BASE}/.well-known/oauth-authorization-server`).then((r) => r.json());
  check("AS metadata: S256 only", JSON.stringify(as.code_challenge_methods_supported) === '["S256"]', JSON.stringify(as.code_challenge_methods_supported));
  check("AS metadata: registration endpoint", typeof as.registration_endpoint === "string");
  check("AS metadata: CIMD advertised", as.client_id_metadata_document_supported === true);
  check("AS metadata: offline_access advertised (ChatGPT keys refresh on it)", Array.isArray(as.scopes_supported) && as.scopes_supported.includes("offline_access"), JSON.stringify(as.scopes_supported));
  check("AS metadata: logo_uri injected", typeof as.logo_uri === "string" && as.logo_uri.endsWith("/favicon.png"));
  const prm = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
  check("PRM (path-specific) 200", prm.status === 200);

  // --- unauthenticated /mcp ---
  const noauth = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("POST /mcp without token → 401", noauth.status === 401);
  check("… with WWW-Authenticate", (noauth.headers.get("www-authenticate") ?? "").toLowerCase().startsWith("bearer"));

  // --- pages ---
  const start = await fetch(`${BASE}/start`);
  const startHtml = await start.text();
  // The page derives its origin from the request URL, as the OAuth issuer does; in wrangler dev that is the configured custom domain.
  const issuerOrigin = new URL(as.issuer).origin;
  check("/start 200 with the /mcp URL", start.status === 200 && startHtml.includes(`${issuerOrigin}/mcp`), `issuer=${issuerOrigin}`);
  check("/start sets security headers", start.headers.get("x-content-type-options") === "nosniff" && (start.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"));
  check("/start renders the three-plate rail", (startHtml.match(/class="plate"/g) ?? []).length === 3);
  let inviteCookie = "";
  if (INVITE) {
    const badInvite = await fetch(`${BASE}/start?invite=definitely-wrong`);
    check("/start with wrong invite: no cookie, explains", !badInvite.headers.get("set-cookie") && (await textOf(badInvite)).includes("isn't right"));
    const good = await fetch(`${BASE}/start?invite=${encodeURIComponent(INVITE)}`);
    const sc = good.headers.get("set-cookie") ?? "";
    inviteCookie = sc.split(";")[0];
    check("/start with right invite sets cookie", inviteCookie.startsWith("hevy_invite="));
  } else {
    console.log("  skip invite cookie checks (set INVITE)");
  }
  const privacy = await fetch(`${BASE}/privacy`);
  check("/privacy 200", privacy.status === 200);
  const admin = await fetch(`${BASE}/admin`, { redirect: "manual" });
  check("/admin without a session → redirected to sign-in", admin.status === 302 && (admin.headers.get("location") ?? "").endsWith("/admin/login"));
  const adminQuery = await fetch(`${BASE}/admin?token=${encodeURIComponent(process.env.OWNER_TOKEN ?? "x")}`, { redirect: "manual" });
  check("/admin?token= is not a sign-in (no cookie)", !(adminQuery.headers.get("set-cookie") ?? "").includes("hevy_owner="));

  // --- link previews + icons ---
  const og = await fetch(`${BASE}/og.png`);
  check("/og.png is a PNG with a day of cache", og.status === 200 && (og.headers.get("content-type") ?? "").startsWith("image/png") && (og.headers.get("cache-control") ?? "").includes("max-age"), `${og.status} ${og.headers.get("content-type")}`);
  const touch = await fetch(`${BASE}/apple-touch-icon.png`);
  check("/apple-touch-icon.png serves the icon", touch.status === 200 && (touch.headers.get("content-type") ?? "").startsWith("image/png"), `${touch.status}`);
  const startHead = await fetch(`${BASE}/start`).then((r) => r.text());
  check("/start carries link-preview tags with an absolute og:image", startHead.includes(`property="og:image" content="${BASE}/og.png"`) && startHead.includes('property="og:title"'));

  // --- client allowlist at /register ---
  const evil = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "evil", redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }),
  });
  check("DCR with unknown redirect → 400", evil.status === 400, `got ${evil.status}`);
  const reg = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "smoke-claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  const regBody = await reg.json().catch(() => ({}));
  check("DCR with claude.ai redirect → 201", reg.status === 201, `got ${reg.status} ${JSON.stringify(regBody).slice(0, 200)}`);
  const clientId = regBody.client_id;
  if (!clientId) {
    console.log("cannot continue without a client_id");
    return finish();
  }

  // --- /authorize ---
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const authUrl = `${BASE}/authorize?${form({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "smoke-state" })}`;
  const authz = await fetch(authUrl);
  const authzHtml = await authz.text();
  check("/authorize renders consent for Claude", authz.status === 200 && authzHtml.includes('data-page="connect"') && authzHtml.includes("<b>Claude</b>"));
  if (INVITE) {
    check("/authorize shows invite field without cookie", authzHtml.includes('name="invite"'));
    const withCookie = await fetch(authUrl, { headers: { cookie: inviteCookie } });
    check("/authorize hides invite field with cookie", !(await withCookie.text()).includes('name="invite"'));
  } else {
    check("/authorize has no invite field on an open deployment", !authzHtml.includes('name="invite"'));
  }
  const m = authzHtml.match(/name="oauthReqInfo" value="([^"]+)"/);
  check("/authorize carries oauthReqInfo", !!m);
  const oauthReqInfo = m ? m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&") : "";

  // spoofed redirect must not get the key form
  const spoof = await fetch(`${BASE}/authorize?${form({ client_id: clientId, redirect_uri: "https://evil.example/cb", response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "x" })}`);
  check("/authorize with unregistered redirect → not 200", spoof.status !== 200, `got ${spoof.status}`);

  // --- /approve ---
  // Local runs share one source IP, so repeated runs would trip the per-IP
  // failure counter; miniflare passes cf-connecting-ip through, so pick one per run.
  const fakeIp = /localhost|127\.0\.0\.1/.test(BASE) ? { "cf-connecting-ip": `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } : {};
  const post = (fields, cookie = "") =>
    fetch(`${BASE}/approve`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...fakeIp, ...(cookie ? { cookie } : {}) }, body: form(fields) });

  const shape = await post({ oauthReqInfo, hevy_key: "not-a-key", invite: "whatever" });
  check("/approve rejects non-UUID key (400)", shape.status === 400 && (await textOf(shape)).includes("doesn't look like"));

  const fakeKey = "00000000-0000-4000-8000-000000000000";
  if (INVITE) {
    const wrongInvite = await post({ oauthReqInfo, hevy_key: fakeKey, invite: "wrong-invite" });
    check("/approve rejects wrong invite before asking Hevy (403)", wrongInvite.status === 403 && (await textOf(wrongInvite)).includes("invite code isn't right"));
    const noInvite = await post({ oauthReqInfo, hevy_key: fakeKey });
    const noInviteText = await textOf(noInvite);
    check("/approve without invite and an unseen key → invite-only (403), Hevy never asked", noInvite.status === 403 && noInviteText.includes("invite-only"), `got ${noInvite.status}`);
  }
  const badKey = await post({ oauthReqInfo, hevy_key: fakeKey }, inviteCookie);
  check("/approve with a fake key → Hevy rejection copy (401)", badKey.status === 401 && (await textOf(badKey)).includes("didn't recognise"), `got ${badKey.status}`);

  if (!HEVY_API_KEY) {
    console.log("  skip full OAuth + MCP round trip (set HEVY_API_KEY)");
    return finish();
  }

  // --- real key: read-only grant ---
  const ok = await post({ oauthReqInfo, hevy_key: HEVY_API_KEY }, inviteCookie);
  const okHtml = await ok.text();
  check("/approve with real key → Connected page", ok.status === 200 && okHtml.includes("Connected as"));
  const redir = okHtml.match(/url=([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
  const code = redir ? new URL(redir).searchParams.get("code") : null;
  check("… carries an auth code back to the client", !!code);
  check("… state round-trips", redir ? new URL(redir).searchParams.get("state") === "smoke-state" : false);
  if (!code) return finish();

  const tok = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
  });
  const tokBody = await tok.json();
  check("/token exchanges the code", tok.status === 200 && typeof tokBody.access_token === "string", JSON.stringify(tokBody).slice(0, 200));
  check("… 7-day access token", tokBody.expires_in === 7 * 24 * 60 * 60, `expires_in=${tokBody.expires_in}`);
  check("… refresh token issued", typeof tokBody.refresh_token === "string");
  const token = tokBody.access_token;

  const rpc = async (method, params = {}, id = 1) => {
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const text = await r.text();
    // Stateless handler may answer as JSON or as a single SSE event.
    const jsonText = text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() : text;
    let body = null;
    try {
      body = JSON.parse(jsonText ?? "");
    } catch {}
    return { status: r.status, body, raw: text.slice(0, 300) };
  };

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  check("MCP initialize 200 with serverInfo", init.status === 200 && init.body?.result?.serverInfo?.name === "hevy-mcp", `${init.status} ${init.raw}`);

  const list = await rpc("tools/list", {}, 2);
  const names = (list.body?.result?.tools ?? []).map((t) => t.name);
  check("tools/list includes reads + whoami + disconnect", ["get_workouts", "search_exercise_templates", "whoami", "disconnect"].every((n) => names.includes(n)), names.join(","));
  check("tools/list excludes writes for a read-only grant", !names.includes("create_workout") && !names.includes("update_workout"));

  const who = await rpc("tools/call", { name: "whoami", arguments: {} }, 3);
  const whoText = who.body?.result?.content?.[0]?.text ?? "";
  check("whoami returns the account and read-only note", who.status === 200 && whoText.includes("can_write") && whoText.includes("false"), who.raw);

  const count = await rpc("tools/call", { name: "get_workout_count", arguments: {} }, 4);
  check("get_workout_count reaches Hevy", count.status === 200 && (count.body?.result?.content?.[0]?.text ?? "").includes("workout_count"), count.raw);

  const originCheck = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, origin: "https://claude.ai" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 40, method: "tools/list", params: {} }),
  });
  check("/mcp accepts a request carrying Origin: https://claude.ai (not 403)", originCheck.status === 200, `got ${originCheck.status}`);

  // The code exchange reads the grant record (caching the pre-exchange copy at
  // that colo) and then rewrites it with the refresh-token hash, so a refresh
  // seconds later can be answered from the stale copy with "Invalid refresh
  // token". Real clients refresh days later; here we wait it out.
  const { result: refresh, note: refreshNote } = await settles(
    async () => {
      const r = await fetch(`${BASE}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({ grant_type: "refresh_token", refresh_token: tokBody.refresh_token, client_id: clientId }),
      });
      return { status: r.status, body: await r.json() };
    },
    (r) => r.status === 200,
    (r) => r.status === 400 && r.body?.error === "invalid_grant",
  );
  const refreshBody = refresh.body;
  check(`refresh_token grant issues a new access token${refreshNote}`, refresh.status === 200 && typeof refreshBody.access_token === "string" && refreshBody.access_token !== token, JSON.stringify(refreshBody).slice(0, 200));
  const refreshed = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${refreshBody.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/list", params: {} }),
  });
  check("refreshed token still carries the key (tools/list 200 with whoami)", refreshed.status === 200 && (await refreshed.text()).includes('"whoami"'));

  // --- real key: write grant ---
  const v2 = b64url(randomBytes(32));
  const c2 = b64url(createHash("sha256").update(v2).digest());
  const authz2 = await fetch(`${BASE}/authorize?${form({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", code_challenge: c2, code_challenge_method: "S256", state: "s2" })}`, { headers: { cookie: inviteCookie } });
  const info2 = (await authz2.text()).match(/name="oauthReqInfo" value="([^"]+)"/)?.[1]?.replace(/&quot;/g, '"').replace(/&amp;/g, "&") ?? "";
  // returning member: no invite cookie needed this time
  const ok2 = await post({ oauthReqInfo: info2, hevy_key: HEVY_API_KEY, can_write: "on" });
  const html2 = await ok2.text();
  check("returning member connects without invite, with writes", ok2.status === 200 && html2.includes("add or edit"));
  const code2 = new URL((html2.match(/url=([^"]+)"/)?.[1] ?? "").replace(/&amp;/g, "&"), BASE).searchParams.get("code");
  const tok2 = await fetch(`${BASE}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ grant_type: "authorization_code", code: code2 ?? "", redirect_uri: redirectUri, client_id: clientId, code_verifier: v2 }) }).then((r) => r.json());
  const list2 = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok2.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }) }).then((r) => r.text());
  check("write grant lists create_workout", list2.includes('"create_workout"'));

  // A second authorization from the same client must NOT log the first one
  // out: claude.ai is one client id for every claude.ai account, so the
  // library's revoke-on-re-auth default made two accounts on one Hevy key
  // fight over it (2026-09-02). Every connection is its own grant.
  const first = await rpc("tools/list", {}, 6);
  check("a second authorization keeps the earlier connection working (200)", first.status === 200, `got ${first.status}`);

  // --- disconnect revokes; the same token must then be refused ---
  const rpc2 = async (method, params = {}, id = 1) => {
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok2.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const text = await r.text();
    const jsonText = text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() : text;
    let body = null;
    try { body = JSON.parse(jsonText ?? ""); } catch {}
    return { status: r.status, body, raw: text.slice(0, 300) };
  };
  // --- the six tools added 2026-09-02 (names, hints, one real read) ---
  const wl = await rpc2("tools/list", {}, 12);
  const wtools = wl.body?.result?.tools ?? [];
  const byName = Object.fromEntries(wtools.map((tool) => [tool.name, tool]));
  const added = ["update_routine", "update_body_measurement", "get_workout_events", "get_exercise_template", "get_routine_folder", "get_body_measurement"];
  check("write grant lists the six tools added 2026-09-02", added.every((n) => byName[n]), added.filter((n) => !byName[n]).join(","));
  check("update_routine is marked destructive, not read-only", byName.update_routine?.annotations?.destructiveHint === true && byName.update_routine?.annotations?.readOnlyHint === false, JSON.stringify(byName.update_routine?.annotations));
  check("get_workout_events is marked read-only", byName.get_workout_events?.annotations?.readOnlyHint === true, JSON.stringify(byName.get_workout_events?.annotations));
  const events = await rpc2("tools/call", { name: "get_workout_events", arguments: { pageSize: 1 } }, 13);
  const { result: conns, note: connsNote } = await settles(
    () => rpc2("tools/call", { name: "list_connections", arguments: {} }, 14),
    (r) => r.status === 200 && (r.body?.result?.content?.[0]?.text ?? "").includes('"this_app": true'),
    (r) => r.status === 200,
  );
  check(`list_connections shows this connection${connsNote}`, conns.status === 200 && (conns.body?.result?.content?.[0]?.text ?? "").includes('"this_app": true'), conns.raw);
  check("get_workout_events reaches Hevy (events array)", events.status === 200 && (events.body?.result?.content?.[0]?.text ?? "").includes('"events"'), events.raw);

  const disconnectedAt = Date.now();
  const bye = await rpc2("tools/call", { name: "disconnect", arguments: {} }, 7);
  check("disconnect (this app) answers", bye.status === 200 && (bye.body?.result?.content?.[0]?.text ?? "").includes("Disconnected this app"), bye.raw);
  const { result: after, note: afterNote } = await settles(() => rpc2("tools/list", {}, 8), (r) => r.status === 401, (r) => r.status === 200);
  check(`that token is refused afterwards (401 → client re-runs OAuth)${afterNote}`, after.status === 401, `got ${after.status}`);
  // The survivor's token and grant records were read seconds ago and sit in
  // the edge cache for ~60s, so in production a 200 here could be the cache
  // answering for a connection that was in fact revoked. Ask only after the
  // cache window has passed (immediately against local Miniflare).
  const cacheWindowMs = /localhost|127\.0\.0\.1/.test(BASE) ? 0 : 70_000;
  await new Promise((r) => setTimeout(r, Math.max(0, cacheWindowMs - (Date.now() - disconnectedAt))));
  const survivor = await rpc("tools/list", {}, 9);
  check("the other connection on the same key still works after the cache window (disconnect is per app)", survivor.status === 200, `got ${survivor.status}`);

  // Leave no grants behind: the read-only grant goes too, so smoke runs never
  // pile up year-long grants on the operator's real key or knock out the
  // operator's live connections (they did, 2026-09-02). What a run does leave:
  // the registered client record (expires in a year) and a refreshed
  // member record for the operator, neither of which touches Hevy.
  const bye1 = await rpc("tools/call", { name: "disconnect", arguments: {} }, 10);
  check("cleanup: the read-only connection disconnects itself", bye1.status === 200 && (bye1.body?.result?.content?.[0]?.text ?? "").includes("Disconnected this app"), bye1.raw);
  const { result: gone, note: goneNote } = await settles(() => rpc("tools/list", {}, 11), (r) => r.status === 401, (r) => r.status === 200);
  check(`cleanup: its token is refused afterwards${goneNote}`, gone.status === 401, `got ${gone.status}`);
  // The refresh above minted a second access token on that grant. The
  // provider validates a bearer against its own token record only, and
  // revokeGrant finds sibling tokens through an eventually consistent list,
  // so /mcp also checks the grant record itself; this is the check for that.
  const sibling = async () => {
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${refreshBody.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/list", params: {} }),
    });
    return { status: r.status };
  };
  const { result: sib, note: sibNote } = await settles(sibling, (r) => r.status === 401, (r) => r.status === 200);
  check(`cleanup: the refreshed sibling token is refused too (grant gone)${sibNote}`, sib.status === 401, `got ${sib.status}`);

  finish();
}

function finish() {
  console.log(`\n${passes + failures} checks run`);
  console.log(failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(2);
});
