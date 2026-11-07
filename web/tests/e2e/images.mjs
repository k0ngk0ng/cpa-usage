// Run: node web/tests/e2e/images.mjs
// Optional: CPA_IMAGE_SAMPLE_LOG=/path/to/log IMAGES_E2E_REMOTE=1 node ...
// Failure matrix: binary multipart corruption; repeated image[] fields; mask
// mixed with reference images; JSON edits with URL/data URL/file IDs; Images
// API b64_json/URL/SSE results; partial vs final duplication; invalid payloads;
// upstream/final mismatch; malformed multipart; remote range reads; downloads;
// mobile overflow. Uses real HTTP, SQLite, log reader and production UI.
import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,openSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const dir=resolve(process.env.IMAGES_E2E_REMOTE==='1' ? '.cache/images-e2e/remote' : '.cache/images-e2e');
for(const path of [dir,`${dir}/tmp`,`${dir}/sockets`]) mkdirSync(path,{recursive:true});
const fixture=mkdtempSync(`${dir}/fixture-`);
const env={...process.env,IMAGES_E2E_DIR:fixture,TMPDIR:`${dir}/tmp`,GOCACHE:resolve('.cache/go-build'),GOMODCACHE:resolve('.cache/go-mod'),npm_config_cache:`${dir}/npm`,
 AGENT_BROWSER_SESSION:'images-e2e',AGENT_BROWSER_SOCKET_DIR:`${dir}/sockets`,AGENT_BROWSER_PROFILE:`${dir}/chrome`,AGENT_BROWSER_DOWNLOAD_PATH:`${dir}/downloads`,AGENT_BROWSER_SCREENSHOT_DIR:dir,
 XDG_CACHE_HOME:`${dir}/xdg-cache`,XDG_CONFIG_HOME:`${dir}/xdg-config`};
