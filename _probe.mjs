import { McpServer, isCallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

const setType = z.enum(["warmup","normal","failure","dropset"]).describe("warmup | normal | failure | dropset");
const workoutSet = z.object({
  type: setType.default("normal"),
  weight_kg: z.number().nullable().optional(),
  reps: z.number().int().nullable().optional(),
  rpe: z.number().nullable().optional().describe("RPE"),
});
const workoutExercise = z.object({
  exercise_template_id: z.string(),
  superset_id: z.number().int().nullable().optional(),
  sets: z.array(workoutSet),
});
const page = z.number().int().min(1).optional().describe("Page number (default 1).");

const s = new McpServer({ name: "probe", version: "0", title: "P" });
const shape = {
  title: z.string(),
  is_private: z.boolean().optional(),
  exercises: z.array(workoutExercise),
};
s.registerTool("create_workout", { title:"Create workout", description:"d", inputSchema: z.object(shape), annotations:{ readOnlyHint:false, destructiveHint:false } }, (async (a) => ({content:[{type:"text",text:"x"}]})));
s.registerTool("get_workouts", { title:"g", description:"d", inputSchema: z.object({ page }), annotations:{readOnlyHint:true,destructiveHint:false} }, (async () => ({content:[{type:"text",text:"x"}]})));
s.registerTool("whoami", { title:"w", description:"d", inputSchema: z.object({}), annotations:{readOnlyHint:true,destructiveHint:false} }, (async () => ({content:[{type:"text",text:"x"}]})));

console.log("=== create_workout input schema ===");
console.log(JSON.stringify(s.toolInputSchemaJson("create_workout"), null, 1));
console.log("=== get_workouts ===");
console.log(JSON.stringify(s.toolInputSchemaJson("get_workouts"), null, 1));
console.log("=== whoami ===");
console.log(JSON.stringify(s.toolInputSchemaJson("whoami"), null, 1));
console.log("isCallToolResult ok():", isCallToolResult({content:[{type:"text",text:"hi"}]}));
console.log("isCallToolResult errorResult():", isCallToolResult({content:[{type:"text",text:"hi"}], isError:true}));
