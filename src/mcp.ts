/**
 * Hevy MCP tools. Registered onto an McpServer in src/index.ts.
 *
 * Design notes:
 *  - All Hevy calls go through HevyClient (pagination + 429 backoff live there).
 *  - Every handler is wrapped: Hevy API errors come back as readable tool
 *    errors (isError: true) instead of failing silently.
 *  - Reads work from both Claude and ChatGPT. Writes work from Claude; from
 *    ChatGPT they require a Business/Enterprise plan (Plus/Pro is read-only).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HevyClient, HevyError } from "./hevy";

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

function fail(e: unknown) {
  const msg =
    e instanceof HevyError ? e.message : e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

/** Register a tool whose handler is auto-wrapped with ok()/fail(). */
function reg<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  shape: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
) {
  const callback = async (args: any) => {
    try {
      return ok(await handler(args));
    } catch (e) {
      return fail(e);
    }
  };
  // Cast only at this boundary: the generic wrapper above erases the exact
  // arg/return types the SDK's registerTool callback expects. The runtime
  // shape (ok()/fail()) is a valid CallToolResult.
  server.registerTool(name, { description, inputSchema: shape }, callback as never);
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

// ---------- registration ----------
export function registerHevyTools(server: McpServer, env: Env) {
  const hevy = new HevyClient(env.HEVY_API_KEY);

  // ===== reads =====
  reg(server, "get_user_info", "Get the authenticated Hevy user's basic info.", {}, () =>
    hevy.getUserInfo(),
  );

  reg(
    server,
    "get_workout_count",
    "Get the total number of workouts on the account.",
    {},
    () => hevy.getWorkoutCount(),
  );

  reg(
    server,
    "get_workouts",
    "List workouts, newest first, paginated. Each workout includes its exercises and sets (weight_kg, reps, rpe, etc.).",
    { page, pageSize },
    ({ page, pageSize }) =>
      hevy.getWorkouts({ page: page ?? 1, pageSize: pageSize ?? 5 }),
  );

  reg(
    server,
    "get_workout",
    "Get a single workout by its id, with full exercise and set detail.",
    { workoutId: z.string().describe("The workout id (UUID).") },
    ({ workoutId }) => hevy.getWorkout(workoutId),
  );

  reg(
    server,
    "get_routines",
    "List saved routines (workout templates), paginated.",
    { page, pageSize },
    ({ page, pageSize }) =>
      hevy.getRoutines({ page: page ?? 1, pageSize: pageSize ?? 5 }),
  );

  reg(
    server,
    "get_routine",
    "Get a single routine by its id.",
    { routineId: z.string().describe("The routine id (UUID).") },
    ({ routineId }) => hevy.getRoutine(routineId),
  );

  reg(
    server,
    "get_routine_folders",
    "List routine folders (used to organize routines), paginated.",
    { page, pageSize },
    ({ page, pageSize }) =>
      hevy.getRoutineFolders({ page: page ?? 1, pageSize: pageSize ?? 5 }),
  );

  reg(
    server,
    "search_exercise_templates",
    "Find exercise templates by name (case-insensitive). Returns matches with their exercise_template_id — the id you need to log a workout or build a routine. Omit `query` to list templates.",
    {
      query: z.string().optional().describe('Substring of the exercise title, e.g. "bench".'),
      limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)."),
    },
    ({ query, limit }) => hevy.searchExerciseTemplates({ query, limit }),
  );

  reg(
    server,
    "get_exercise_history",
    "Get the logged history for one exercise across all workouts (progress over time).",
    {
      exerciseTemplateId: z
        .string()
        .describe("Exercise template id, from search_exercise_templates."),
    },
    ({ exerciseTemplateId }) => hevy.getExerciseHistory(exerciseTemplateId),
  );

  reg(
    server,
    "get_body_measurements",
    "List body-measurement entries (weight, body fat, circumferences), paginated.",
    { page, pageSize },
    ({ page, pageSize }) =>
      hevy.getBodyMeasurements({ page: page ?? 1, pageSize: pageSize ?? 10 }),
  );

  // ===== writes (Claude: full; ChatGPT: Business/Enterprise only) =====
  reg(
    server,
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
    (w) => hevy.createWorkout(w),
  );

  reg(
    server,
    "update_workout",
    "Replace an existing workout's contents (full overwrite of the provided fields).",
    {
      workoutId: z.string(),
      title: z.string(),
      description: z.string().nullable().optional(),
      start_time: z.string(),
      end_time: z.string(),
      is_private: z.boolean().optional(),
      exercises: z.array(workoutExercise),
    },
    ({ workoutId, ...workout }) => hevy.updateWorkout(workoutId, workout),
  );

  reg(
    server,
    "create_routine",
    "Create a saved routine (workout template). Pass folder_id to file it, or omit/null for the default folder.",
    {
      title: z.string(),
      folder_id: z.number().nullable().optional(),
      notes: z.string().optional(),
      exercises: z.array(routineExercise),
    },
    (r) => hevy.createRoutine(r),
  );

  reg(
    server,
    "create_routine_folder",
    "Create a new routine folder (inserted at the top; existing folders shift down).",
    { title: z.string() },
    ({ title }) => hevy.createRoutineFolder(title),
  );

  reg(
    server,
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
    (e) => hevy.createExerciseTemplate(e),
  );

  reg(
    server,
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
    (m) => hevy.createBodyMeasurement(m),
  );
}