function run(cmd,args,options={}) { const p=spawnSync(cmd,args,{env,encoding:'utf8',maxBuffer:10<<20,...options});if(p.status!==0)throw Error(`${cmd} ${args.join(' ')}: ${p.stderr||p.stdout}`);return p.stdout; }
const browser=(...args)=>run('agent-browser',args);
const evaluate=code=>JSON.parse(run('agent-browser',['eval','--stdin','--json'],{input:code})).data.result;
const results=[];let server;
async function verifyImages(selector,expected) {
 browser('wait','--fn',`document.querySelectorAll(${JSON.stringify(selector)}).length === ${expected.length} && Array.from(document.querySelectorAll(${JSON.stringify(selector)})).every(img => img.complete && img.naturalWidth > 0)`);
 const urls=evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(img=>img.src)`);
 for(let i=0;i<urls.length;i++) {
  const r=await fetch(urls[i]);assert(r.ok);const data=Buffer.from(await r.arrayBuffer());assert.equal(createHash('sha256').update(data).digest('hex'),expected[i]);
  if(urls[i].startsWith('http://127.0.0.1:18329/usage/')) {
   const url=new URL(urls[i]);url.searchParams.set('download','1');const download=await fetch(url);assert(download.headers.get('content-disposition')?.startsWith('attachment;'));assert.equal(createHash('sha256').update(Buffer.from(await download.arrayBuffer())).digest('hex'),expected[i]);
  }
 }
}
try {
 writeFileSync(`${dir}/build.txt`,run('npm',['run','build'],{cwd:resolve('web')}));
 run('go',['build','-o',`${dir}/server`,'./web/tests/e2e/images-server']);
 server=spawn(`${dir}/server`,[],{env,stdio:['ignore',openSync(`${dir}/server.txt`,'w'),'inherit']});
 let ready=false;for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:18329/healthz')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert(ready,'fixture did not start');
 const cases=JSON.parse(readFileSync(`${fixture}/manifest.json`));
 const eventResponse=await fetch('http://127.0.0.1:18329/usage/api/v1/usage/events?range=all');assert(eventResponse.ok);
 const events=await eventResponse.json();for(const c of cases) assert.equal(events.Items.find(item=>item.request_id===c.id).request_kind,'normal',`${c.id}: classify from endpoint before opening logs`);
 results.push({case:'image-types-before-opening-logs',passed:true});
 const logResponse=await fetch('http://127.0.0.1:18329/usage/api/v1/usage/events/multipart/log');assert(logResponse.ok);
 const {entry}=await logResponse.json();assert.equal(entry.image_request.files.length,3);
 const offsets=entry.image_request.files.map(file=>Number(new URL(file.url,'http://127.0.0.1:18329').searchParams.get('offset')));assert(offsets[0]<offsets[1] && offsets[1]<offsets[2]);
 for(const [query,status] of [['encoding=unsupported&offset=0&length=8',400],['encoding=raw&offset=0&length=8',422],['encoding=raw&offset=-1&length=8',422],['encoding=raw&offset=999999999&length=8',env.IMAGES_E2E_REMOTE==='1' ? 502 : 422]]) {
  const r=await fetch(`http://127.0.0.1:18329/usage/api/v1/usage/events/multipart/log/asset?${query}`);assert.equal(r.status,status);
 }
 results.push({case:'binary-assets-and-invalid-ranges',passed:true});
 browser('set','viewport','1440','1000');
 for(const c of cases) {
  browser('open',`http://127.0.0.1:18329/usage/events?range=all&request_id=${c.id}`);
  browser('wait','--fn','Array.from(document.querySelectorAll("[role=dialog] button")).some(button=>button.textContent==="Final")');
  browser('find','role','button','click','--name','Request','--exact');
  if(c.inputs.length) { await verifyImages('[role=dialog] [data-image-request] img',c.inputs);assert(evaluate('document.querySelector("[role=dialog]").innerText').includes(c.model)); }
  if(c.id==='json-edit') assert(evaluate('document.querySelector("[role=dialog]").innerText').includes('file-reference-only'));
  if(c.id==='multipart') { const text=evaluate('document.querySelector("[role=dialog]").innerText');for(const s of ['reference-a.png','reference-b.jpg','mask.png','参考图保持一致。','1024x1536','high']) assert(text.includes(s)); }
  if(['multipart','real-sample'].includes(c.id)) browser('screenshot',`${dir}/${c.id}-request.png`);
  for(const tab of ['Response 200','Final']) {
   browser('find','role','button','click','--name',tab,'--exact');
   await verifyImages('[role=dialog] [data-image-response] img',tab==='Final' ? c.final_outputs : c.outputs);
   if(tab==='Final' && c.inputs.length) await verifyImages('[role=dialog] [data-image-request] img',c.inputs);
   const text=evaluate('document.querySelector("[role=dialog]").innerText');
   if(c.id==='failed') assert(text.includes('Image generation blocked'));
   if(c.id==='malformed') assert(text.includes('Invalid multipart request'));
   if(c.id==='partial') assert(text.includes('completion not recorded'));
   if(c.id==='delivery-error' && tab==='Final') assert(text.includes('Final delivery failed'));
   if(c.id==='unsafe') assert(!evaluate('Array.from(document.querySelectorAll("[role=dialog] a")).some(a=>a.href.startsWith("javascript:"))'));
  }
  if(c.final_outputs.length) evaluate('document.querySelector("[data-image-response]").scrollIntoView({block:"start"})');
  browser('screenshot',`${dir}/${c.id}-final.png`);writeFileSync(`${dir}/${c.id}-snapshot.txt`,browser('snapshot'));
  results.push({case:c.id,passed:true,inputs:c.inputs.length,outputs:c.outputs.length});
 }
 browser('set','viewport','390','844');browser('open','http://127.0.0.1:18329/usage/events?range=all&request_id=multipart');
 browser('wait','--fn','Array.from(document.querySelectorAll("[role=dialog] button")).some(button=>button.textContent==="Final")');browser('find','role','button','click','--name','Final','--exact');
 await verifyImages('[role=dialog] [data-image-response] img',cases[0].outputs);
 assert(evaluate('document.documentElement.scrollWidth<=innerWidth'));assert(evaluate('document.querySelector("[role=dialog]").scrollWidth<=document.querySelector("[role=dialog]").clientWidth'));
 browser('screenshot',`${dir}/mobile.png`);results.push({case:'mobile',passed:true});
 // A known Images endpoint is not a context-compaction request. It should
 // not remain Unknown simply because its body is multipart or data[].
 const lookup=await fetch('http://127.0.0.1:18329/usage/api/v1/usage/events/request-kinds',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({request_ids:cases.slice(0,8).map(c=>c.id)})});
 assert(lookup.ok);const kinds=await lookup.json();for(const c of cases.slice(0,8)) assert.equal(kinds.items[c.id].kind,'normal',`${c.id}: Images API classification`);
 results.push({case:'image-request-types',passed:true});
}catch(error) { results.push({passed:false,error:error.stack});process.exitCode=1;try{writeFileSync(`${dir}/failure-snapshot.txt`,browser('snapshot'));browser('screenshot',`${dir}/failure.png`);}catch{} }
finally { writeFileSync(`${dir}/results.json`,JSON.stringify({at:new Date().toISOString(),remote:env.IMAGES_E2E_REMOTE==='1',fixture,results},null,2));try{browser('close');}catch{}server?.kill(); }
console.log(JSON.stringify(results,null,2));
