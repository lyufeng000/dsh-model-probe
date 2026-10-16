import test from 'node:test';
import assert from 'node:assert/strict';
import { ProbeManager, configSnapshot, revisionOf } from '../lib/state.js';
const credentialModule={credentialRef:x=>x,credentialKey:(a,b)=>`${a}/${b}`};
export function fixture() {
  const current={providers:{google:{apiKeyEnv:'GOOGLE_API_KEY',models:[{id:'g'}]},'openai-codex':{models:[{id:'c'}]},xai:{models:[{id:'x'}]}}};
  const entry={id:'include:llm-pi-ai',options:{id:'llm-pi-ai',name:'@deepseek-ai/dsh-llm-pi-ai',config:current}};
  const configEditor={entries:()=>[entry],configuration:()=>[{entry,inherited:{},override:current}],edit:()=>{throw Error('MUST NOT WRITE');}};
  const credentials={describe:async ref=>({configured:ref==='GOOGLE_API_KEY',source:'file',writable:true,value:'secret-sentinel'}),describeRecord:async key=>({configured:key==='llm-pi-ai/openai-codex',writable:true,payload:'secret-sentinel'}),resolve:()=>{throw Error('MUST NOT READ VALUE');},readRecord:()=>{throw Error('MUST NOT READ VALUE');}};
  const llm={listModels:async route=>[{provider:route,id:current.providers[route].models[0].id,name:'model',inputModalities:['text'],secret:'secret-sentinel'}]};
  return {ctx:{configEditor,credentials,llm},entry,current};
}
test('state lists current routes, exact credential refs and stored record metadata without values', async () => {
  const f=fixture(); const before=JSON.stringify(f.current); const state=await new ProbeManager(f.ctx,credentialModule).state();
  assert.equal(state.routes.length,3); assert.equal(state.routes[0].credentialRef,'GOOGLE_API_KEY'); assert.equal(state.routes[0].credential.configured,true);
  assert.equal(state.routes[1].credentialKind,'record'); assert.equal(state.routes[2].credentialRef,'XAI_API_KEY');
  assert.equal(JSON.stringify(state).includes('secret-sentinel'),false); assert.equal(JSON.stringify(f.current),before);
});
test('runtime ID prefix accepted; ambiguous and non-addressable entries rejected', () => {
  const f=fixture(); assert.equal(configSnapshot(f.ctx).entry.id,'include:llm-pi-ai');
  f.ctx.configEditor.entries=()=>[]; assert.throws(()=>configSnapshot(f.ctx),{code:'CONFIG_UNAVAILABLE'});
});
test('revision detects inherited and other-route changes', () => {
  assert.notEqual(revisionOf({x:1},{}),revisionOf({x:2},{})); assert.notEqual(revisionOf({x:1},{}),revisionOf({x:1},{y:1}));
});
test('unavailable LLM route does not leak lower-level errors', async () => {
  const f=fixture(); f.ctx.llm.listModels=async()=>{throw Error('Authorization secret-sentinel');};
  const state=await new ProbeManager(f.ctx,credentialModule).state(); assert.ok(state.routes.every(x=>!x.available)); assert.ok(!JSON.stringify(state).includes('secret-sentinel'));
});
