#!/usr/bin/env node
// herd-mcp.mjs — a local, read-only MCP server exposing your own Herdwatch herd to an
// MCP client (Claude Desktop, ChatGPT, etc.). It runs on YOUR machine; your Herdwatch
// login and herd data never leave it except in the answers your assistant asks for.
//
// Config via environment variables:
//   HERD_PHONE, HERD_PASSWORD   your Herdwatch login (a per-region phone number + password)
//   HERD_REGION                 region code, default "IE"
//   HERD_HOST                   override the API host (default mc<region>-prod.hwbe.io)
//   HERD_VERSION                app version string for the version gate (default 9.9.28)
//   HERD_FARMDATA, HERD_REFERENCE   OR point at exported farmdata.json / reference.json
//                                   to run fully offline from a saved sync (no login)
//
// The herd is loaded once at startup and cached; set HERD_REFRESH_MINUTES to re-sync.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadFromFiles, loadFromApi } from "./herd-core.mjs";

let herd = null, loadedAt = 0;
const refreshMs = (Number(process.env.HERD_REFRESH_MINUTES) || 0) * 60000;

async function load(){
  if(process.env.HERD_FARMDATA) return loadFromFiles(process.env.HERD_FARMDATA, process.env.HERD_REFERENCE);
  if(!process.env.HERD_PHONE || !process.env.HERD_PASSWORD)
    throw new Error("Set HERD_PHONE and HERD_PASSWORD (or HERD_FARMDATA) — see the README.");
  return loadFromApi({ phone: process.env.HERD_PHONE, password: process.env.HERD_PASSWORD,
    region: process.env.HERD_REGION, host: process.env.HERD_HOST, version: process.env.HERD_VERSION });
}
async function getHerd(){
  if(!herd || (refreshMs && Date.now() - loadedAt > refreshMs)){ herd = await load(); loadedAt = Date.now(); }
  return herd;
}
const ok = obj => ({ content: [{ type:"text", text: JSON.stringify(obj, null, 2) }] });
const fail = e => ({ isError:true, content:[{ type:"text", text: "Error: " + (e?.message || String(e)) }] });

const server = new McpServer({ name:"herd", version:"1.0.0" });

const whereShape = z.array(z.object({
  field: z.string(), op: z.enum(["=","!=",">",">=","<","<=","contains","empty","notempty"]), value: z.any().optional()
})).optional();

server.tool("herd_summary", "Herd size, species, available datasets and the detected key fields.",
  {}, async () => { try { return ok((await getHerd()).summary()); } catch(e){ return fail(e); } });

server.tool("query_herd",
  "Exact counts, filtered lists, group breakdowns or aggregates over the herd. Always use this for numbers.",
  { entity: z.string().optional(), where: whereShape, groupBy: z.string().optional(),
    metric: z.object({ op: z.enum(["count","avg","sum","min","max"]), field: z.string().optional() }).optional() },
  async (a) => { try { return ok((await getHerd()).query(a)); } catch(e){ return fail(e); } });

server.tool("get_animal", "The full record for one animal, by tag or id, with codes and references resolved to names.",
  { tag: z.string() },
  async ({ tag }) => { try { const h = await getHerd(); const a = h.findAnimal(tag); return a ? ok(h.animalRecord(a)) : fail(new Error("no animal matching " + tag)); } catch(e){ return fail(e); } });

server.tool("history_for", "A date-sorted timeline of records (weights, treatments, …) that reference one animal.",
  { tag: z.string() },
  async ({ tag }) => { try { return ok((await getHerd()).history(tag)); } catch(e){ return fail(e); } });

server.tool("list_tasks", "The herd's tasks, filtered and sorted (overdue first).",
  { filter: z.enum(["open","overdue","done","all"]).optional() },
  async ({ filter }) => { try { return ok((await getHerd()).tasks(filter || "open")); } catch(e){ return fail(e); } });

server.tool("recommendations",
  "The on-device recommendation feed: jobs to do now, vet bookings to schedule, and things to watch. Computed by local rules, not guessed.",
  { group: z.enum(["now","book","watch"]).optional() },
  async ({ group }) => { try { return ok((await getHerd()).recommendations(group)); } catch(e){ return fail(e); } });

const transport = new StdioServerTransport();
await server.connect(transport);
