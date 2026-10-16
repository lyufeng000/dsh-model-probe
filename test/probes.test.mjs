import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BYTES, probeModels, requestSpec, safeBase, parseListing } from '../lib/probes.js';
const key='fixture-secret-never-return';
const run=(api,body,extra={})=>probeModels({api,key,...extra},{fetch:async()=>Response.json(body)});

test('Google uses header authentication, filters generation methods, never infers images',async()=>{
  let request;
  const result=await probeModels({api:'google-generative-ai',key},{fetch:async(url,init)=>{request={url,init};return Response.json({models:[{name:'models/gemini-test',displayName:'Gemini',inputTokenLimit:120,outputTokenLimit:30,supportedGenerationMethods:['generateContent']},{name:'models/embed',supportedGenerationMethods:['embedContent']},null],nextPageToken:'next'});}});
  assert.equal(request.url,'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');assert.equal(request.init.headers['x-goog-api-key'],key);assert.equal(request.init.redirect,'manual');
  assert.equal(result.models.length,1);assert.equal(result.models[0].id,'gemini-test');assert.equal(result.models[0].contextWindow,120);assert.equal(result.models[0].maxTokens,30);assert.equal(result.models[0].input,undefined);assert.equal(result.incomplete,true);assert.ok(result.fetchedAt);assert.ok(!JSON.stringify(result).includes(key));
});
test('OpenAI and Anthropic standard and enriched gateway shapes',async()=>{
  const a=await run('openai-completions',{data:[{id:'a'},null,3,{id:'a'}]});assert.deepEqual(a.models,[{id:'a',sources:{id:'vendor'}}]);
  const b=await run('anthropic-messages',{data:[{id:'b',display_name:'Bee'}],has_more:true});assert.equal(b.models[0].name,'Bee');assert.equal(b.incomplete,true);
  const c=await run('openai-responses',{models:{alias:{id:'wrong',contextWindow:999,maxTokens:40,input:['text','image']},metadata:'ignore'}});assert.equal(c.models[0].id,'alias');assert.equal(c.models[0].contextWindow,999);
  const spec=requestSpec({api:'anthropic-messages',baseURL:'https://gateway.test/proxy/v1/',key});assert.equal(spec.url,'https://gateway.test/proxy/v1/models?limit=1000');assert.equal(spec.headers['anthropic-version'],'2023-06-01');assert.equal(spec.headers['x-api-key'],key);
});
test('OpenRouter reads capacities and architecture modalities without authorization when public',async()=>{
  const result=await run('openrouter',{data:[{id:'vendor/a',context_length:200,architecture:{input_modalities:['text','image','audio']},top_provider:{max_completion_tokens:40}}]});assert.equal(result.models[0].contextWindow,200);assert.deepEqual(result.models[0].input,['text','image']);assert.equal(result.models[0].maxTokens,40);assert.equal(requestSpec({api:'openrouter'}).headers.authorization,undefined);
});
test('OpenAI Codex uses backend-api/codex/models with client_version, originator and accountId, filtering hidden models',async()=>{
  let request;
  const result=await probeModels({api:'openai-codex-responses',key,accountId:'acc-123'},{fetch:async(url,init)=>{request={url,init};return Response.json({models:[{slug:'gpt-6.1-sol',display_name:'GPT-6.1-Sol',context_window:500000,input_modalities:['text','image'],visibility:'list',supported_in_api:true},{slug:'gpt-reserve',visibility:'hide',supported_in_api:true}]});}});
  assert.equal(request.url,'https://chatgpt.com/backend-api/codex/models?client_version=99.0.0');
  assert.equal(request.init.headers.authorization,`Bearer ${key}`);
  assert.equal(request.init.headers['chatgpt-account-id'],'acc-123');
  assert.equal(request.init.headers.originator,'pi');
  assert.equal(result.models.length,1);
  assert.equal(result.models[0].id,'gpt-6.1-sol');
  assert.equal(result.models[0].name,'GPT-6.1-Sol');
  assert.equal(result.models[0].contextWindow,500000);
  assert.deepEqual(result.models[0].input,['text','image']);
});
test('HTTPS only, exact loopback HTTP, no embedded credentials or URL queries/fragments',()=>{
  for(const url of ['http://example.test','ftp://127.0.0.1','https://user:password@example.test','https://example.test?key=secret','https://example.test/#secret','http://localhost.evil.test'])assert.throws(()=>safeBase(url),{code:'UNSAFE_ENDPOINT'});
  for(const url of ['http://localhost:123/v1','http://127.0.0.1/v1','http://[::1]/v1','https://example.test/v1/'])assert.ok(safeBase(url));
  assert.throws(()=>safeBase('not-url'),{code:'INVALID_ENDPOINT'});assert.throws(()=>requestSpec({api:'unknown-protocol'}),{code:'UNSUPPORTED_PROTOCOL'});
});
test('declared and streamed responses above 4 MiB fail closed',async()=>{
  for(const response of [new Response('ignored',{headers:{'content-length':String(MAX_BYTES+1)}}),new Response(new Uint8Array(MAX_BYTES+1)),new Response(new Uint8Array(MAX_BYTES+1),{headers:{'content-length':'1'}})])await assert.rejects(probeModels({api:'openai-completions'},{fetch:async()=>response}),{code:'RESPONSE_TOO_LARGE'});
});
test('non-JSON, unsupported shape, HTTP auth, other HTTP, redirect and network errors have distinct safe codes',async()=>{
  for(const [response,code] of [[new Response('secret body'),'INVALID_JSON'],[Response.json({unexpected:[]}), 'DISCOVERY_PARSE_UNSUPPORTED'],[new Response(key,{status:401}),'AUTH_FAILED'],[new Response(key,{status:503}),'HTTP_ERROR'],[new Response('',{status:302,headers:{location:'https://evil.test/?key='+key}}),'REDIRECT_REJECTED']])await assert.rejects(probeModels({api:'openai-completions',key},{fetch:async()=>response}),e=>e.code===code&&!e.message.includes(key));
  await assert.rejects(probeModels({api:'openai-completions',key},{fetch:async()=>{throw Error(key);}}),e=>e.code==='NETWORK_ERROR'&&!e.message.includes(key));
  await assert.rejects(run('openai-completions',{data:[{id:key}]}),{code:'SENSITIVE_RESPONSE'});
});
test('timeout, pre-cancel, mid-fetch cancel and stalled body all terminate',async()=>{
  await assert.rejects(probeModels({api:'openai-completions'},{fetch:()=>new Promise(()=>{}),timeoutMs:10}),{code:'TIMEOUT'});
  const aborted=new AbortController();aborted.abort();let fetched=false;await assert.rejects(probeModels({api:'openai-completions',signal:aborted.signal},{fetch:()=>{fetched=true;}}),{code:'CANCELLED'});assert.equal(fetched,false);
  const mid=new AbortController();await assert.rejects(probeModels({api:'openai-completions',signal:mid.signal},{fetch:()=>{queueMicrotask(()=>mid.abort());return new Promise(()=>{});}}),{code:'CANCELLED'});
  let cancelled=false;await assert.rejects(probeModels({api:'openai-completions'},{fetch:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}})),timeoutMs:10}),{code:'TIMEOUT'});assert.ok(cancelled);
});
test('invalid credential header never reaches fetch; malformed Google is distinct',async()=>{
  await assert.rejects(probeModels({api:'openai-completions',key:'bad\r\nkey'}),{code:'INVALID_CREDENTIAL'});
  assert.throws(()=>parseListing({data:[]},'google-generative-ai'),{code:'DISCOVERY_PARSE_UNSUPPORTED'});
});
