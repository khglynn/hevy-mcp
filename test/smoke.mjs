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
function check(name, cond, detail = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
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
  const badInvite = await fetch(`${BASE}/start?invite=definitely-wrong`);
  check("/start with wrong invite: no cookie, explains", !badInvite.headers.get("set-cookie") && (await textOf(badInvite)).includes("isn't right"));
  let inviteCookie = "";
  if (INVITE) {
    const good = await fetch(`${BASE}/start?invite=${encodeURIComponent(INVITE)}`);
    const sc = good.headers.get("set-cookie") ?? "";
    inviteCookie = sc.split(";")[0];
    check("/start with right invite sets cookie", inviteCookie.startsWith("hevy_invite="));
  } else {
    console.log("  skip invite cookie checks (set INVITE)");
  }
  const privacy = await fetch(`${BASE}/privacy`);
  check("/privacy 200", privacy.status === 200);
  const admin = await fetch(`${BASE}/admin`);
  check("/admin without owner cookie → 404", admin.status === 404);

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
  check("/authorize renders consent for Claude", authz.status === 200 && authzHtml.includes("Connect your Hevy account") && authzHtml.includes("<b>Claude</b>"));
  check("/authorize shows invite field without cookie", authzHtml.includes('name="invite"'));
  if (inviteCookie) {
    const withCookie = await fetch(authUrl, { headers: { cookie: inviteCookie } });
    check("/authorize hides invite field with cookie", !(await withCookie.text()).includes('name="invite"'));
  }
  const m = authzHtml.match(/name="oauthReqInfo" value="([^"]+)"/);
  check("/authorize carries oauthReqInfo", !!m);
  const oauthReqInfo = m ? m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&") : "";

  // spoofed redirect must not get the key form
  const spoof = await fetch(`${BASE}/authorize?${form({ client_id: clientId, redirect_uri: "https://evil.example/cb", response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "x" })}`);
  check("/authorize with unregistered redirect → not 200", spoof.status !== 200, `got ${spoof.status}`);

  // --- /approve ---
  const post = (fields, cookie = "") =>
    fetch(`${BASE}/approve`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: form(fields) });

  const shape = await post({ oauthReqInfo, hevy_key: "not-a-key", invite: "whatever" });
  check("/approve rejects non-UUID key (400)", shape.status === 400 && (await textOf(shape)).includes("doesn't look like"));

  const fakeKey = "00000000-0000-4000-8000-000000000000";
  const wrongInvite = await post({ oauthReqInfo, hevy_key: fakeKey, invite: "wrong-invite" });
  check("/approve rejects wrong invite before asking Hevy (403)", wrongInvite.status === 403 && (await textOf(wrongInvite)).includes("invite code isn't right"));

  const noInvite = await post({ oauthReqInfo, hevy_key: fakeKey });
  const noInviteText = await textOf(noInvite);
  check("/approve without invite: fake key → Hevy rejection (401)", noInvite.status === 401 && noInviteText.includes("didn't recognise"), `got ${noInvite.status}`);

  if (inviteCookie) {
    const badKey = await post({ oauthReqInfo, hevy_key: fakeKey }, inviteCookie);
    check("/approve with invite + fake key → Hevy rejection copy", badKey.status === 401 && (await textOf(badKey)).includes("didn't recognise"));
  }

  if (!HEVY_API_KEY || !inviteCookie) {
    console.log("  skip full OAuth + MCP round trip (set HEVY_API_KEY and INVITE)");
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

  const refresh = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "refresh_token", refresh_token: tokBody.refresh_token, client_id: clientId }),
  });
  const refreshBody = await refresh.json();
  check("refresh_token grant issues a new access token", refresh.status === 200 && typeof refreshBody.access_token === "string" && refreshBody.access_token !== token, JSON.stringify(refreshBody).slice(0, 200));

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

  // --- admin (owner token) ---
  if (process.env.OWNER_TOKEN) {
    const login = await fetch(`${BASE}/admin?token=${encodeURIComponent(process.env.OWNER_TOKEN)}`, { redirect: "manual" });
    const ownerCookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    check("/admin?token= sets owner cookie and redirects", login.status === 302 && ownerCookie.startsWith("hevy_owner="));
    const adminPage = await fetch(`${BASE}/admin`, { headers: { cookie: ownerCookie } });
    const adminHtml = await adminPage.text();
    check("/admin lists grants for the owner", adminPage.status === 200 && adminHtml.includes("Connected accounts") && adminHtml.includes("smoke-claude") === false && adminHtml.includes("Revoke"));
  } else {
    console.log("  skip admin checks (set OWNER_TOKEN)");
  }

  // --- disconnect revokes; the same token must then be refused ---
  const bye = await rpc("tools/call", { name: "disconnect", arguments: {} }, 6);
  check("disconnect tool revokes grants", bye.status === 200 && (bye.body?.result?.content?.[0]?.text ?? "").includes("Disconnected"), bye.raw);
  const after = await rpc("tools/list", {}, 7);
  check("token is refused after disconnect (401 → client re-runs OAuth)", after.status === 401, `got ${after.status}`);

  finish();
}

function finish() {
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(2);
});
