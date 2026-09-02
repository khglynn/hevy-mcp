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
import { FAVICON_DATA_URI, FAVICON_SIZE } from "./favicon";
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
  /**
   * The grant behind this request's bearer token, read off the token itself
   * (`userId:grantId:secret`, the provider's format) plus the KV key of the
   * token record that authorised this call. Lets `disconnect` revoke exactly
   * this connection without a KV list, which is eventually consistent in
   * production and can miss a grant created moments ago.
   */
  grant?: { id: string; tokenKey: string };
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
        return errorResult("Hevy rejected that request, but your key still works, so nothing changed. Try again. If it keeps failing, check that you asked for the right workout, routine, or exercise.");
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
      const inviteNote = ctx.env.MCP_INVITE_CODE ? ` Because it is a new key, the page will ask for the invite: open your original invite link, or ask ${operator} for it.` : "";
      return errorResult(
        `Your Hevy key no longer works. It may have been revoked or replaced on Hevy's Developer page. This server disconnected every app that used that key. ` +
          `To reconnect, remove and re-add the Hevy connection in your app and paste the current key.${inviteNote} Start here: ${ctx.origin}/start`,
      );
    }
    if (e.status === 403) {
      log("hevy.forbidden", { userId: ctx.props.hevyUserId });
      return errorResult("Hevy says your key is inactive. Your Hevy Pro subscription may have expired. Renew Pro, then try again with the same key.");
    }
    if (e.status === 429) {
      log("hevy.rate_limited", { userId: ctx.props.hevyUserId });
      return errorResult("Hevy is receiving too many requests. Your key is fine. Wait a minute, then try again.");
    }
    if (e.status >= 500 || e.status === 0) {
      log("hevy.upstream_failure", { userId: ctx.props.hevyUserId, status: e.status, write: isWrite });
      return errorResult(
        isWrite
          ? "Hevy did not confirm whether it saved your change. Check the Hevy app before trying again so you do not make the change twice."
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
    return errorResult(`Hevy couldn't complete that request${reason ? `: ${reason}` : ""}. Check the details and try again.`);
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/abort|timeout|network|fetch failed/i.test(msg)) {
    log("hevy.network_failure", { userId: ctx.props.hevyUserId, write: isWrite });
    return errorResult(
      isWrite
        ? "Hevy did not confirm whether it saved your change. Check the Hevy app before trying again so you do not make the change twice."
        : "Hevy didn't answer this time. Try again in a minute.",
    );
  }
  log("tool.unexpected_error", { userId: ctx.props.hevyUserId, error: msg });
  return errorResult(`Something went wrong while using Hevy. Try once more. If it happens again, tell ${operator}.`);
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
    version: "0.3.0",
    title: "Hevy",
    icons: [{ src: FAVICON_DATA_URI, mimeType: "image/png", sizes: [`${FAVICON_SIZE}x${FAVICON_SIZE}`] }],
  });

  // ===== account =====
  reg(
    server,
    ctx,
    "whoami",
    "Show which Hevy account is connected, which app is using it, and whether the app has Read only or Read + write access. Use this first when something looks wrong.",
    {},
    async () => ({
      hevy_account: ctx.props.name,
      connected_via: ctx.props.client,
      can_write: ctx.props.canWrite,
      note: ctx.props.canWrite
        ? `${ctx.props.client} can log workouts and create routines, folders, custom exercises, and body measurements. Hevy has no undo. Editing a workout replaces the saved version.`
        : `Read only. To let ${ctx.props.client} add or edit, remove the Hevy connection, add it again, and choose "Read + write": ${ctx.origin}/start`,
    }),
  );

  reg(
    server,
    ctx,
    "disconnect",
    "Disconnect this app from Hevy. Revokes this connection only; other apps using the same key keep working. Pass everywhere=true to disconnect every app that uses this key and delete the stored key. Ask the person before doing this.",
    {
      everywhere: z.boolean().optional().describe("true: disconnect every app using this key and delete the stored key. Default: only this app."),
    },
    async ({ everywhere }) => {
      if (!everywhere && ctx.grant) {
        // This call's own token record first (a direct delete, so it is gone
        // at the origin right away), then the grant, which also removes the
        // refresh token and lists the grant's other access tokens (best
        // effort). The edge cache can still honour the old token for up to a
        // minute; nothing renews it after that.
        await ctx.env.OAUTH_KV.delete(ctx.grant.tokenKey);
        await ctx.env.OAUTH_PROVIDER.revokeGrant(ctx.grant.id, ctx.props.hevyUserId);
        log("user.disconnected", { userId: ctx.props.hevyUserId, scope: "app", client: ctx.props.client });
        return `Disconnected this app. Other apps connected with the same key keep working; ask to "disconnect from Hevy everywhere" to remove them all. Reconnect anytime: ${ctx.origin}/start`;
      }
      // Asked for everywhere, or a bearer this server could not tie to one grant.
      const revoked = await revokeAllGrants(ctx.env, ctx.props.hevyUserId);
      await Promise.all([
        ctx.env.OAUTH_KV.delete(`member:${ctx.props.hevyUserId}`),
        ctx.env.OAUTH_KV.delete(await memberKeyFor(ctx.props.hevyApiKey)),
        ctx.env.OAUTH_KV.delete(`tplcache:${ctx.props.hevyUserId}`),
      ]);
      log("user.disconnected", { userId: ctx.props.hevyUserId, revoked, scope: "everywhere", unresolvedGrant: !ctx.grant });
      const legacyNote = everywhere ? "" : " (This connection could not be matched to one app, so every app was removed.)";
      const inviteNote = ctx.env.MCP_INVITE_CODE ? " You will need an invite link to reconnect." : "";
      return `Disconnected everywhere. Removed ${revoked} app connection(s).${legacyNote} This server deleted the stored key and forgot it.${inviteNote} To stop the key everywhere, also revoke it on Hevy's Developer page: https://hevy.com/settings?developer. Reconnect anytime: ${ctx.origin}/start`;
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
    "get_routine_folder",
    "Get a single routine folder by its id.",
    { folderId: z.coerce.number().int().describe("The folder id (a number, from get_routine_folders or a routine's folder_id).") },
    ({ folderId }, hevy) => hevy.getRoutineFolder(folderId),
  );

  reg(
    server,
    ctx,
    "get_exercise_template",
    "Get one exercise template by its id: name, type, equipment, muscle groups, and whether it is custom.",
    { exerciseTemplateId: z.string().describe("Exercise template id, from search_exercise_templates or a workout's exercises.") },
    ({ exerciseTemplateId }, hevy) => hevy.getExerciseTemplate(exerciseTemplateId),
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
    "get_workout_events",
    'List workout changes (updated or deleted) since a date, newest first, so a cached copy of someone\'s workouts can be brought up to date without re-reading every page. Each event is { type: "updated", workout } or { type: "deleted", id, deleted_at }.',
    {
      since: z.string().optional().describe("ISO 8601 date-time, e.g. 2026-08-01T00:00:00Z. Default: the beginning of time, which lists every workout as an 'updated' event."),
      page,
      pageSize: z.number().int().min(1).max(10).optional().describe("Events per page (default 5, max 10)."),
    },
    ({ since, page, pageSize }, hevy) => hevy.getWorkoutEvents({ since, page: page ?? 1, pageSize: pageSize ?? 5 }),
  );

  reg(
    server,
    ctx,
    "get_body_measurements",
    "List body-measurement entries (weight, body fat, circumferences), paginated.",
    { page, pageSize },
    ({ page, pageSize }, hevy) => hevy.getBodyMeasurements({ page: page ?? 1, pageSize: pageSize ?? 10 }),
  );

  reg(
    server,
    ctx,
    "get_body_measurement",
    "Get the body-measurement entry for one date (YYYY-MM-DD).",
    { date: z.string().describe("YYYY-MM-DD") },
    ({ date }, hevy) => hevy.getBodyMeasurement(date),
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
    "update_routine",
    "Replace an existing routine's contents: title, folder, notes, exercises and their sets. Hevy has no undo and no partial update, so exercises you leave out are gone. Read the routine with get_routine first and send back everything you want kept.",
    {
      routineId: z.string().describe("The routine id (UUID)."),
      title: z.string(),
      folder_id: z.number().nullable().optional().describe("Folder id, or null for the default 'My Routines' folder."),
      notes: z.string().nullable().optional(),
      exercises: z.array(routineExercise),
    },
    ({ routineId, ...routine }, hevy) => hevy.updateRoutine(routineId, routine),
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

  reg(
    server,
    ctx,
    "update_body_measurement",
    "Overwrite the body-measurement entry for a date (YYYY-MM-DD). Every field is replaced and fields you omit become empty, so read the entry first (get_body_measurement) and send back everything you want kept. Fails with 404 when no entry exists for that date; use create_body_measurement for a new date.",
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
    ({ date, abdomen_cm, waist_cm, hips_cm, left_thigh_cm, right_thigh_cm, left_calf_cm, right_calf_cm, ...rest }, hevy) =>
      // Hevy's wire format leaves these seven unsuffixed; the model-facing names carry the unit.
      hevy.updateBodyMeasurement(date, {
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
