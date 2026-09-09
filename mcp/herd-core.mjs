// herd-core.mjs — read-only Herdwatch client + local query/rules engine for the MCP server.
// Mirrors the algorithms in the web app (index.html): auth flow, LOOKUP enum table,
// schema-adaptive field detection, the local query engine, and the recommendation rules.
// Pure data logic (Herd) is separate from network (login/sync) so it can be tested offline.

import { readFile } from "node:fs/promises";

/* ---------- small helpers (ported from the app) ---------- */
export function epochMs(v){
  if(v && typeof v === "object" && typeof v.date === "number") return v.date;
  if(typeof v === "number" && v > 1e11 && v < 4.2e12) return v;
  return null;
}
const DAY = 86400000;
function fmtDate(ms){ const d = new Date(ms); return isNaN(d) ? String(ms) : d.toISOString().slice(0,10); }
function keyLike(sample, re){ return Object.keys(sample||{}).find(k => re.test(k)); }

/* ---------- the herd model: lookup, fields, disp, query, rules ---------- */
export class Herd {
  constructor(entities, now = Date.now()){
    this.data = entities || {};
    this.now = now;
    this.lookup = new Map();
    for(const t of (this.data.system_type || [])) if(t && t.id && !this.lookup.has(t.id))
      this.lookup.set(t.id, { displayName: t.displayName || t.id, type: t.type });
    this.F = this.detectFields(this.data.animals || []);
    this.refs = this.buildRefs();
  }

  detectFields(animals){
    const s = animals[0] || {}, keys = Object.keys(s);
    const has = key => key && animals.some(a => { const v = a[key]; return v !== null && v !== undefined && v !== ""; });
    const tag = ["tag","eartag","earTag","tagNumber","officialTag","officialTagNumber","nationalId","number"].find(has)
      || keys.filter(k => /tag|ear|official|nationalid|^number$/i.test(k)).sort((a,b)=>a.length-b.length).find(has)
      || keyLike(s, /^id$/i);
    let name = keyLike(s, /^name$|herdname|petname/i); if(!has(name)) name = null;
    return { tag, name, sex: keyLike(s,/sex|gender/i), breed: keyLike(s,/^breed(id)?$/i),
      dob: keyLike(s,/dob|dateofbirth|birth/i), status: keyLike(s,/status|onfarm|state|disposal/i), mob: keyLike(s,/mob/i) };
  }
  tagOf(a){ const v = this.F.tag ? a[this.F.tag] : undefined; return (v===null||v===undefined||v==="") ? (a.id ?? "—") : v; }

  buildRefs(){
    const refs = new Map();
    for(const [entity, rows] of Object.entries(this.data)){
      if(entity === "system_type" || !Array.isArray(rows)) continue;
      const isA = entity === "animals";
      const sample = rows.find(r => r && typeof r === "object") || {};
      const nameK = isA ? null : (keyLike(sample,/^name$|^title$/i) || keyLike(sample,/name$|title$/i));
      for(const r of rows){
        if(!r || typeof r !== "object") continue;
        const label = isA ? String(this.tagOf(r))
          : (nameK && r[nameK] != null && r[nameK] !== "" ? (this.lookup.get(r[nameK])?.displayName ?? String(r[nameK])) : (r.id != null ? String(r.id) : null));
        const put = k => { if(k != null && k !== "" && label && !refs.has(String(k))) refs.set(String(k), label); };
        if(r.id != null) put(r.id);
        if(isA && this.F.tag && this.F.tag !== "id") put(r[this.F.tag]);
      }
    }
    return refs;
  }

  disp(v){
    if(v === null || v === undefined || v === "") return "—";
    const ms = epochMs(v); if(ms !== null) return fmtDate(ms);
    if(Array.isArray(v)) return v.map(x => this.disp(x)).join(", ") || "—";
    if(typeof v === "object") return "";
    if(typeof v === "string" && this.lookup.has(v)) return this.lookup.get(v).displayName;
    if(typeof v === "string" && this.refs.has(v)) return this.refs.get(v);
    if(typeof v === "boolean") return v ? "Yes" : "No";
    return String(v);
  }
  resolve(v){ return (typeof v === "string" && this.lookup.has(v)) ? this.lookup.get(v).displayName : v; }

