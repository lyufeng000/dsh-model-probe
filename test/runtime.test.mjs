import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
async function isolatedProfile(temp,prefix) { const root=await mkdtemp(join(temp,prefix)),home=join(root,'home'),profileDir=join(home,'profiles','model-probe-p0');await mkdir(profileDir,{recursive:true});await writeFile(join(profileDir,'cordis.yml'),'[]\n');return {home,profileDir}; }
import {createServer} from 'node:http';
import {join,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import * as hostPlugin from '../lib/index.js';
const runtime=process.env.DSH_MODEL_TEST_RUNTIME;
const load=runtime?specifier=>import(pathToFileURL(createRequire(join(runtime,'package.json')).resolve(specifier)).href):null;
const rpcRequest=(payload={},changes={})=>new Request('http://127.0.0.1/api/model-probe/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'probe-test',method:'model-probe/state',payload}),...changes});

test('real independent service Fibers + official authenticated HTTP + schema + cleanup', {skip:!runtime||!process.env.DSH_MODEL_TEST_ROOT,timeout:15000},async()=>{
  const {Context}=await load('@deepseek-ai/cordis');
  const connectionModule=await load('@deepseek-ai/dsh-client-connection');
  const ctx=new Context(), webRoutes=new Map(), records=new Map(), fibers=[];
  const provide=async(name,value)=>{const fiber=ctx.plugin({name:`test-${name}`,apply(c){c.provide(name,value);}});fibers.push(fiber);await fiber.await();};
  const config={providers:{google:{apiKeyEnv:'GOOGLE_API_KEY',models:[{id:'example'}]},'openai-codex':{}}};
  const {credentialKey}=await load('@deepseek-ai/dsh-credentials');
  records.set(credentialKey('llm-pi-ai','openai-codex'),{kind:'grant',payload:{type:'oauth',access:'OAUTH_ACCESS_SENTINEL',refresh:'OAUTH_REFRESH_SENTINEL',expires:Date.now()+3600000,accountId:'ACCOUNT_ID_SENTINEL'}});
  const entry={id:'include:llm-pi-ai',options:{id:'llm-pi-ai',name:'@deepseek-ai/dsh-llm-pi-ai',config}};
  const {Loader}=await load('@deepseek-ai/cordis-plugin-loader');
  const loaderFiber=ctx.plugin({name:'test-loader',apply(c){new Loader(c,{baseUrl:pathToFileURL(runtime+'/').href});}});fibers.push(loaderFiber);await loaderFiber.await();
  const boot=await load('@deepseek-ai/dsh-app-boot');
  const {home,profileDir}=await isolatedProfile(process.env.DSH_MODEL_TEST_ROOT,'runtime-http-');
  const resolution=await boot.createRuntimeResolution({installAnchor:join(runtime,'package.json'),home});
  new boot.PluginPackages(ctx,{resolution:{...resolution,profileDir,linkedRoots:[{name:'dsh-model-probe',realPath:fileURLToPath(new URL('..',import.meta.url))}]}});
  await provide('profileContext',{dir:profileDir,patchPath:join(profileDir,'cordis.patch.yml'),home,overlays:[],installAnchor:join(runtime,'package.json')});
  await provide('configEditor',{entries:()=>[entry],configuration:()=>[{entry,inherited:{},override:config}],edit:()=>{throw Error('forbidden write');}});
  await provide('llm',{listModels:async()=>[{id:'example',name:'Example',inputModalities:['text']}]});
  await provide('credentials',{
    describe:async()=>({configured:true,writable:true,source:'file',value:'NEVER_RETURN_THIS'}),describeRecord:async()=>({configured:false,writable:true}),
    readRecord:async key=>records.get(key),modifyRecord:async(key,fn)=>{const next=await fn(records.get(key));if(next!==undefined)records.set(key,next);return records.get(key);}
  });
  await provide('webServer',{register:route=>{webRoutes.set(route.path,route);return()=>webRoutes.delete(route.path);}});
  const provider=ctx.plugin(connectionModule,{trustedHosts:['127.0.0.1']});await provider.await();
  await boot.mountRootInclude(ctx,join(home,'profiles','model-probe-p0','cordis.yml'),[{insert:[{id:'model-probe-http',name:new URL('../lib/index.js',import.meta.url).href}]}],pathToFileURL(runtime+'/').href);
  await ctx.loader.await();const fiber=[...ctx.loader.entries()].find(row=>row.options.id==='model-probe-http').fiber;assert.equal(fiber.state,2);
  const connection=ctx.connection;
  const server=createServer((req,res)=>{
    if(new URL(req.url,'http://127.0.0.1').pathname.startsWith('/api/')) void webRoutes.get('/api').handler(req,res).catch(()=>{res.writeHead(500);res.end('failed');});
    else if(connection.authorizeIndex(req,res)){res.writeHead(200);res.end('index');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const login=await fetch(connection.authenticatedUrl(`${base}/`),{redirect:'manual'});
    const cookie=login.headers.get('set-cookie')?.split(';',1)[0];assert.ok(cookie);
    const body=await rpcRequest().text();
    const post=(headers={},raw=body)=>fetch(`${base}/api/model-probe/state`,{method:'POST',headers:{'content-type':'application/json',...headers},body:raw});
    assert.equal((await post()).status,401);assert.equal((await post({cookie,origin:'https://evil.invalid'})).status,403);
    const response=await post({cookie});assert.equal(response.status,200);const message=await response.json();
    assert.equal(connectionModule.serverResponseSchema.safeParse(message).success,true);assert.equal(message.result.ok,true);
    assert.equal(message.result.value.routes[0].served[0].id,'example');assert.ok(!JSON.stringify(message).includes('NEVER_RETURN_THIS'));
    assert.equal(message.result.value.routes.find(x=>x.route==='openai-codex').codex.code,'CODEX_READY');
    assert.equal(message.result.value.routes.find(x=>x.route==='openai-codex').manualOnly,false);
    for(const secret of ['OAUTH_ACCESS_SENTINEL','OAUTH_REFRESH_SENTINEL','ACCOUNT_ID_SENTINEL'])assert.ok(!JSON.stringify(message).includes(secret));
    assert.equal((await post({cookie},'{')).status,400);assert.equal((await post({cookie,'content-type':'text/plain'})).status,415);
    assert.equal((await post({cookie},' '.repeat(1049601))).status,413);
    const bad=await(await post({cookie},JSON.stringify({type:'client-request',rpcId:'a',method:'model-probe/other',payload:{}}))).json();assert.equal(bad.result.error.code,'METHOD_MISMATCH');
    await fiber.dispose();assert.equal((await post({cookie})).status,404);
  }finally{
    await fiber.dispose();await connection.operator.dispose();await provider.dispose();
    for(const f of fibers.reverse())await f.dispose();
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});

test('real Loader + ConfigEditor + LLM load read-only Host from isolated Include', {skip:!runtime||!process.env.DSH_MODEL_TEST_ROOT||!process.env.DSH_MODEL_TEST_READ_PROFILE,timeout:20000},async()=>{
  const {Context}=await load('@deepseek-ai/cordis');const {Loader}=await load('@deepseek-ai/cordis-plugin-loader');const boot=await load('@deepseek-ai/dsh-app-boot');const {ConfigEditor}=await load('@deepseek-ai/dsh-config-editor');
  const root=process.env.DSH_MODEL_TEST_ROOT;
  const desktop=process.env.DSH_MODEL_TEST_READ_PROFILE;
  assert.ok(desktop,'Explicit read-only profile path required');
  const ctx=new Context();new Loader(ctx,{baseUrl:pathToFileURL(runtime+'/').href});
  const {home,profileDir}=await isolatedProfile(root,'runtime-readonly-');
  const resolution=await boot.createRuntimeResolution({installAnchor:join(runtime,'package.json'),home});
  new boot.PluginPackages(ctx,{resolution:{...resolution,profileDir,linkedRoots:[{name:'dsh-model-probe',realPath:fileURLToPath(new URL('..',import.meta.url))}]}});
  ctx.provide('profileContext',{dir:desktop,patchPath:join(desktop,'cordis.patch.yml'),home,overlays:[],installAnchor:join(runtime,'package.json')});
  new ConfigEditor(ctx);
  const routes=new Map();
  const services=ctx.plugin({name:'probe-readonly-services',apply(c){
    c.provide('connection',{fetch:{register:route=>{routes.set(route.path,route);return()=>routes.delete(route.path);}}});
    c.provide('credentials',{describe:async()=>({configured:false,writable:false}),describeRecord:async()=>({configured:false,writable:false})});
  }});await services.await();
  const loaded=boot.loadProfileDirectory('dsh',desktop,join(runtime,'package.json'));
  const flatten=rows=>rows.flatMap(row=>[row,...row.group&&Array.isArray(row.config)?flatten(row.config):[]]);
  const piRow=flatten(boot.composeEntries([...loaded.layers.map(x=>x.patches),loaded.patches])).find(x=>x.name==='@deepseek-ai/dsh-llm-pi-ai');assert.ok(piRow);
  await boot.mountRootInclude(ctx,join(profileDir,'cordis.yml'),[{insert:[{id:'llm',name:'@deepseek-ai/dsh-llm'},piRow,{id:'model-probe',name:new URL('../lib/index.js',import.meta.url).href}]}],pathToFileURL(runtime+'/').href);
  await ctx.loader.await();
  const probe=[...ctx.loader.entries()].find(x=>x.options.id==='model-probe');assert.equal(probe.fiber.state,2);
  const response=await routes.get('/api/model-probe/state').fetch(rpcRequest());const result=await response.json();assert.equal(result.result.ok,true);
  const rows=result.result.value.routes;
  for(const route of ['google','openai-codex','xai']){const row=rows.find(x=>x.route===route);assert.ok(row);assert.equal(row.available,true);assert.ok(row.served.length>0);}
  assert.equal(typeof ctx.llm.discoveries.get('llm-pi-ai').__modelProbeWrapped,'function');
  // Ordinary discovery is local even with unavailable credential services.
  const local=await ctx.llm.discoverModels('llm-pi-ai',{provider:'openai-codex'});
  assert.ok(local.some(model=>model.id==='gpt-6.1-sol'));
  const google=await ctx.llm.discoverModels('llm-pi-ai',{provider:'google'});
  assert.ok(google.some(model=>model.id==='gemini-4-argon'));
  // The native DTO deliberately strips capability metadata; backend native-save
  // supplementation uses the internal catalog, not this lossy projection.
  const rawGoogle=await ctx.llm.discoveries.get('llm-pi-ai')({provider:'google'});
  assert.deepEqual(rawGoogle.find(model=>model.id==='gemini-4-argon').reasoningEfforts,{low:'low',medium:'medium',high:'high'});
  // Explicit refresh must not disguise missing credentials as a static success.
  const refreshRequest=new Request('http://127.0.0.1/api/model-probe/refreshDiscovery',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'refresh',method:'model-probe/refreshDiscovery',payload:{provider:'openai-codex'}})});
  const refresh=await(await routes.get('/api/model-probe/refreshDiscovery').fetch(refreshRequest)).json();
  assert.equal(refresh.result.ok,false);assert.equal(refresh.result.error.code,'CODEX_RECORD_UNAVAILABLE');
  await probe.fiber.dispose();assert.equal(ctx.llm.discoveries.get('llm-pi-ai').__modelProbeWrapped,undefined);assert.equal(routes.size,0);await services.dispose();
});
