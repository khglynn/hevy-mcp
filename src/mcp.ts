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
import { HevyClient, HevyError } from "./hevy";
import { type AppEnv, log, memberKeyFor, revokeAllGrants } from "./util";

export const PROPS_VERSION = 2;

/** What a v2 grant carries. Anything else is treated as unauthenticated. */
export interface HevyProps {
  v: number;
  hevyApiKey: string;
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
 * re-run OAuth. Without that, a rotated key means a connector that looks
 * healthy and errors forever.
 */
async function fail(e: unknown, ctx: ToolContext) {
  if (e instanceof HevyError) {
    if (e.status === 401) {
      let revoked = 0;
      try {
        revoked = await revokeAllGrants(ctx.env, ctx.props.hevyUserId);
      } catch (revokeErr) {
        log("hevy.revoke_failed", { userId: ctx.props.hevyUserId, error: String(revokeErr) });
      }
      log("hevy.key_rejected", { userId: ctx.props.hevyUserId, client: ctx.props.client, revoked });
      return errorResult(
        `Your Hevy key isn't working anymore — Hevy rejected it. That usually means a new key was generated at hevy.com, which retires the old one. ` +
          `This connection has been disconnected. Remove the Hevy connector and add it again, then paste your current key. Start here: ${ctx.origin}/start`,
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
    return errorResult(`Error: ${e.message}`);
  }
  const msg = e instanceof Error ? e.message : String(e);
  return errorResult(`Error: ${msg}`);
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
      return await fail(e, ctx);
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
    "Disconnect this Hevy account from the server: revokes every grant for this person and forgets that they ever connected, so no client can use the stored key. Ask before calling this.",
    {},
    async () => {
      const revoked = await revokeAllGrants(ctx.env, ctx.props.hevyUserId);
      await Promise.all([
        ctx.env.OAUTH_KV.delete(`member:${ctx.props.hevyUserId}`),
        ctx.env.OAUTH_KV.delete(await memberKeyFor(ctx.props.hevyApiKey)),
        ctx.env.OAUTH_KV.delete(`tplcache:${ctx.props.hevyUserId}`),
      ]);
      log("user.disconnected", { userId: ctx.props.hevyUserId, revoked });
      return `Disconnected. ${revoked} connection(s) revoked and the stored key is gone with them; this server has also forgotten that you connected, so reconnecting needs an invite link again. To cut Hevy access at the source too, rotate the key at hevy.com/settings?developer. Reconnect any time: ${ctx.origin}/start`;
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
    "Get the logged history for one exercise across all workouts (progress over time).",
    {
      exerciseTemplateId: z
        .string()
        .describe("Exercise template id, from search_exercise_templates."),
    },
    ({ exerciseTemplateId }, hevy) => hevy.getExerciseHistory(exerciseTemplateId),
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

  reg(
    server,
    ctx,
    "create_body_measurement",
    "Record a body measurement for a date (YYYY-MM-DD). One entry per date — fails with 409 if the date already exists.",
    {
      date: z.string().describe("YYYY-MM-DD"),
      weight_kg: z.number().nullable().optional(),
      lean_mass_kg: z.number().nullable().optional(),
      fat_percent: z.number().nullable().optional(),
      neck_cm: z.number().nullable().optional(),
      shoulder_cm: z.number().nullable().optional(),
      chest_cm: z.number().nullable().optional(),
      left_bicep_cm: z.number().nullable().optional(),
      right_bicep_cm: z.number().nullable().optional(),
      left_forearm_cm: z.number().nullable().optional(),
      right_forearm_cm: z.number().nullable().optional(),
      abdomen: z.number().nullable().optional(),
      waist: z.number().nullable().optional(),
      hips: z.number().nullable().optional(),
      left_thigh: z.number().nullable().optional(),
      right_thigh: z.number().nullable().optional(),
      left_calf: z.number().nullable().optional(),
      right_calf: z.number().nullable().optional(),
    },
    (m, hevy) => hevy.createBodyMeasurement(m),
  );

  return server;
}
