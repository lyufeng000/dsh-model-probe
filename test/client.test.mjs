import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../lib/client.js',import.meta.url),'utf8');
function setup(call=async()=>({ok:true,value:{version:1,routes:[]}})) {
  let module, registered, effect;
  const React={createElement:(tag,props,...children)=>({tag,props,children}),useState:initial=>[initial,()=>{}],useRef:initial=>({current:initial}),useEffect:fn=>{effect=fn;}};
  vm.runInNewContext(source,{window:{__ModuleLoader__:{load:entry=>{module=entry.factory(name=>{assert.equal(name,'react');return React;});}}}});
  module.apply({slots:{inject:(key,cb)=>{assert.equal(key,'settings.section');cb();},register:(props,component)=>{registered={props,component};}},connection:{rpc:{call}}});
  return {registered,React,get effect(){return effect;}};
}
test('client registers additive settings section and stable inject identity', () => {
  const {registered}=setup(); assert.equal(registered.props.id,'model-probe'); assert.equal(registered.props.label,'模型探测'); assert.equal(registered.props.order,18);
  assert.equal(registered.props.inject(),registered.props.inject());
  const tree=registered.component(registered.props.inject()); assert.ok(JSON.stringify(tree).includes('模型探测'));
});
test('client transports through exact API route and detects Host version skew', async () => {
  const f=setup(async(channel,method)=>{assert.equal(channel,'/api');assert.equal(method,'model-probe/state');return {ok:true,value:{version:2}};});
  await assert.rejects(f.registered.props.inject().api('state',{}),/版本不一致/);
});
test('404/405 gives full restart instructions; generic transport errors do not leak', async () => {
  for(const status of [404,405]) {const f=setup(async()=>{throw Error(`transport failure HTTP ${status}`);});await assert.rejects(f.registered.props.inject().api('state',{}),/完全退出并重新打开 DSH/);}
  const f=setup(async()=>{throw Error('secret-sentinel');}); await assert.rejects(f.registered.props.inject().api('state',{}),e=>!e.message.includes('secret-sentinel'));
});
test('primary button uses paired semantic theme tokens; no polling or ESM imports', () => {
  assert.match(source,/background:var\(--dsw-alias-label-primary,#222\);color:var\(--dsw-alias-bg-base,#fff\)/);
  assert.doesNotMatch(source,/setInterval|^import\s/m);
});
