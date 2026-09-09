// Offline smoke test for herd-core: loads a fixture and exercises the query + rules.
// Run: HERD_FARMDATA=fixture.json HERD_REFERENCE=fixture-ref.json node smoke-test.mjs
import { loadFromFiles } from "./herd-core.mjs";
const farm = process.env.HERD_FARMDATA || "example.farmdata.json";
const ref = process.env.HERD_REFERENCE || "example.reference.json";
const h = await loadFromFiles(farm, ref);
const show = (label, v) => console.log("\n== " + label + " ==\n" + JSON.stringify(v, null, 2));
show("summary", h.summary());
show("query: count by breed", h.query({ groupBy: "breed" }));
show("query: female animals", h.query({ where: [{ field:"sex", op:"=", value:"Female" }] }));
show("recommendations", h.recommendations().map(r => ({ group:r.group, title:r.title, count:r.count })));
show("tasks (overdue)", h.tasks("overdue"));
const first = (h.data.animals||[])[0];
if(first) show("history for first animal", h.history(String(h.tagOf(first))));