  /* ---- query engine (mirror of runQuery / animalMatches / getNum) ---- */
  getNum(a, field){
    if(field === "ageYears" || field === "age" || field === "ageMonths"){
      const ms = this.F.dob ? epochMs(a[this.F.dob]) : null; if(ms === null) return null;
      const yrs = (this.now - ms) / (365.25 * DAY); return field === "ageMonths" ? yrs * 12 : yrs;
    }
    const ms = epochMs(a[field]); if(ms !== null) return ms;
    const n = Number(a[field]); return isNaN(n) ? null : n;
  }
  matches(a, where){
    return (where || []).every(c => {
      const ageF = c.field === "ageYears" || c.field === "ageMonths" || c.field === "age";
      const raw = ageF ? this.getNum(a, c.field) : a[c.field];
      const rv = this.resolve(raw), lc = x => String(x==null?"":x).toLowerCase();
      switch(c.op){
        case "=": return raw===c.value || lc(raw)===lc(c.value) || lc(rv)===lc(c.value);
        case "!=": return !(raw===c.value || lc(raw)===lc(c.value) || lc(rv)===lc(c.value));
        case ">": return this.getNum(a,c.field) > Number(c.value);
        case ">=": return this.getNum(a,c.field) >= Number(c.value);
        case "<": return this.getNum(a,c.field) < Number(c.value);
        case "<=": return this.getNum(a,c.field) <= Number(c.value);
        case "contains": return lc(rv).includes(lc(c.value));
        case "empty": return raw==null || raw==="";
        case "notempty": return !(raw==null || raw==="");
        default: return true;
      }
    });
  }
  agg(arr, m){
    if(!m || m.op === "count") return arr.length;
    const ns = arr.map(a => this.getNum(a, m.field)).filter(n => n!=null && !isNaN(n));
    if(!ns.length) return 0;
    const sum = ns.reduce((s,x)=>s+x,0);
    if(m.op==="avg") return Math.round(sum/ns.length*100)/100;
    if(m.op==="sum") return Math.round(sum*100)/100;
    if(m.op==="min") return Math.min(...ns);
    if(m.op==="max") return Math.max(...ns);
    return arr.length;
  }
  query(q){
    q = q || {};
    const entity = (q.entity && this.data[q.entity]) ? q.entity : "animals";
    const rows = (this.data[entity] || []).filter(a => this.matches(a, q.where));
    if(q.groupBy){
      const g = {};
      rows.forEach(a => { const k = (()=>{ const kv = this.resolve(a[q.groupBy]); return (kv==null||kv==="") ? "—" : String(kv); })(); (g[k] = g[k]||[]).push(a); });
      const m = q.metric || { op:"count" };
      const groups = Object.entries(g).map(([k,arr]) => ({ group:k, value:this.agg(arr,m) })).sort((x,y)=>y.value-x.value);
      return { entity, groupBy:q.groupBy, metric:m.op||"count", total:rows.length, groups };
    }
    if(q.metric && q.metric.op && q.metric.op !== "count"){ const o = { entity, matched:rows.length }; o[q.metric.op+"_"+(q.metric.field||"")] = this.agg(rows,q.metric); return o; }
    return { entity, matched: rows.length, sample: rows.slice(0,50).map(a => String(this.tagOf(a))) };
  }

  /* ---- one animal, full record with codes/refs resolved ---- */
  animalRecord(a){
    const out = {};
    for(const [k,v] of Object.entries(a)){ if(typeof v === "object" && v !== null && epochMs(v) === null) continue; out[k] = this.disp(v); }
    return out;
  }
  findAnimal(ref){
    ref = String(ref).toLowerCase(); const A = this.data.animals || [];
    return A.find(a => String(this.tagOf(a)).toLowerCase() === ref || String(a.id).toLowerCase() === ref)
        || A.find(a => [...this.idsOf(a)].some(k => String(k).toLowerCase() === ref)) || null;
  }

