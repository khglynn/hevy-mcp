/**
 * Thin client for the Hevy API (https://api.hevyapp.com/v1).
 *
 * Two realities this client handles so the tools don't have to:
 *  - Pagination: every list endpoint caps `pageSize` at 10 (except exercise
 *    templates at 100). `paginate()` loops pages up to a safety cap.
 *  - Rate limiting: Hevy returns 429 with an undocumented, low ceiling.
 *    `request()` retries with backoff (honoring Retry-After when present).
 */

const BASE = "https://api.hevyapp.com/v1";

export class HevyError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`Hevy API ${status}: ${body.slice(0, 400)}`);
    this.name = "HevyError";
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

export class HevyClient {
  constructor(private apiKey: string) {}

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
      const res = await fetch(url.toString(), { method, headers, body });

      if (res.status === 429 && attempt < maxAttempts) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const delayMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 400 * 2 ** (attempt - 1); // 400ms, 800ms, 1600ms
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
  getWorkoutCount() {
    return this.request("GET", "/workouts/count");
  }
  getWorkouts(query: { page?: number; pageSize?: number }) {
    return this.request("GET", "/workouts", { query });
  }
  getWorkout(id: string) {
    return this.request("GET", `/workouts/${id}`);
  }
  getRoutines(query: { page?: number; pageSize?: number }) {
    return this.request("GET", "/routines", { query });
  }
  getRoutine(id: string) {
    return this.request("GET", `/routines/${id}`);
  }
  getRoutineFolders(query: { page?: number; pageSize?: number }) {
    return this.request("GET", "/routine_folders", { query });
  }
  getExerciseHistory(exerciseTemplateId: string) {
    return this.request("GET", `/exercise_history/${exerciseTemplateId}`);
  }
  getBodyMeasurements(query: { page?: number; pageSize?: number }) {
    return this.request("GET", "/body_measurements", { query });
  }
  getUserInfo() {
    return this.request("GET", "/user/info");
  }

  /**
   * Search exercise templates by title (case-insensitive substring).
   * Pages through the big template list (pageSize 100) to find matches —
   * how you get the `exercise_template_id` needed to build workouts/routines.
   */
  async searchExerciseTemplates(q: { query?: string; limit?: number }): Promise<any[]> {
    const limit = q.limit ?? 20;
    const all = await this.paginate("/exercise_templates", "exercise_templates", {
      pageSize: 100,
      maxPages: 6, // up to 600 templates — covers Hevy's built-in set + customs
    });
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
    return this.request("PUT", `/workouts/${id}`, { body: { workout } });
  }
  createRoutine(routine: unknown) {
    return this.request("POST", "/routines", { body: { routine } });
  }
  createRoutineFolder(title: string) {
    return this.request("POST", "/routine_folders", {
      body: { routine_folder: { title } },
    });
  }
  createExerciseTemplate(exercise: unknown) {
    return this.request("POST", "/exercise_templates", { body: { exercise } });
  }
  createBodyMeasurement(measurement: unknown) {
    return this.request("POST", "/body_measurements", { body: measurement });
  }
}
