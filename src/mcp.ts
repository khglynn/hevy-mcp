/**
 * Hevy MCP tools, built fresh for every request from the caller's own grant.
 *
 * Design notes:
 *  - `buildServer` runs once per HTTP request (stateless handler). The Hevy
 *    key comes from the decrypted OAuth props of the token on that request and
 *    is never stored anywhere else — there is no session object another user
 *    could reach and nothing at rest to clean up.
 *  - Write tools are registered only when the person ticked "let Claude add
 *    and edit" at connect time (`props.canWrite`).
 *  - Every handler is wrapped: Hevy errors come back as readable tool errors,
 *    and a Hevy 401 (dead key) revokes the person's grants so their client is
 *    forced back through OAuth instead of erroring forever.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { FAVICON_DATA_URI } from "./favicon";
import { HevyClient, HevyError, validateHevyKey } from "./hevy";
import { type AppEnv, log, memberKeyFor, operatorName, revokeAllGrants } from "./util";

export const PROPS_VERSION = 3;

/** What a grant carries. Anything else is treated as unauthenticated. */
export interface HevyProps {
  v: number;
  hevyApiKey: string;
  /** Non-secret fingerprint of the key; also in grant metadata so a dead key revokes only its own grants. */
  keyFingerprint: string;
  hevyUserId: string;
  name: string;
  canWrite: boolean;
  client: string;
}

export function isHevyProps(p: unknown): p is HevyProps {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return (
    o.v === PROPS_VERSION &&
    typeof o.hevyApiKey === "string" &&
    o.hevyApiKey.length > 0 &&
    typeof o.keyFingerprint === "string" &&
    typeof o.hevyUserId === "string" &&
    o.hevyUserId.length > 0 &&
    typeof o.canWrite === "boolean"
  );
}

export interface ToolContext {
  env: AppEnv;
  props: HevyProps;
  origin: string;
}

const TEMPLATE_CACHE_TTL = 6 * 60 * 60;