  /* ---- cross-entity matching for history + rules ---- */
  idsOf(a){
    const s = new Set(), add = v => { if(v!=null && v!=="") s.add(String(v)); };
    add(a.id); if(this.F.tag) add(a[this.F.tag]); add(this.tagOf(a));
    Object.keys(a).forEach(k => { if(/mgmt|management|shorttag|short_tag|^number$/i.test(k)) add(a[k]); });
    return s;
  }
  animalIndex(){ const idx = new Map(); (this.data.animals||[]).forEach(a => this.idsOf(a).forEach(k => { if(!idx.has(k)) idx.set(k,a); })); return idx; }
  recordAnimal(rec, idx){
    for(const k of Object.keys(rec)){ const v = rec[k];
      if((typeof v==="string"||typeof v==="number") && /animal|tag|dam|calf|beast|ear|mgmt/i.test(k) && idx.has(String(v))) return idx.get(String(v)); }
    return null;
  }
  history(ref){
    const a = this.findAnimal(ref); if(!a) return { error: "no animal matching " + ref };
    const ids = this.idsOf(a), out = [];
    for(const [entity, rows] of Object.entries(this.data)){
      if(!Array.isArray(rows) || ["animals","system_type","tasks"].includes(entity)) continue;
      for(const r of rows){
        if(!r || typeof r !== "object") continue;
        const refs = Object.keys(r).some(k => { const v = r[k]; return (typeof v==="string"||typeof v==="number") && /animal|tag|dam|calf|beast|ear|mgmt/i.test(k) && ids.has(String(v)); });
        if(!refs) continue;
        const keys = Object.keys(r);
        const dateK = keys.find(k => epochMs(r[k])!=null && /date|when|treated|weigh|recorded|given|admin/i.test(k)) || keys.find(k => epochMs(r[k])!=null);
        const nameK = keyLike(r, /product|remedy|medic|name|title|reason|type/i);
        let label = nameK ? this.disp(r[nameK]) : ""; if(!label || label === "—") label = entity.replace(/s$/,"");
        out.push({ date: dateK ? fmtDate(epochMs(r[dateK])) : null, entity, label, amount: this.measure(r) });
      }
    }
    return { animal: String(this.tagOf(a)), events: out.sort((x,y)=> (y.date||"").localeCompare(x.date||"")) };
  }
  measure(r){
    for(const k of Object.keys(r)){ const v = r[k];
      if(typeof v !== "number" || !isFinite(v)) continue;
      if(/weight|amount|qty|quantity|volume|dose|rate/i.test(k)){
        let u=""; if(/kg/i.test(k))u="kg"; else if(/ml/i.test(k))u="ml"; else if(/litre|liter|(^|[^a-z])l$/i.test(k))u="L"; else if(/(^|[^a-z])g$/i.test(k))u="g";
        return `${v}${u?" "+u:""}`;
      }
    }
    return "";
  }

  /* ---- tasks ---- */
  taskInfo(t){
    const dueK = keyLike(t,/due/i) || Object.keys(t).find(k => /date|deadline/i.test(k) && !/creat|complet|updat|modif|finish|done|sync/i.test(k));
    const stK = keyLike(t,/status|state/i), tiK = keyLike(t,/title|name|desc/i) || "id";
    const dueMs = dueK ? epochMs(t[dueK]) : null;
    const statusText = (stK && t[stK]) ? this.disp(t[stK]) : "";
    const done = /done|closed|complete/i.test(statusText);
    return { title: this.disp(t[tiK]), due: dueMs ? fmtDate(dueMs) : null, dueMs, status: statusText, done, overdue: dueMs!==null && dueMs<this.now && !done };
  }
  tasks(filter = "all"){
    return (this.data.tasks || []).map(t => this.taskInfo(t))
      .filter(i => filter==="all" ? true : filter==="overdue" ? i.overdue : filter==="done" ? i.done : /* open */ !i.done)
      .sort((a,b)=> (a.done?1:0)-(b.done?1:0) || (a.overdue?0:1)-(b.overdue?0:1) || ((a.dueMs??Infinity)-(b.dueMs??Infinity)));
  }

