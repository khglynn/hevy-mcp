/**
 * Thin client for the Hevy API (https://api.hevyapp.com/v1).
 *
 * Three realities this client handles so the tools don't have to:
 *  - Pagination: every list endpoint caps `pageSize` at 10 (except exercise
 *    templates at 100). `paginate()` loops pages up to a safety cap.
 *  - Rate limiting: Hevy returns 429 with an undocumented, low ceiling.
 *    `request()` retries with backoff (honoring Retry-After when present).
 *  - Template search is the most-called tool and costs up to six upstream
 *    requests per call, so the template list is cached per user in KV.
 */

const BASE = "https://api.hevyapp.com/v1";

export class HevyError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`Hevy API ${status}: ${body.slice(0, 200)}`);
    this.name = "HevyError";
  }
}

export interface HevyUser {
  id: string;
  name: string;
  url: string;
}

/**
 * Prove a key is real by asking Hevy who it belongs to. One request, no
 * retries: a 401 here means "Hevy rejected the key", and that is the answer.
 */
export async function validateHevyKey(apiKey: string): Promise<HevyUser> {
  const res = await fetch(`${BASE}/user/info`, { headers: { "api-key": apiKey }, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  if (!res.ok) throw new HevyError(res.status, text);
  let data: Partial<HevyUser> | undefined;
  try {
    data = (JSON.parse(text) as { data?: Partial<HevyUser> }).data;
  } catch {
    throw new HevyError(502, "user info was not JSON");
  }
  if (!data || typeof data.id !== "string" || !data.id) throw new HevyError(502, "user info had no id");
  return {
    id: data.id,
    name: typeof data.name === "string" ? data.name : "",
    url: typeof data.url === "string" ? data.url : "",
  };
}

export interface TemplateCache {
  kv: KVNamespace;
  key: string;
  ttlSeconds: number;
}

type Query = Record<string, string | number | boolean | undefined | null>;

/** One budget per tool call: Hevy's Retry-After is honoured only inside it, so a rate-limit episode surfaces as a readable 429 instead of a client timeout. */
const CALL_DEADLINE_MS = 15_000;
const PER_REQUEST_TIMEOUT_MS = 10_000;

export class HevyClient {
  private deadline = Date.now() + CALL_DEADLINE_MS;

  constructor(
    private apiKey: string,
    private cache?: TemplateCache,
  ) {}

  private async request(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<any> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = { "api-key": this.apiKey };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (Date.now() > this.deadline) throw new HevyError(429, "Rate limited: call budget exhausted");
      const res = await fetch(url.toString(), { method, headers, body, signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS) });

      if (res.status === 429 && attempt < maxAttempts) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const delayMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 400 * 2 ** (attempt - 1); // 400ms, 800ms, 1600ms
        // Honour Retry-After only if the wait fits the call budget; otherwise
        // stop now and let the tool report "Hevy is rate-limiting" instead of hanging.
        if (Date.now() + delayMs > this.deadline) throw new HevyError(429, "Rate limited: Retry-After exceeds call budget");
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      const text = await res.text();
      if (!res.ok) throw new HevyError(res.status, text);
      return text ? JSON.parse(text) : null;
    }
    throw new HevyError(429, "Rate limited after retries");
  }

  /** Loop pages, collecting items found under `key`, up to maxPages. */
  private async paginate(
    path: string,
    key: string,
    opts: { pageSize: number; maxPages: number; query?: Query },
  ): Promise<any[]> {
    const items: any[] = [];
    for (let page = 1; page <= opts.maxPages; page++) {
      const data = await this.request("GET", path, {
        query: { ...opts.query, page, pageSize: opts.pageSize },
      });
      const batch: any[] = data?.[key] ?? [];
      items.push(...batch);
      const pageCount: number = data?.page_count ?? 1;
      if (page >= pageCount || batch.length === 0) break;
    }
    return items;
  }

  // ---------- reads ----------
  getUserInfo() {
    return this.request("GET", "/user/info");
  }
  getWorkoutCount() {
    return this.request("GET", "/workouts/count");
  }
  getWorkouts(query: { page?: number; pageSize?: number }) {
    return this.request("GET", "/workouts", { query });
  }
  getWorkout(id: string) {
    return this.request("GET", `/workouts/${encodeURIComponent(id)}`);
  }
  getRoutines(query: { page?: number; pageSize?: number }) {
    return this.request("GET", "/routines", { query });
  }
  getRoutine(id: string) {
    return this.request("GET", `/routines/${encodeURIComponent(id)}`);
  }
  getRoutineFolders(query: { page?: number; pageSize?: number }) {
    return this.request("GET", "/routine_folders", { query });
  }
  getExerciseHistory(exerciseTemplateId: string, query: { start_date?: string; end_date?: string } = {}) {
    return this.request("GET", `/exercise_history/${encodeURIComponent(exerciseTemplateId)}`, { query });
  }
  getBodyMeasurements(query: { page?: number; pageSize?: number }) {
    return this.request("GET", "/body_measurements", { query });
  }

  /**
   * The full template list (Hevy's built-ins plus this user's customs), cached
   * per user. Near-static data; the cache is dropped when a custom template is
   * created and expires on its own otherwise.
   */
  private async allTemplates(): Promise<any[]> {
    if (this.cache) {
      const hit = await this.cache.kv.get<any[]>(this.cache.key, "json");
      if (Array.isArray(hit)) return hit;
    }
    const all = await this.paginate("/exercise_templates", "exercise_templates", {
      pageSize: 100,
      maxPages: 6, // up to 600 templates — covers Hevy's built-in set + customs
    });
    if (this.cache && all.length > 0) {
      await this.cache.kv.put(this.cache.key, JSON.stringify(all), { expirationTtl: this.cache.ttlSeconds });
    }
    return all;
  }

  /**
   * Search exercise templates by title (case-insensitive substring) — how you
   * get the `exercise_template_id` needed to build workouts/routines.
   */
  async searchExerciseTemplates(q: { query?: string; limit?: number }): Promise<any[]> {
    const limit = q.limit ?? 20;
    const all = await this.allTemplates();
    const needle = q.query?.trim().toLowerCase();
    const matched = needle
      ? all.filter((t) => String(t.title ?? "").toLowerCase().includes(needle))
      : all;
    return matched.slice(0, limit);
  }

  // ---------- writes ----------
  createWorkout(workout: unknown) {
    return this.request("POST", "/workouts", { body: { workout } });
  }
  updateWorkout(id: string, workout: unknown) {
    return this.request("PUT", `/workouts/${encodeURIComponent(id)}`, { body: { workout } });
  }
  createRoutine(routine: unknown) {
    return this.request("POST", "/routines", { body: { routine } });
  }
  createRoutineFolder(title: string) {
    return this.request("POST", "/routine_folders", {
      body: { routine_folder: { title } },
    });
  }
  async createExerciseTemplate(exercise: unknown) {
    const created = await this.request("POST", "/exercise_templates", { body: { exercise } });
    if (this.cache) await this.cache.kv.delete(this.cache.key);
    return created;
  }
  createBodyMeasurement(measurement: unknown) {
    return this.request("POST", "/body_measurements", { body: measurement });
  }
}
