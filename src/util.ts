/**
 * Small helpers shared by the pages and the tools. Nothing here knows about
 * Hevy or OAuth; it is string, crypto, cookie and logging plumbing.
 */

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** The Worker env plus the helpers workers-oauth-provider injects at runtime. */
export type AppEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

/** Constant-time compare so a secret can't be recovered via response timing. */
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Length is not the secret; the content comparison is constant-time for equal lengths.
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hevy API keys are UUIDs — the OpenAPI spec types the `api-key` header as format uuid. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * OAuth userId derived from the Hevy user id. The provider builds token
 * strings and KV keys by joining on ':', so the raw upstream id never goes in;
 * the hash is stable, separator-free, and leaks nothing about the person.
 */
export async function deriveUserId(hevyUserId: string): Promise<string> {
  return "hevy_" + (await sha256Hex("hevy-user:" + hevyUserId)).slice(0, 32);
}

const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Field names whose values are masked whatever their shape — identity and secrets. */
const REDACT_FIELDS = new Set(["name", "token", "invite", "secret", "authorization", "cookie", "hevyapikey", "access_token", "refresh_token", "code"]);

/** Mask anything UUID-shaped (Hevy keys are UUIDs) and any identity/secret field, so neither lands in Workers Logs. */
export function redact<T>(value: T): T {
  if (typeof value === "string") return value.replace(UUID_ANYWHERE, "[redacted]") as T;
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_FIELDS.has(k.toLowerCase()) && v != null ? "[redacted]" : redact(v);
    }
    return out as T;
  }
  return value;
}

/** Structured, redacted log line. Query in Workers Observability by `event`. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...redact(fields) }));
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function cookie(name: string, value: string, maxAgeSeconds: number, path = "/"): string {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

/** Random, URL-safe, 128+ bits — session ids and CSP nonces. */
export function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

/** The operator's name for user-facing copy. Set OPERATOR_NAME in wrangler.jsonc `vars`. */
export function operatorName(env: { OPERATOR_NAME?: string }): string {
  const n = (env.OPERATOR_NAME ?? "").trim();
  return n || "the person who runs this server";
}

/**
 * Membership key derived from the API key itself, so a returning person can be
 * recognised BEFORE Hevy is asked about the key. Hash only; the key is never stored.
 */
export async function memberKeyFor(apiKey: string): Promise<string> {
  return "memberkey:" + (await sha256Hex("hevy-key:" + apiKey.toLowerCase())).slice(0, 40);
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/** Revoke every grant a user holds. Used when their Hevy key dies and by the disconnect tool. */
export async function revokeAllGrants(env: AppEnv, userId: string): Promise<number> {
  let revoked = 0;
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(userId, { cursor });
    for (const grant of page.items) {
      await env.OAUTH_PROVIDER.revokeGrant(grant.id, userId);
      revoked++;
    }
    cursor = page.cursor;
  } while (cursor);
  return revoked;
}
