import test from "node:test";
import assert from "node:assert/strict";
import { splitRequestContext, sessionResponse, responseBodyContent } from "../src/lib/sessionContent.ts";
import { extractRequestTurns, extractResponseStream, extractResponseJSON } from "../src/lib/protocol.ts";

test("Responses string input is readable with instructions kept as context", () => {
 const turns = extractRequestTurns(JSON.stringify({instructions:"Be brief",input:"Plan the project"}));
 const split = splitRequestContext(turns);
 assert.equal(split.context[0].role,"system");
 assert.equal(split.input[0].text,"Plan the project");
});
test("latest tool results stay together and earlier conversation remains accessible", () => {
 const turns = extractRequestTurns(JSON.stringify({messages:[{role:"user",content:"Find files"},{role:"assistant",tool_calls:[{id:"a",type:"function",function:{name:"ls",arguments:"{}"}}]},{role:"tool",tool_call_id:"a",content:"first"},{role:"tool",tool_call_id:"b",content:"second"}]}));
 const split = splitRequestContext(turns);
 assert.equal(split.context.length,2);
 assert.deepEqual(split.input.map(t=>t.role),["tool","tool"]);
 assert.equal(split.context.length+split.input.length,turns.length);
 assert.deepEqual(splitRequestContext([]),{context:[],input:[]});
 assert.equal(extractRequestTurns('{"input":'),null);
});
test("final response wins; fallback is explicitly upstream and preserves truncation", () => {
 const entry = {response_body:"final",response_body_truncated:true,api_responses:[{status:200,body:"success"},{status:500,body:"failure",body_truncated:true}]};
 assert.deepEqual(sessionResponse(entry),{body:"final",upstream:false,truncated:true});
 assert.deepEqual(sessionResponse({...entry,response_body:""}),{body:"failure",upstream:true,truncated:true});
 assert.deepEqual(sessionResponse({response_body:"",api_responses:[]}),{body:"",upstream:false,truncated:false});
});
test("streaming response is merged for reading", () => {
 const stream = extractResponseStream('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\ndata: {"choices":[{"delta":{"content":"world"}}]}\n\ndata: [DONE]\n');
 assert.equal(stream.detected,true);
 assert.equal(stream.content,"Hello world");
});

test("CPA final response headers are excluded from organized content", () => {
 const body = '{"output_text":"Done"}';
 assert.equal(responseBodyContent('Status: 200\r\nContent-Type: application/json\r\nX-Request-ID: r1\r\n\r\n'+body),body);
 assert.equal(responseBodyContent('Status: 204'), '');
 assert.equal(responseBodyContent('Status: 200\nContent-Type: application/json'), '');
 assert.equal(responseBodyContent(body), body);
 assert.equal(responseBodyContent('Status: ongoing\n\nKeep this text'), 'Status: ongoing\n\nKeep this text');
 const entry = {response_body:'Status: 200\nContent-Type: application/json\n\n'+body, response_body_truncated:false,api_responses:[]};
 assert.deepEqual(sessionResponse(entry),{body,upstream:false,truncated:false});
});

test("JSON Responses content is organized with real CPA response envelopes", () => {
 const message = {output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"Here is the plan."}]}]};
 assert.equal(extractResponseJSON('Status: 200\nContent-Type: application/json\n\n'+JSON.stringify(message)).content, 'Here is the plan.');
 assert.equal(extractResponseJSON('{"output_text":"SDK snapshot"}').content, 'SDK snapshot');
 assert.equal(extractResponseJSON('{"output":['),null);
});
