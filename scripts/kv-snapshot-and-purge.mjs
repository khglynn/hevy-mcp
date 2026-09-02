#!/usr/bin/env node
/**
 * Snapshot (and optionally purge) the OAuth KV namespace through the REST API.
 *
 *   node scripts/kv-snapshot-and-purge.mjs            # snapshot only → backups/kv-<timestamp>.json
 *   node scripts/kv-snapshot-and-purge.mjs --purge    # snapshot, then delete every key
 *
 * Needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment (the
 * personal account) and reads the namespace id from wrangler.jsonc.
 *
 * Why the REST API and not `wrangler kv key list`: on 2026-09-01 wrangler
 * returned `[]` for this namespace while the API returned 12 keys.
 *
 * Why purge at all: the 2026-09-01 rebuild changed what a grant carries
 * (props v2 with the person's own Hevy key). A client holding a pre-v2 token
 * would get 401s until it re-authorized; purging makes every client re-run
 * OAuth once, cleanly, at the moment of cutover.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) {
  console.error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (personal account).");
  process.exit(2);
}
const cfg = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const ns = cfg.match(/"binding":\s*"OAUTH_KV"[\s\S]*?"id":\s*"([0-9a-f]{32})"/)?.[1];
if (!ns) {
  console.error("Could not find the OAUTH_KV namespace id in wrangler.jsonc");
  process.exit(2);
}
const api = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${ns}`;
const headers = { authorization: `Bearer ${token}` };

async function listKeys() {
  const keys = [];
  let cursor = "";
  do {
    const r = await fetch(`${api}/keys?limit=1000${cursor ? `&cursor=${cursor}` : ""}`, { headers });
    const j = await r.json();
    if (!j.success) throw new Error(JSON.stringify(j.errors));
    keys.push(...j.result.map((k) => k.name));
    cursor = j.result_info?.cursor ?? "";
  } while (cursor);
  return keys;
}

const keys = await listKeys();
const snapshot = {};
for (const k of keys) {
  const r = await fetch(`${api}/values/${encodeURIComponent(k)}`, { headers });
  snapshot[k] = await r.text();
}
mkdirSync(new URL("../backups/", import.meta.url), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = new URL(`../backups/kv-${stamp}.json`, import.meta.url);
writeFileSync(out, JSON.stringify({ namespace: ns, takenAt: stamp, keys: snapshot }, null, 2));
const counts = keys.reduce((m, k) => ((m[k.split(":")[0]] = (m[k.split(":")[0]] ?? 0) + 1), m), {});
console.log(`snapshot: ${keys.length} keys → ${out.pathname}`);
console.log("by prefix:", counts);

if (!process.argv.includes("--purge")) process.exit(0);

let deleted = 0;
for (let i = 0; i < keys.length; i += 100) {
  const batch = keys.slice(i, i + 100);
  const r = await fetch(`${api}/bulk/delete`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(batch),
  });
  const j = await r.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors));
  deleted += batch.length;
}
const left = await listKeys();
console.log(`purged ${deleted} keys; ${left.length} remain`);
process.exit(left.length === 0 ? 0 : 1);