  /* ---- recommendation rules (mirror of computeRecs) ---- */
  signals(){
    const idx = this.animalIndex(), lastWeight = new Map(), withdrawalUntil = new Map();
    for(const [entity, rows] of Object.entries(this.data)){
      if(!Array.isArray(rows) || ["animals","system_type","tasks"].includes(entity)) continue;
      for(const r of rows){
        if(!r || typeof r !== "object") continue;
        const a = this.recordAnimal(r, idx); if(!a) continue;
        const keys = Object.keys(r);
        const wK = keys.find(k => /weight/i.test(k) && typeof r[k]==="number");
        if(wK){ const dK = keys.find(k => epochMs(r[k])!=null); const ms = dK?epochMs(r[dK]):null; if(ms!=null){ const c=lastWeight.get(a); if(c==null||ms>c) lastWeight.set(a,ms); } }
        let wd = null;
        const endK = keys.find(k => /withdraw/i.test(k) && epochMs(r[k])!=null);
        if(endK) wd = epochMs(r[endK]);
        else { const daysK = keys.find(k => /withdraw/i.test(k) && typeof r[k]==="number"); const tK = keys.find(k => /date|treat|given|admin/i.test(k) && epochMs(r[k])!=null); if(daysK && tK) wd = epochMs(r[tK]) + r[daysK]*DAY; }
        if(wd!=null){ const c = withdrawalUntil.get(a); if(c==null||wd>c) withdrawalUntil.set(a,wd); }
      }
    }
    return { lastWeight, withdrawalUntil };
  }
  onFarm(a){ const t = this.F.status ? this.disp(a[this.F.status]) : ""; return !t || t==="—" || /on.?farm|active|alive|present|current/i.test(t); }
  femaleish(a){ return !this.F.sex || /female|^f$|cow|heifer/i.test(this.disp(a[this.F.sex])); }
  recommendations(group){
    const A = this.data.animals || [], now = this.now, sig = this.signals(), recs = [];
    const daysAgo = ms => (now - ms)/DAY;
    const push = (id, grp, level, title, why, items, extra) => { if(items.length) recs.push({ id, group:grp, level, title: title(items.length), why, count: items.length, tags: items.slice(0,25).map(a=>String(this.tagOf(a))), ...(extra||{}) }); };
    const s = A[0] || {};
    const tbK = keyLike(s,/tb.?test|lasttb|tbdate|tuberc/i), serveK = keyLike(s,/serve|served|ai.?date|inseminat|mating/i),
      scanK = keyLike(s,/scan|preg.?check|^pd$/i), calvK = keyLike(s,/estcalv|expectedcalv|duecalv|calvingdue|calvingdate/i), damK = keyLike(s,/^dam$|damtag|damid|mother/i);
    const overdue = (this.data.tasks||[]).map(t=>this.taskInfo(t)).filter(i=>i.overdue);
    if(overdue.length) recs.push({ id:"overdue", group:"now", level:"alert", title:`${overdue.length} task${overdue.length>1?"s":""} overdue`, why: overdue.slice(0,2).map(t=>t.title).join(" · "), count: overdue.length, tasks: overdue.map(t=>t.title) });
    if(this.F.dob) push("wean","now","good",n=>`${n} ${n===1?"calf":"calves"} ready to wean`,"Aged 8–12 months, still on farm.",A.filter(a=>{const ms=epochMs(a[this.F.dob]);if(ms==null)return false;const m=daysAgo(ms)/30.44;return m>=8&&m<=12&&this.onFarm(a);}));
    if(sig.lastWeight.size) push("weigh","now","info",n=>`${n} not weighed in 6 months`,"Weigh at the next handling.",A.filter(a=>{const ms=sig.lastWeight.get(a);return this.onFarm(a)&&(ms==null||daysAgo(ms)>182);}));
    if(damK) push("nodam","now","info",n=>`${n} missing a dam record`,"No dam recorded.",A.filter(a=>this.onFarm(a)&&(a[damK]==null||a[damK]==="")));
    if(this.F.dob) push("cull","now","info",n=>`${n} cow${n>1?"s":""} over 12 years`,"Older breeding stock — review for culling.",A.filter(a=>{const ms=epochMs(a[this.F.dob]);return this.onFarm(a)&&ms!=null&&daysAgo(ms)/365.25>=12&&this.femaleish(a);}));
    if(tbK) push("tb","book","alert",n=>`${n} due a TB test`,"Over 11 months since the last test — needs the vet.",A.filter(a=>{const ms=epochMs(a[tbK]);return this.onFarm(a)&&(ms==null||daysAgo(ms)>330);}));
    if(serveK) push("scan","book","info",n=>`${n} to scan for pregnancy`,"Served over 12 weeks ago.",A.filter(a=>{const ms=epochMs(a[serveK]);const scanned=scanK&&a[scanK]!=null&&a[scanK]!=="";return this.onFarm(a)&&ms!=null&&daysAgo(ms)>84&&!scanned;}));
    if(sig.withdrawalUntil.size) push("withdraw","watch","alert",n=>`${n} under withdrawal`,"Do not sell or slaughter until the withdrawal period clears.",A.filter(a=>{const ms=sig.withdrawalUntil.get(a);return ms!=null&&ms>now;}));
    if(calvK) push("calve","watch","info",n=>`${n} due to calve within 3 weeks`,"Estimated calving within three weeks.",A.filter(a=>{const ms=epochMs(a[calvK]);return this.onFarm(a)&&ms!=null&&ms>now&&daysAgo(ms)>-21;}));
    const lvl = { alert:0, good:1, info:2 };
    return recs.filter(r => !group || r.group === group).sort((a,b)=> (lvl[a.level]??3)-(lvl[b.level]??3));
  }

