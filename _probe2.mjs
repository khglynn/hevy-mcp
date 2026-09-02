import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const setType = z.enum(["warmup","normal","failure","dropset"]);
const workoutSet = z.object({ type: setType.default("normal"), reps: z.number().int().nullable().optional() });
const workoutExercise = z.object({ exercise_template_id: z.string(), sets: z.array(workoutSet) });

let seen = null;
function build() {
  const s = new McpServer({ name: "hevy-mcp", version: "0.2.0", title: "Hevy" });
  s.registerTool("create_workout", { title:"c", description:"d", inputSchema: z.object({ title: z.string(), exercises: z.array(workoutExercise) }) },
    (async (args) => { seen = args; return { content:[{type:"text",text:"ok"}] }; }));
  s.registerTool("get_workouts", { title:"g", description:"d", inputSchema: z.object({ page: z.number().int().min(1).optional() }) },
    (async (args) => { seen = args; return { content:[{type:"text",text:"ok"}] }; }));
  return s;
}
const handler = createMcpHandler(() => build(), { route: "/mcp" });
const ctx = { props: { v:2 }, waitUntil(){}, passThroughOnException(){} };

async function call(body, headers={}) {
  const req = new Request("http://localhost:8787/mcp", { method:"POST", headers:{ "content-type":"application/json", accept:"application/json, text/event-stream", host:"localhost:8787", ...headers }, body: JSON.stringify(body) });
  const res = await handler(req, {}, ctx);
  const t = await res.text();
  return { status: res.status, t: t.slice(0,600), h: Object.fromEntries(res.headers) };
}

console.log("--- initialize (2025 client) ---");
console.log(await call({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"x",version:"1"}}}));

console.log("--- notifications/initialized ---");
console.log(await call({jsonrpc:"2.0",method:"notifications/initialized"}));

console.log("--- tools/call with extra key + missing default ---");
console.log(await call({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"create_workout",arguments:{title:"t",exercises:[{exercise_template_id:"abc",sets:[{reps:5}]}],bogus:"x"}}}));
console.log("handler saw:", JSON.stringify(seen));

console.log("--- tools/call with WRONG types (page: string) ---");
console.log(await call({jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"get_workouts",arguments:{page:"two"}}}));
console.log("handler saw:", JSON.stringify(seen));

console.log("--- GET /mcp ---");
{ const r = await handler(new Request("http://localhost:8787/mcp",{method:"GET",headers:{accept:"text/event-stream",host:"localhost:8787"}}),{},ctx); console.log(r.status, (await r.text()).slice(0,200)); }
console.log("--- DELETE /mcp ---");
{ const r = await handler(new Request("http://localhost:8787/mcp",{method:"DELETE",headers:{host:"localhost:8787"}}),{},ctx); console.log(r.status, (await r.text()).slice(0,200)); }
console.log("--- POST with mcp-session-id header ---");
console.log(await call({jsonrpc:"2.0",id:4,method:"tools/list",params:{}}, {"mcp-session-id":"abc123"}));
console.log("--- POST accept: application/json only ---");
console.log(await call({jsonrpc:"2.0",id:5,method:"tools/list",params:{}}, {accept:"application/json"}));
