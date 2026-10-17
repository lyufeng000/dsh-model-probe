import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProbeEngine } from '../lib/engine.js';
import { CatalogCache, CACHE_EPOCH, CACHE_VERSION } from '../lib/catalog-cache.js';
const secret='engine-fixture-secret';
function fixture(fetcher=async()=>Response.json({data:[{id:'new'}]}), extra={}) {
  const current={providers:{test:{api:'openai-completions',baseURL:'https://configured.test/v1',apiKeyEnv:'TEST_KEY',models:[{id:'old'}]},'openai-codex':{}}};
  const entry={options:{name:'@deepseek-ai/dsh-llm-pi-ai',config:current}};
  let resolves=0,reads=0;
  const ctx={configEditor:{entries:()=>[entry],configuration:()=>[{entry,inherited:{}}],edit:()=>assert.fail('must not write')},llm:{listModels:async()=>[{id:'old'}]},credentials:{resolve:async()=>{resolves++;return{value:secret};},readRecord:async key=>{assert.equal(key,'llm-pi-ai/openai-codex');reads++;return undefined;},describe:async()=>({configured:true}),describeRecord:async()=>({configured:false})}};
  const manager=new ProbeEngine(ctx,{credentialRef:x=>x,credentialKey:(a,b)=>`${a}/${b}`},{transport:{fetch:fetcher,timeoutMs:1000},catalogCache:extra.catalogCache});
  return{manager,ctx,current,counts:()=>({resolves,reads})};
}
test('engine goes idle/probing/done, computes diff, keeps profile and credentials untouched',async()=>{
  let release;const f=fixture(()=>new Promise(resolve=>{release=()=>resolve(Response.json({data:[{id:'new'}]}));}));const before=JSON.stringify(f.current);
  assert.equal((await f.manager.state()).routes[0].probe.status,'idle');const running=f.manager.probe({route:'test'});await Promise.resolve();assert.equal((await f.manager.state()).routes[0].probe.status,'probing');
  await assert.rejects(f.manager.probe({route:'test'}),{code:'PROBE_BUSY'});release();const result=await running;
  assert.deepEqual(result.diff,{declared:[],outside:['new'],missing:['old']});assert.equal((await f.manager.state()).routes[0].probe.status,'done');assert.equal(JSON.stringify(f.current),before);assert.ok(!JSON.stringify(await f.manager.state()).includes(secret));assert.deepEqual(f.counts(),{resolves:1,reads:4}); // Each state refresh reads ONLY the Codex record for local expiry classification.
});
test('explicit endpoint replacement needs confirmation before resolving any credentials',async()=>{
  const f=fixture();await assert.rejects(f.manager.probe({route:'test',baseURL:'https://another.test/v1'}),{code:'ENDPOINT_CONFIRM_REQUIRED'});assert.equal(f.counts().resolves,0);
  await f.manager.probe({route:'test',baseURL:'https://another.test/v1',confirmEndpoint:true});assert.equal(f.counts().resolves,1);
});
test('cancel and dispose abort in-flight probes; failure is sanitized',async()=>{
  for(const dispose of [false,true]){const f=fixture(()=>new Promise(()=>{}));const running=f.manager.probe({route:'test'});await Promise.resolve();if(dispose)f.manager.dispose();else assert.equal(f.manager.cancel({route:'test'}).cancelled,true);await assert.rejects(running,{code:'CANCELLED'});}
  const f=fixture(async()=>{throw Error(secret);});await assert.rejects(f.manager.probe({route:'test'}),{code:'NETWORK_ERROR'});const state=await f.manager.state();assert.equal(state.routes[0].probe.status,'failed');assert.ok(!JSON.stringify(state).includes(secret));
});
test('OpenRouter opt-in uses anonymous separate request; failure retains vendor data',async()=>{
  const requests=[];const f=fixture(async(url,init)=>{requests.push({url,headers:init.headers});if(url.startsWith('https://openrouter.ai'))return Response.json({data:[{id:'new',context_length:200}]});return Response.json({data:[{id:'new'}]});});
  let result=await f.manager.probe({route:'test'});assert.equal(requests.length,1);assert.equal(result.models[0].contextWindow,undefined);
  result=await f.manager.probe({route:'test',useOpenRouterEnrich:true});assert.equal(requests.length,3);assert.equal(requests[2].headers.authorization,undefined);assert.equal(result.models[0].sources.contextWindow,'openrouter');
  const g=fixture(async url=>{if(url.startsWith('https://openrouter.ai'))throw Error(secret);return Response.json({data:[{id:'new'}]});});result=await g.manager.probe({route:'test',useOpenRouterEnrich:true});assert.ok(result.warning);assert.equal(result.models.length,1);
});
test('Codex live probe and refreshForSettings use OAuth grant and enrich route defaults',async()=>{
  const requests=[];
  const f=fixture(async(url,init)=>{requests.push({url,headers:init.headers});return Response.json({models:[{slug:'gpt-6.1-sol',display_name:'GPT-6.1-Sol',context_window:500000,input_modalities:['text','image'],visibility:'list',supported_in_api:true}]});});
  f.manager.catalog={defaults:route=>route==='openai-codex'?{baseURL:'https://chatgpt.com/backend-api',api:'openai-codex-responses',contextWindow:272000,maxTokens:128000}:{},lookup:()=>undefined,list:()=>[{id:'gpt-6-sol'}]};
  f.ctx.credentials.readRecord=async key=>{assert.equal(key,'llm-pi-ai/openai-codex');return{kind:'grant',payload:{type:'oauth',access:secret,refresh:secret,accountId:'acc-1',expires:Date.now()+60000}};};
  const probed=await f.manager.probe({route:'openai-codex'});
  assert.equal(probed.models[0].id,'gpt-6.1-sol');
  assert.equal(probed.models[0].contextWindow,500000);
  assert.equal(probed.models[0].maxTokens,128000);
  const discovered=await f.manager.refreshForSettings({provider:'openai-codex'});
  assert.deepEqual(discovered,[{id:'gpt-6.1-sol',name:'GPT-6.1-Sol',contextWindow:500000,maxTokens:128000,input:['text','image'],inputModalities:['text','image']}]);
  await Promise.allSettled([...f.manager.refreshes.values()]);
  assert.ok(requests.length>=2);
  assert.equal(requests[0].url,'https://chatgpt.com/backend-api/codex/models?client_version=99.0.0');
});
test('a failed Codex live lookup never silently falls back to the shipped catalog',async()=>{
  const f=fixture(()=>assert.fail('no network without a login'));
  f.manager.catalog={defaults:()=>({api:'openai-codex-responses',baseURL:'https://chatgpt.com/backend-api'}),list:()=>[{id:'gpt-6-sol'}]};
  await assert.rejects(f.manager.refreshForSettings({provider:'openai-codex'},undefined,()=>assert.fail('must not return stale built-in models')),{code:'CODEX_NOT_SIGNED_IN'});
  f.manager.dispose();
});
test('settings fetch saves catalogs but waits for fresh vendor results on every retry',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'model-probe-cache-'));
  const cache=new CatalogCache(dir);
  let calls=0, release, started;
  const startedGate=new Promise(resolve=>{started=resolve;});
  const f=fixture(()=>new Promise(resolve=>{calls++;started();release=()=>resolve(Response.json({data:[{id:'saved',name:'Saved'}]}));}),{catalogCache:cache});
  const first=f.manager.refreshForSettings({provider:'test'});
  await startedGate;
  assert.equal(calls,1); release();
  assert.deepEqual((await first).map(model=>model.id),['saved']);
  const file=JSON.parse(await readFile(join(dir,'.model-probe-cache','catalogs.json'),'utf8'));
  assert.equal(file.version,CACHE_VERSION);assert.equal(file.scope.epoch,CACHE_EPOCH);
  assert.equal(file.catalogs[0].models[0].id,'saved');
  assert.equal(file.catalogs[0].route,'test');
  assert.ok(!JSON.stringify(file).includes(secret));
  let secondRelease, secondStarted;
  const secondGate=new Promise(resolve=>{secondStarted=resolve;});
  f.manager.transport={fetch:()=>new Promise(resolve=>{secondStarted();secondRelease=()=>resolve(Response.json({data:[{id:'fresh'}]}));}),timeoutMs:1000};
  let settled=false;
  const second=f.manager.refreshForSettings({provider:'test'}).then(value=>{settled=true;return value;});
  await secondGate;
  assert.equal(settled,false,'old cache must not resolve a user-triggered retry');
  secondRelease();
  assert.deepEqual((await second).map(model=>model.id),['fresh']);
  f.manager.transport={fetch:async()=>{throw new Error('offline');},timeoutMs:1000};
  await assert.rejects(f.manager.refreshForSettings({provider:'test'}),{code:'NETWORK_ERROR'});
  f.manager.dispose();
});
test('azure route rename refuses live discovery explicitly without touching credentials',async()=>{
  const f=fixture();
  f.current.providers.azure={baseURL:'https://example.openai.azure.com'};
  f.current.providers['azure-openai-responses']={baseURL:'https://example.openai.azure.com',api:'azure-openai-responses'};
  await assert.rejects(f.manager.probe({route:'azure'}),{code:'AZURE_DISCOVERY_UNSUPPORTED'});
  await assert.rejects(f.manager.refreshForSettings({provider:'azure'}),{code:'AZURE_DISCOVERY_UNSUPPORTED'});
  await assert.rejects(f.manager.refreshForSettings({provider:'azure-openai-responses'}),{code:'AZURE_DISCOVERY_UNSUPPORTED'});
  assert.deepEqual(f.counts(),{resolves:0,reads:0});
  f.manager.dispose();
});
test('Invalid Codex protocol override, prototype route and invalid switches fail before credential access',async()=>{
  const f=fixture();await assert.rejects(f.manager.probe({route:'openai-codex',api:'openai-completions'}),{code:'CODEX_MANUAL_ONLY'});await assert.rejects(f.manager.probe({route:'constructor'}),{code:'UNKNOWN_ROUTE'});await assert.rejects(f.manager.probe({route:'test',useOpenRouterEnrich:'yes'}),{code:'INVALID_REQUEST'});assert.deepEqual(f.counts(),{resolves:0,reads:0});
});
test('stored API key takes precedence over ambient ref, OAuth never sent to listing endpoint',async()=>{
  const f=fixture();delete f.current.providers.test.apiKeyEnv;f.ctx.credentials.readRecord=async()=>({kind:'api-key',key:secret});await f.manager.probe({route:'test'});assert.equal(f.counts().resolves,0);
  f.ctx.credentials.readRecord=async()=>({kind:'grant',payload:{access:secret}});await assert.rejects(f.manager.probe({route:'test'}),{code:'OAUTH_MANUAL_ONLY'});
});