// ---------- result helpers ----------
function ok(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * Turn a failure into something a person can act on. The 401 branch is the
 * one that matters: Hevy rejected the key, so the grant is revoked here and
 * the client's next request gets an HTTP 401, which is what makes Claude
 * re-run OAuth. Without that, a revoked key means a connector that looks
 * healthy and errors forever.
 */
async function fail(e: unknown, ctx: ToolContext, isWrite: boolean) {
  const operator = operatorName(ctx.env);
  if (e instanceof HevyError) {
    if (e.status === 401) {
      // Confirm before tearing anything down: revoke only if the key itself is
      // rejected by Hevy's own user-info endpoint. A 401 from an odd path, a
      // gateway blip or a network error must not cost someone every connector.
      let confirmedDead = false;
      try {
        await validateHevyKey(ctx.props.hevyApiKey);
      } catch (check) {
        confirmedDead = check instanceof HevyError && check.status === 401;
      }
      if (!confirmedDead) {
        log("hevy.unauthorized_unconfirmed", { userId: ctx.props.hevyUserId });
        return errorResult("Hevy answered 401 to that request but your key still checks out, so nothing was changed. Try again in a moment; if it keeps happening, the specific id you asked for may be wrong.");
      }
      let revoked = 0;
      try {
        // Only the grants carrying THIS key: a client that already reconnected with a new key keeps working.
        revoked = await revokeAllGrants(ctx.env, ctx.props.hevyUserId, ctx.props.keyFingerprint);
        await ctx.env.OAUTH_KV.delete(await memberKeyFor(ctx.props.hevyApiKey));
      } catch (revokeErr) {
        log("hevy.revoke_failed", { userId: ctx.props.hevyUserId, error: String(revokeErr) });
      }
      log("hevy.key_rejected", { userId: ctx.props.hevyUserId, client: ctx.props.client, revoked });
      return errorResult(
        `Your Hevy key isn't working anymore — Hevy rejected it. That usually means it was revoked or replaced on Hevy's Developer page. ` +
          `This connection has been disconnected. To reconnect: remove the Hevy connector, add it again, and paste your current key. Because it is a new key, the page will ask for the invite — open the invite link you were originally sent (or ask ${operatorName(ctx.env)} for it), then start here: ${ctx.origin}/start`,
      );
    }
    if (e.status === 403) {
      log("hevy.forbidden", { userId: ctx.props.hevyUserId });
      return errorResult(
        "Hevy says this key isn't active. That usually means the Hevy Pro subscription behind it has lapsed — the API is a Pro feature. Renew Pro and the same key should start working again.",
      );
    }
    if (e.status === 429) {
      log("hevy.rate_limited", { userId: ctx.props.hevyUserId });
      return errorResult("Hevy is rate-limiting requests right now. Nothing is wrong with your key — wait a minute and try again.");
    }
    if (e.status >= 500 || e.status === 0) {
      log("hevy.upstream_failure", { userId: ctx.props.hevyUserId, status: e.status, write: isWrite });
      return errorResult(
        isWrite
          ? "Hevy didn't confirm whether that change saved. Check the Hevy app before retrying so you don't create a duplicate."
          : "Hevy didn't answer this time. Try again in a minute.",
      );
    }
    // A 4xx with a reason: show only Hevy's own message, never the raw body.
    let reason = "";
    try {
      const parsed = JSON.parse(e.body) as { message?: unknown; error?: unknown };
      reason = typeof parsed.message === "string" ? parsed.message : typeof parsed.error === "string" ? parsed.error : "";
    } catch {
      reason = e.body.length < 160 ? e.body : "";
    }
    return errorResult(`Hevy rejected that request (${e.status})${reason ? `: ${reason}` : ""}. Check the values and try again.`);
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/abort|timeout|network|fetch failed/i.test(msg)) {
    log("hevy.network_failure", { userId: ctx.props.hevyUserId, write: isWrite });
    return errorResult(
      isWrite
        ? "Hevy didn't confirm whether that change saved. Check the Hevy app before retrying so you don't create a duplicate."
        : "Hevy didn't answer this time. Try again in a minute.",
    );
  }
  log("tool.unexpected_error", { userId: ctx.props.hevyUserId, error: msg });
  return errorResult(`The connector hit an unexpected problem. Try once more; if it repeats, tell ${operator}.`);
}

/** "get_workout_count" -> "Get workout count" for a readable display title. */
function titleCase(name: string): string {
  const s = name.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Register a tool whose handler is auto-wrapped with ok()/fail(). Read/write
 * is derived from the name prefix and exposed via annotations, so MCP clients
 * can group reads vs writes and auto-run read-only tools without a prompt.
 */
function reg<S extends z.ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  name: string,
  description: string,
  shape: S,
  handler: (args: z.infer<z.ZodObject<S>>, hevy: HevyClient) => Promise<unknown>,
) {
  const readOnly = /^(get_|search_|whoami)/.test(name);
  const destructive = /^(update_|disconnect)/.test(name); // update_workout overwrites; creates are additive
  const callback = async (args: any) => {
    try {
      const hevy = new HevyClient(ctx.props.hevyApiKey, {
        kv: ctx.env.OAUTH_KV,
        key: `tplcache:${ctx.props.hevyUserId}`,
        ttlSeconds: TEMPLATE_CACHE_TTL,
      });
      return ok(await handler(args, hevy));
    } catch (e) {
      return await fail(e, ctx, !readOnly);
    }
  };
  // Cast only at this boundary: the generic wrapper above erases the exact
  // arg/return types the SDK's registerTool callback expects. The runtime
  // shape (ok()/fail()) is a valid CallToolResult.
  server.registerTool(
    name,
    {
      title: titleCase(name),
      description,
      inputSchema: z.object(shape),
      annotations: { readOnlyHint: readOnly, destructiveHint: readOnly ? false : destructive },
    },
    callback as never,
  );
}

// ---------- shared schemas (match the Hevy OpenAPI spec) ----------
const page = z.number().int().min(1).optional().describe("Page number (default 1).");
const pageSize = z
  .number()
  .int()
  .min(1)
  .max(10)
  .optional()
  .describe("Items per page, max 10 (default 5).");

const setType = z
  .enum(["warmup", "normal", "failure", "dropset"])
  .describe("warmup | normal | failure | dropset");

const workoutSet = z.object({
  type: setType.default("normal"),
  weight_kg: z.number().nullable().optional(),
  reps: z.number().int().nullable().optional(),
  distance_meters: z.number().int().nullable().optional(),
  duration_seconds: z.number().int().nullable().optional(),
  custom_metric: z.number().nullable().optional().describe("e.g. steps or floors"),
  rpe: z
    .number()
    .nullable()
    .optional()
    .describe("Rating of Perceived Exertion — one of 6, 7, 7.5, 8, 8.5, 9, 9.5, 10"),
});

const workoutExercise = z.object({
  exercise_template_id: z
    .string()
    .describe("Get this from search_exercise_templates."),
  superset_id: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
  sets: z.array(workoutSet),
});

const routineSet = z.object({
  type: setType.default("normal"),
  weight_kg: z.number().nullable().optional(),
  reps: z.number().int().nullable().optional(),
  distance_meters: z.number().int().nullable().optional(),
  duration_seconds: z.number().int().nullable().optional(),
  custom_metric: z.number().nullable().optional(),
  rep_range: z
    .object({ start: z.number(), end: z.number() })
    .nullable()
    .optional()
    .describe("Target rep range, e.g. { start: 8, end: 12 }."),
});

const routineExercise = z.object({
  exercise_template_id: z.string(),
  superset_id: z.number().int().nullable().optional(),
  rest_seconds: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
  sets: z.array(routineSet),
});

// ---------- the server, per request ----------
export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({
    name: "hevy-mcp",
    version: "0.2.0",
    title: "Hevy",
    icons: [{ src: FAVICON_DATA_URI, mimeType: "image/png", sizes: ["128x128"] }],
  });

  // ===== account =====
  reg(
    server,
    ctx,
    "whoami",
    "Which Hevy account this connection uses, and whether Claude may add or edit anything. Use this first when something looks wrong.",
    {},
    async () => ({
      hevy_account: ctx.props.name,
      connected_via: ctx.props.client,
      can_write: ctx.props.canWrite,
      note: ctx.props.canWrite
        ? "Claude may log workouts and create routines, folders, custom exercises and body measurements. Hevy has no delete API, so update_workout overwrites without undo."
        : `Read-only. To let Claude add and edit, remove the connector and connect again with the "let Claude add and edit" box ticked: ${ctx.origin}/start`,
    }),
  );

  reg(
    server,
    ctx,
    "disconnect",
    "Disconnect this Hevy account from the server: revokes every grant for this person and forgets the key they connected with, so no client can use the stored key. Ask before calling this.",
    {},
    async () => {
      const revoked = await revokeAllGrants(ctx.env, ctx.props.hevyUserId);
      await Promise.all([
        ctx.env.OAUTH_KV.delete(`member:${ctx.props.hevyUserId}`),
        ctx.env.OAUTH_KV.delete(await memberKeyFor(ctx.props.hevyApiKey)),
        ctx.env.OAUTH_KV.delete(`tplcache:${ctx.props.hevyUserId}`),
      ]);
      log("user.disconnected", { userId: ctx.props.hevyUserId, revoked });
      return `Disconnected. ${revoked} connection(s) revoked and the stored key is gone with them; this server has also forgotten the key you connected with, so reconnecting needs an invite link again. To cut Hevy access at the source too, revoke the key on Hevy's Developer page (hevy.com/settings?developer). Reconnect any time: ${ctx.origin}/start`;
    },
  );

  // ===== reads =====
  reg(server, ctx, "get_user_info", "Get the authenticated Hevy user's basic info.", {}, (_a, hevy) =>
    hevy.getUserInfo(),
  );

  reg(
    server,
    ctx,
    "get_workout_count",
    "Get the total number of workouts on the account.",
    {},
    (_a, hevy) => hevy.getWorkoutCount(),
  );

  reg(
    server,
    ctx,
    "get_workouts",
    "List workouts, newest first, paginated. Each workout includes its exercises and sets (weight_kg, reps, rpe, etc.).",
    { page, pageSize },
    ({ page, pageSize }, hevy) => hevy.getWorkouts({ page: page ?? 1, pageSize: pageSize ?? 5 }),
  );

  reg(
    server,
    ctx,
    "get_workout",
    "Get a single workout by its id, with full exercise and set detail.",
    { workoutId: z.string().describe("The workout id (UUID).") },
    ({ workoutId }, hevy) => hevy.getWorkout(workoutId),
  );

  reg(
    server,
    ctx,
    "get_routines",
    "List saved routines (workout templates), paginated.",
    { page, pageSize },
    ({ page, pageSize }, hevy) => hevy.getRoutines({ page: page ?? 1, pageSize: pageSize ?? 5 }),
  );

  reg(
    server,
    ctx,
    "get_routine",
    "Get a single routine by its id.",
    { routineId: z.string().describe("The routine id (UUID).") },
    ({ routineId }, hevy) => hevy.getRoutine(routineId),
  );

  reg(
    server,
    ctx,
    "get_routine_folders",
    "List routine folders (used to organize routines), paginated.",
    { page, pageSize },
    ({ page, pageSize }, hevy) => hevy.getRoutineFolders({ page: page ?? 1, pageSize: pageSize ?? 5 }),
  );

  reg(
    server,
    ctx,
    "search_exercise_templates",
    "Find exercise templates by name (case-insensitive). Returns matches with their exercise_template_id — the id you need to log a workout or build a routine. Omit `query` to list templates.",
    {
      query: z.string().optional().describe('Substring of the exercise title, e.g. "bench".'),
      limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)."),
    },
    ({ query, limit }, hevy) => hevy.searchExerciseTemplates({ query, limit }),
  );

  reg(
    server,
    ctx,
    "get_exercise_history",
    "Get the logged history for one exercise (progress over time). Defaults to the last 12 months and at most 200 most-recent entries; pass start_date/end_date to move the window.",
    {
      exerciseTemplateId: z
        .string()
        .describe("Exercise template id, from search_exercise_templates."),
      start_date: z.string().optional().describe("ISO 8601 date-time, e.g. 2026-01-01T00:00:00Z. Default: 12 months ago."),
      end_date: z.string().optional().describe("ISO 8601 date-time. Default: now."),
    },
    async ({ exerciseTemplateId, start_date, end_date }, hevy) => {
      const start = start_date ?? new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
      const data = await hevy.getExerciseHistory(exerciseTemplateId, { start_date: start, end_date });
      const history: unknown[] = Array.isArray(data?.exercise_history) ? data.exercise_history : [];
      const cap = 200;
      if (history.length <= cap) return { ...data, window: { start_date: start, end_date: end_date ?? "now" } };
      return {
        ...data,
        exercise_history: history.slice(-cap),
        window: { start_date: start, end_date: end_date ?? "now" },
        note: `${history.length} entries in this window; showing the most recent ${cap}. Narrow start_date/end_date for the rest.`,
      };
    },
  );

  reg(
    server,
    ctx,
    "get_body_measurements",
    "List body-measurement entries (weight, body fat, circumferences), paginated.",
    { page, pageSize },
    ({ page, pageSize }, hevy) => hevy.getBodyMeasurements({ page: page ?? 1, pageSize: pageSize ?? 10 }),
  );

  if (!ctx.props.canWrite) return server;

  // ===== writes (only when the person opted in at connect time) =====
  reg(
    server,
    ctx,
    "create_workout",
    "Log a completed workout. Times are ISO 8601 (e.g. 2026-06-03T18:00:00Z). Each exercise needs an exercise_template_id (from search_exercise_templates) and its sets.",
    {
      title: z.string(),
      description: z.string().nullable().optional(),
      start_time: z.string().describe("ISO 8601 start time."),
      end_time: z.string().describe("ISO 8601 end time."),
      is_private: z.boolean().optional(),
      exercises: z.array(workoutExercise),
    },
    (w, hevy) => hevy.createWorkout(w),
  );

  reg(
    server,
    ctx,
    "update_workout",
    "Replace an existing workout's contents (full overwrite of the provided fields). Hevy has no undo: sets you leave out are gone. Read the workout first and send everything you want kept.",
    {
      workoutId: z.string(),
      title: z.string(),
      description: z.string().nullable().optional(),
      start_time: z.string(),
      end_time: z.string(),
      is_private: z.boolean().optional(),
      exercises: z.array(workoutExercise),
    },
    ({ workoutId, ...workout }, hevy) => hevy.updateWorkout(workoutId, workout),
  );

  reg(
    server,
    ctx,
    "create_routine",
    "Create a saved routine (workout template). Pass folder_id to file it, or omit/null for the default folder.",
    {
      title: z.string(),
      folder_id: z.number().nullable().optional(),
      notes: z.string().optional(),
      exercises: z.array(routineExercise),
    },
    (r, hevy) => hevy.createRoutine(r),
  );

  reg(
    server,
    ctx,
    "create_routine_folder",
    "Create a new routine folder (inserted at the top; existing folders shift down).",
    { title: z.string() },
    ({ title }, hevy) => hevy.createRoutineFolder(title),
  );

  reg(
    server,
    ctx,
    "create_exercise_template",
    "Create a custom exercise template. exercise_type / equipment_category / muscle_group are validated server-side by Hevy; an error response lists valid values if one is off.",
    {
      title: z.string(),
      exercise_type: z
        .string()
        .describe('Hevy CustomExerciseType, e.g. "weight_reps", "reps_only", "duration", "distance".'),
      equipment_category: z
        .string()
        .describe('e.g. "barbell", "dumbbell", "machine", "bodyweight", "cable", "other".'),
      muscle_group: z.string().describe('Primary muscle, e.g. "chest", "back", "legs", "biceps".'),
      other_muscles: z.array(z.string()).optional(),
    },
    (e, hevy) => hevy.createExerciseTemplate(e),
  );

  const cm = (what: string) => z.number().nullable().optional().describe(`${what}, in centimetres.`);
  reg(
    server,
    ctx,
    "create_body_measurement",
    "Record a body measurement for a date (YYYY-MM-DD). Weights in kg, circumferences in centimetres. One entry per date — fails with 409 if the date already exists.",
    {
      date: z.string().describe("YYYY-MM-DD"),
      weight_kg: z.number().nullable().optional().describe("Body weight, in kilograms."),
      lean_mass_kg: z.number().nullable().optional().describe("Lean mass, in kilograms."),
      fat_percent: z.number().nullable().optional().describe("Body fat, percent."),
      neck_cm: cm("Neck"),
      shoulder_cm: cm("Shoulders"),
      chest_cm: cm("Chest"),
      left_bicep_cm: cm("Left bicep"),
      right_bicep_cm: cm("Right bicep"),
      left_forearm_cm: cm("Left forearm"),
      right_forearm_cm: cm("Right forearm"),
      abdomen_cm: cm("Abdomen"),
      waist_cm: cm("Waist"),
      hips_cm: cm("Hips"),
      left_thigh_cm: cm("Left thigh"),
      right_thigh_cm: cm("Right thigh"),
      left_calf_cm: cm("Left calf"),
      right_calf_cm: cm("Right calf"),
    },
    ({ abdomen_cm, waist_cm, hips_cm, left_thigh_cm, right_thigh_cm, left_calf_cm, right_calf_cm, ...rest }, hevy) =>
      // Hevy's wire format leaves these seven unsuffixed; the model-facing names carry the unit.
      hevy.createBodyMeasurement({
        ...rest,
        abdomen: abdomen_cm,
        waist: waist_cm,
        hips: hips_cm,
        left_thigh: left_thigh_cm,
        right_thigh: right_thigh_cm,
        left_calf: left_calf_cm,
        right_calf: right_calf_cm,
      }),
  );

  return server;
}
