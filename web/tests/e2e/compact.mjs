// Run from repo root: node web/tests/e2e/compact.mjs
// Failure matrix is in ../compaction.test.mjs; this exercises the complete
// browser -> API -> real CPA-format log path without network mocks.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync, openSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const root = process.cwd();
const dir = resolve(".cache/compact-e2e");
for (const path of [dir, `${dir}/tmp`, `${dir}/sockets`]) mkdirSync(path,{recursive:true});
const fixtureDir = mkdtempSync(`${dir}/fixture-`);
const env = {...process.env, TMPDIR:`${dir}/tmp`, GOCACHE:resolve(".cache/go-build"), GOMODCACHE:resolve(".cache/go-mod"), COMPACT_E2E_DIR:fixtureDir,
 AGENT_BROWSER_SOCKET_DIR:`${dir}/sockets`, AGENT_BROWSER_SESSION:"compact-e2e", AGENT_BROWSER_PROFILE:`${dir}/chrome`,
 AGENT_BROWSER_DOWNLOAD_PATH:`${dir}/downloads`, AGENT_BROWSER_SCREENSHOT_DIR:dir,
 XDG_CACHE_HOME:`${dir}/xdg-cache`, XDG_CONFIG_HOME:`${dir}/xdg-config`};
function run(cmd,args,options={}) {
 const p=spawnSync(cmd,args,{env,encoding:"utf8",maxBuffer:10*1024*1024,...options});
 if(p.status!==0) throw new Error(`${cmd} ${args.join(" ")}: ${p.stderr || p.stdout}`);
 return p.stdout;
}
const browser=(...args)=>run("agent-browser",args);
function evaluate(code) { return JSON.parse(run("agent-browser",["eval","--stdin","--json"],{input:code})).data.result; }
const results=[];
let server;
try {
 writeFileSync(`${dir}/build.txt`,run("npm",["run","build"],{cwd:`${root}/web`}));
 run("go",["build","-o",`${dir}/server`,"./web/tests/e2e/compact-server.go"]);
 server=spawn(`${dir}/server`,[],{env,stdio:["ignore",openSync(`${dir}/server.txt`,"w"),"inherit"]});
 for(let i=0;i<100;i++){try{if((await fetch("http://127.0.0.1:18328/healthz")).ok)break;}catch{} await new Promise(r=>setTimeout(r,100));}
 browser("open","http://127.0.0.1:18328/usage/events?range=all");
 browser("set","viewport","1440","900");
 browser("wait","--fn",'document.querySelector(\'table [data-request-id="v2"][data-request-kind="compact"]\') !== null');
 assert.equal(evaluate('document.querySelector("[role=dialog]") !== null'),false,"list detection must not open a log");
 for(const [id,kind] of [["legacy","compact"],["failed","compact"],["delta","compact"],["replay","normal"],["ws","contains_compact"]]) {
  browser("wait","--fn",`document.querySelector('table [data-request-id="${id}"][data-request-kind="${kind}"]') !== null`);
 }
 browser("screenshot",`${dir}/events-auto.png`);
 writeFileSync(`${dir}/events-auto-snapshot.txt`,browser("snapshot"));
 results.push({case:"events-automatic-classification-without-opening-logs",passed:true});
 // Failure cases: whole-log size cap, input truncation before the trigger,
 // output truncation before a checkpoint, and missing-response false negatives.
 for(const [id,kind] of [["large-normal","normal"],["large-compact","compact"],["large-output","compact"],["canceled","unknown"]]) {
  browser("wait","--fn",`document.querySelector('table [data-request-id="${id}"][data-request-kind="${kind}"]') !== null && !document.querySelector('main [role="status"]')`);
  results.push({case:`events-${id}`,passed:true});
 }
 browser("screenshot",`${dir}/events-large-logs.png`);
 for(const id of ["legacy","v2","ws","failed","delta","replay"]) {
  browser("open",`http://127.0.0.1:18328/usage/events?range=all&request_id=${id}`);
  browser("set","viewport","1280","900");
  browser("wait","--text","Request log");
  browser("find","role","button","click","--name","Final","--exact");
  browser("wait","500");
  const text=evaluate('document.querySelector("[role=dialog]").innerText');
  if(id==="replay") { assert(!text.includes("Compaction result")); assert(text.includes("Old answer to compress")); }
  else {
   assert(text.includes("Compaction result"),`${id}: missing compaction view`);
   if(["legacy","v2","ws"].includes(id)) {
    assert(text.includes("Encrypted compaction"));
    assert(!text.includes("opaque-test-ciphertext"));
    assert(text.includes("Compacted / replaced input"));
    browser("scrollintoview",'section[aria-label="Compaction result"] details:first-of-type summary');
    browser("click",'section[aria-label="Compaction result"] details:first-of-type summary');
    browser("wait","--text","Old answer to compress");
    assert(evaluate('document.querySelector("[role=dialog]").innerText').includes("Old answer to compress"));
   }
   if(id==="delta") assert(text.includes("Compression range unavailable"));
   if(id==="failed") assert(text.includes("No completed compaction result"));
  }
  browser("screenshot",`${dir}/${id}.png`);
  writeFileSync(`${dir}/${id}-snapshot.txt`,browser("snapshot"));
  if(id==="v2") {
   browser("find","role","button","click","--name","Response 200","--exact");
   assert(evaluate('document.querySelector("[role=dialog]").innerText').includes("Compaction result"));
   browser("find","role","button","click","--name","Close","--exact");
   assert(evaluate('document.body.innerText').includes("Compact"), "event badge remains after closing its log");
  }
  results.push({case:id,passed:true});
 }
 browser("set","viewport","390","844");
 browser("open","http://127.0.0.1:18328/usage/sessions?key=request:v2");
 browser("wait","--text","Compaction result");
 assert(evaluate('document.documentElement.scrollWidth <= innerWidth'));
 browser("screenshot",`${dir}/mobile.png`);
 results.push({case:"mobile-session",passed:true});
 browser("open","http://127.0.0.1:18328/usage/sessions?key=session:compact-e2e");
 browser("find","role","button","click","--name","Read request v2","--exact");
 browser("wait","--text","Compaction result");
 browser("find","role","button","click","--name","Read request v2","--exact");
 assert(evaluate('document.querySelector(\'[data-request-key="request:v2"] button\').innerText').includes("Compact"));
 browser("screenshot",`${dir}/session-badge.png`);
 results.push({case:"collapsed-session-badge",passed:true});
 renameSync(`${fixtureDir}/logs`,`${fixtureDir}/saved-logs`);
 browser("open","http://127.0.0.1:18328/usage/events?range=all");
 browser("wait","--fn",'document.querySelector(\'article [data-request-id="v2"][data-request-kind="compact"]\') !== null');
 assert.equal(evaluate('document.querySelector("[role=dialog]") !== null'),false);
 browser("screenshot",`${dir}/events-cached-mobile.png`);
 results.push({case:"events-cached-mobile-after-logs-unavailable",passed:true});
} catch(error) {
 results.push({passed:false,error:error.stack}); process.exitCode=1;
 try { writeFileSync(`${dir}/failure-snapshot.txt`,browser("snapshot")); browser("screenshot",`${dir}/failure.png`); } catch {}
}
finally {
 writeFileSync(`${dir}/results.json`,JSON.stringify({at:new Date().toISOString(),results},null,2));
 try{browser("close");}catch{}
 server?.kill();
}
console.log(JSON.stringify(results,null,2));
