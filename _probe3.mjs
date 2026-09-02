import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
const build = () => { const s = new McpServer({name:"hevy-mcp",version:"0.2.0"}); s.registerTool("whoami",{title:"w",description:"d",inputSchema:z.object({})},(async()=>({content:[{type:"text",text:"ok"}]}))); return s; };
const handler = createMcpHandler(() => build(), { route: "/mcp" });
const ctx = { props: { v:2 }, waitUntil(){}, passThroughOnException(){} };
async function go(label, url, method, headers, body) {
  const r = await handler(new Request(url,{method,headers,...(body?{body:JSON.stringify(body)}:{})}),{},ctx);
  console.log(label, "->", r.status, (await r.text()).slice(0,140));
}
const init = {jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"x",version:"1"}}};
const H = (extra={}) => ({ "content-type":"application/json", accept:"application/json, text/event-stream", host:"hevy.kevinhg.com", ...extra });
await go("prod POST no Origin        ", "https://hevy.kevinhg.com/mcp","POST",H(),init);
await go("prod POST Origin claude.ai ", "https://hevy.kevinhg.com/mcp","POST",H({origin:"https://claude.ai"}),init);
await go("prod POST Origin chatgpt   ", "https://hevy.kevinhg.com/mcp","POST",H({origin:"https://chatgpt.com"}),init);
await go("prod OPTIONS preflight     ", "https://hevy.kevinhg.com/mcp","OPTIONS",{host:"hevy.kevinhg.com",origin:"https://claude.ai","access-control-request-method":"POST"});
await go("prod POST Origin null      ", "https://hevy.kevinhg.com/mcp","POST",H({origin:"null"}),init);
await go("prod POST Origin vscode    ", "https://hevy.kevinhg.com/mcp","POST",H({origin:"vscode-file://vscode-app"}),init);
// workers.dev variant
const HW = (extra={}) => ({ "content-type":"application/json", accept:"application/json, text/event-stream", host:"hevy-mcp.kevinhg.workers.dev", ...extra });
await go("workers.dev POST no Origin ", "https://hevy-mcp.kevinhg.workers.dev/mcp","POST",HW(),init);
await go("workers.dev wrong Host     ", "https://hevy-mcp.kevinhg.workers.dev/mcp","POST",HW({host:"evil.com"}),init);
