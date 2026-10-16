import test from "node:test";
import assert from "node:assert/strict";
import { compactionReports, isCompactEndpoint } from "../src/lib/compaction.ts";

// Failure cases: endpoint lookalikes; replayed checkpoints; configured-but-not-
// triggered auto compaction; JSON/SSE/WS envelopes; duplicate or changed items;
// missing history; errors/retries; truncated/malformed logs; multiple WS turns.
const user = { role: "user", content: "Keep my question" };
const answer = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Old answer" }] };
const checkpoint = { type: "compaction", id: "cmp-new", encrypted_content: "opaque-test-ciphertext" };
const entry = (request, response, extra = {}) => ({
  info: { URL: "/v1/responses" }, request_body: JSON.stringify(request),
  response_body: JSON.stringify(response), api_responses: [], ...extra,
});
const completed = output => ({ type: "response.completed", response: { id: "resp-new", status: "completed", output } });
const frame = (event, payload) => `Timestamp: 2026-10-16T10:00:00Z\nEvent: websocket.${event}\n${JSON.stringify(payload)}\n`;

test("legacy endpoint recognition excludes lookalikes and query mentions", () => {
  for (const path of ["/v1/responses/compact", "https://host/prefix/responses/compact/?a=1"]) assert.equal(isCompactEndpoint(path), true);
  for (const path of ["/v1/responses?next=/responses/compact", "/responses/compactness", "/v1/responses/ws", ""]) assert.equal(isCompactEndpoint(path), false);
});
test("response.compaction does not falsely claim the v2 request used the legacy endpoint", () => {
  const payload = {object:"response.compaction",output:[checkpoint]};
  assert.equal(compactionReports(entry({input:[user,{type:"compaction_trigger"}]},payload))[0].reason,"trigger");
  assert.equal(compactionReports(entry({input:[user]},payload))[0].reason,"response");
});
test("v2 trigger is recognized on ordinary responses and result keeps original roles", () => {
  const [r] = compactionReports(entry({ input: [user, answer, { type: "compaction_trigger" }] }, completed([user, checkpoint])));
  assert.equal(r.reason, "trigger");
  assert.equal(r.completed, true);
  assert.deepEqual(r.output, [user, checkpoint]);
  assert.deepEqual(r.retained, [user]);
  assert.deepEqual(r.replaced, [answer]);
});
test("replayed compaction and context_management alone are not compact requests", () => {
  assert.equal(compactionReports(entry({ input: [checkpoint, user], context_management: [{ type: "compaction", compact_threshold: 100 }] }, completed([answer]))).length, 0);
  assert.equal(compactionReports(entry({ input: [user], is_compaction: true }, completed([answer]))).length, 0);
});
test("new output checkpoints detect automatic compaction, but do not infer a full replacement window", () => {
  const [r] = compactionReports(entry({ input: [user, answer] }, completed([checkpoint, answer])));
  assert.equal(r.reason, "output");
  assert.equal(r.comparisonAvailable, false);
  assert.deepEqual(r.replaced, []);
});
test("SSE done/completed checkpoints are not duplicated, incomplete output is not success", () => {
  const stream = `data: ${JSON.stringify({type:"response.output_item.done",output_index:0,item:checkpoint})}\n\ndata: ${JSON.stringify(completed([checkpoint]))}\n\ndata: [DONE]\n`;
  const [r] = compactionReports(entry({input:[user,{type:"compaction_trigger"}]}, null, { response_body: stream }));
  assert.equal(r.output.length, 1);
  assert.equal(r.completed, true);
  const [partial] = compactionReports(entry({input:[{type:"compaction_trigger"}]}, null, {response_body:stream.split("\n\n")[0]}));
  assert.equal(partial.completed, false);
  assert.equal(partial.comparisonAvailable, false);
});
test("comparison is occurrence-aware and ignores only transport metadata, not edited content", () => {
  const duplicate = { type:"message", id:"new-id", status:"completed", role:"user",content:[{type:"input_text",text:user.content}] };
  const [r] = compactionReports(entry({input:[user,user,answer]}, {object:"response.compaction",output:[duplicate,{...answer,content:"changed"},checkpoint]}));
  assert.equal(r.retained.length,1);
  assert.deepEqual(r.replaced,[user,answer]);
});
test("missing history, invalid JSON, truncation and failed responses never claim a compression range", () => {
  const trigger = {input:[{type:"compaction_trigger"}],previous_response_id:"missing"};
  for (const e of [
    entry(trigger,completed([checkpoint])),
    entry({input:[user]},completed([checkpoint]),{request_body_truncated:true}),
    entry({input:[user,{type:"compaction_trigger"}]},completed([checkpoint]),{response_body_truncated:true}),
    entry({input:[user,{type:"compaction_trigger"}]},{error:{message:"failed"}}),
    entry({},null,{info:{URL:"/v1/responses/compact"},request_body:'{"input":[',response_body:'{"output":['}),
  ]) assert.equal(compactionReports(e)[0].comparisonAvailable,false);
});
test("final error wins over a previous successful upstream attempt", () => {
  const [r] = compactionReports(entry({input:[user,{type:"compaction_trigger"}]},{error:{message:"final failure"}}, {api_responses:[{status:200,body:JSON.stringify(completed([checkpoint]))}]}));
  assert.equal(r.completed,false);
  assert.deepEqual(r.replaced,[]);
});
test("upstream fallback is explicit and HTTP envelopes are parsed", () => {
  const [r] = compactionReports(entry({input:[user]},null,{info:{URL:"/v1/responses/compact"},response_body:"Status: 200\nContent-Type: application/json\n",api_responses:[{status:200,body:JSON.stringify({object:"response.compaction",output:[checkpoint]})}]}));
  assert.equal(r.upstream,true);
  assert.equal(r.completed,true);
});
test("WS timeline preserves each compact exchange; replay is not relabelled", () => {
  const timeline = frame("request",{type:"response.create",input:[user]}) + frame("response",completed([answer]))
    + frame("request",{type:"response.create",previous_response_id:"resp-new",input:[{type:"compaction_trigger"}]})
    + frame("response",completed([checkpoint]))
    + frame("request",{type:"response.create",input:[checkpoint,user]}) + frame("response",completed([answer]))
    + frame("request",{type:"response.create",input:[{type:"compaction_trigger"}]});
  const reports = compactionReports(entry({},null,{websocket_timeline:timeline,response_body:""}));
  assert.equal(reports.length,2);
  assert.equal(reports[0].exchange,2);
  assert.equal(reports[0].completed,true);
  assert.equal(reports[0].comparisonAvailable,false);
  assert.equal(reports[1].completed,false);
});
test("upstream websocket timeline uses api.websocket events with a Body prefix", () => {
  const timeline = 'Timestamp: 2026-10-16T10:00:00Z\nEvent: api.websocket.request\nUpstream URL: wss://example/responses\nHeaders:\nX-Test: yes\n\nBody:\n'
    + JSON.stringify({input:[user,answer,{type:"compaction_trigger"}]})+'\n'
    + frame("response",completed([checkpoint])).replace("Event: websocket.","Event: api.websocket.");
  const [r] = compactionReports(entry({input:[{type:"compaction_trigger"}]},null,{response_body:"",api_websocket_timeline:timeline}));
  assert.equal(r.upstream,true);
  assert.equal(r.completed,true);
  assert.deepEqual(r.replaced,[user,answer]);
});
test("upstream HTTP failure and WS disconnect are not successful compactions", () => {
  const [r] = compactionReports(entry({input:[user,{type:"compaction_trigger"}]},null,{response_body:"",api_responses:[{status:500,body:JSON.stringify(completed([checkpoint]))}]}));
  assert.equal(r.completed,false);
  const timeline = frame("request",{input:[user,{type:"compaction_trigger"}]})+frame("response",{type:"response.output_item.done",item:checkpoint})+frame("disconnect","EOF");
  const [ws] = compactionReports(entry({},null,{response_body:"",websocket_timeline:timeline}));
  assert.equal(ws.completed,false);
});