  summary(){
    const A = this.data.animals || [];
    return { animals: A.length, entities: Object.keys(this.data).filter(k=>k!=="system_type"),
      species: [...new Set(A.map(a=>this.resolve(a.species)).filter(Boolean))], fields: this.F };
  }
}

/* ---------- loaders ---------- */
export async function loadFromFiles(farmPath, refPath){
  const merged = {};
  for(const p of [refPath, farmPath].filter(Boolean)){
    const j = JSON.parse(await readFile(p, "utf8"));
    const e = (j && j.entities) ? j.entities : j;
    for(const [k,v] of Object.entries(e)) if(Array.isArray(v)) merged[k] = (merged[k]||[]).concat(v);
  }
  return new Herd(merged);
}

// Live read-only client — same auth flow the app documents in CLAUDE.md.
export async function loadFromApi({ phone, password, region = "IE", host, version = "9.9.28" } = {}){
  host = host || `mc${region.toLowerCase()}-prod.hwbe.io`;
  const common = { source:"farmer", country:region, countryCode:region, region, deviceType:"ios", dbAdapter:"sqlite",
    version, codeVersion:version, appVersion:version, deviceId:"mcp-"+Math.random().toString(16).slice(2) };
  const post = async (path, body) => {
    const r = await fetch(`https://${host}/${path}`, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(()=>({}));
    if(j && j.error) throw new Error(j.error);
    if(r.status >= 400) throw new Error(`HTTP ${r.status}`);
    return j;
  };
  const login = await post("tlogin", { username:phone, password, countryCode:region, country:region, language:"en", version, codeVersion:version, appVersion:version, deviceType:"ios" });
  const HWKEY = login.url_token; if(!HWKEY) throw new Error("login failed (no url_token)");
  const boot = await post("api/2/", { HWKEY, ...common });
  const farm = boot.farmIds?.[0]?.id; if(!farm) throw new Error("no farm on this account");
  const ref = await post("api/2/get", { HWKEY, farm, system_type:true, lastSync:0 });
  const data = await post("api/2/get", { HWKEY, farm, system_type:false, lastSync:0 });
  const merged = {};
  for(const payload of [ref, data]){ const e = payload.entities || payload; for(const [k,v] of Object.entries(e)) if(Array.isArray(v)) merged[k] = (merged[k]||[]).concat(v); }
  return new Herd(merged);
}
