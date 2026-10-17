import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=fileURLToPath(new URL('../',import.meta.url));
const dependencies=process.env.DSH_MODEL_TEST_DEPS_ROOT??root;
const requireTest=createRequire(path.join(dependencies,'package.json'));
const {build}=requireTest('esbuild');
assert.ok(process.env.DSH_MODEL_TEST_ROOT,'Set DSH_MODEL_TEST_ROOT to an isolated temporary directory');
assert.ok(process.env.DSH_MODEL_TEST_RUNTIME,'Set DSH_MODEL_TEST_RUNTIME to the reviewed runtime or extracted runtime');
const runtime=process.env.DSH_MODEL_TEST_RUNTIME;
await fs.mkdir(process.env.DSH_MODEL_TEST_ROOT,{recursive:true});
const out=await fs.mkdtemp(path.join(process.env.DSH_MODEL_TEST_ROOT,'native-picker-'));
const source=await fs.readFile(path.join(runtime,'node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js'),'utf8');
const cut=source.indexOf('//#region lib/types/client/store.js');assert.ok(cut>0);
const native=source.slice(0,cut)+'exports.NativePicker=ModelListEditor;return module.exports;}});';
const plugin=await fs.readFile(path.join(root,'lib/client.js'),'utf8');
const gateway=await fs.readFile(path.join(runtime,'node_modules/@deepseek-ai/dsh-api-gateway/lib/client.js'),'utf8');
const nsStart=gateway.indexOf('var RemoteNamespaceService = class'),nsEnd=gateway.indexOf('\n\t\t};',nsStart)+'\n\t\t};'.length;assert.ok(nsStart>0&&nsEnd>nsStart);
const namespaceSource=gateway.slice(nsStart,nsEnd);
const opsStart=source.indexOf('function createModelsOperations(ctx)'),opsEnd=source.indexOf('//#endregion',opsStart);assert.ok(opsStart>0&&opsEnd>opsStart);
const operationsSource=source.slice(opsStart,opsEnd);
const primitives=path.join(runtime,'node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js');
const primitiveSource=await fs.readFile(primitives,'utf8');const modalStart=primitiveSource.indexOf('function Modal({');const modal=primitiveSource.slice(modalStart,primitiveSource.indexOf('//#endregion',modalStart));
// Real installed list logic and Modal markup; icon/focus-layer primitives are
// test doubles. This is isolated component acceptance, never a live-account test.
const entry=`import React,{useRef} from 'react';import * as jsxRuntime from 'react/jsx-runtime';import {createRoot} from 'react-dom/client';import {createPortal} from 'react-dom';import * as cordis from ${JSON.stringify(path.join(runtime,'node_modules/@deepseek-ai/cordis/lib/index.js'))};
window.cordis=cordis;
const {jsx,jsxs,Fragment}=jsxRuntime;const css$18=new Proxy({},{get:(_,key)=>'native-modal-'+key});const clsx=(...xs)=>xs.filter(Boolean).join(' ');const useModalLayer=()=>{};const IconCloseOutlineRegular=()=>React.createElement('span',null,'×');
${modal}
const Button=React.forwardRef(({variant,size,children,...props},ref)=>React.createElement('button',{...props,ref},children));const Checkbox=props=>React.createElement('input',{...props,type:'checkbox'});const IconChevronDownOutlineRegular=()=>null,IconChevronRightOutlineRegular=()=>null,IconTrashOutlineRegular=()=>null,IconPlusOutlineRegular=()=>null;
window.React=React;window.jsx=jsxRuntime;window.createRoot=createRoot;window.primitives={Checkbox,IconChevronDownOutlineRegular,IconChevronRightOutlineRegular,IconTrashOutlineRegular,IconPlusOutlineRegular,Modal,Button};`;
const built=await build({stdin:{contents:entry,resolveDir:dependencies,loader:'js'},bundle:true,write:false,format:'iife',platform:'browser',target:'chrome120',alias:{react:path.dirname(requireTest.resolve('react/package.json')),'react-dom':path.dirname(requireTest.resolve('react-dom/package.json'))},plugins:[{name:'native-css',setup(b){b.onLoad({filter:/\.css$/},async({path:p})=>{let css=await fs.readFile(p,'utf8');const names=[...new Set([...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(x=>x[1]))],prefix=path.basename(p).replaceAll('.','_')+'_',mapping=Object.fromEntries(names.map(n=>[n,prefix+n]));css=css.replace(/\.([a-zA-Z_][\w-]*)/g,(all,n)=>'.'+mapping[n]);return{contents:`const s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.append(s);export default ${JSON.stringify(mapping)};`,loader:'js'};});}}]});
const boot=`window.modules={};window.__ModuleLoader__={load(e){modules[e.id]=e.factory(name=>({'react':React,'react/jsx-runtime':jsx,'@deepseek-ai/dsh-client-ui-primitives':primitives,'@deepseek-ai/dsh-client-store':{}}[name]));}};`;
const fixture=`window.phase=0;window.calls=0;window.localCalls=0;window.writes=0;window.emptyRoute=false;
const words={models:'模型',fetchModels:'获取可用模型',fetching:'获取中…',fetchTitle:'选择要添加的模型',fetchDescription:'以下是模型提供商的可用模型，勾选要添加的模型。',fetchSearch:'搜索模型',fetchSelectAll:'全选',fetchDeselectAll:'取消全选',fetchAdopt:'添加所选',fetchEmpty:'没有可用模型',cancel:'取消',close:'关闭'};
const _deepseek_ai_cordis=cordis,remoteServiceKey=name=>'remote.'+name,REMOTE_NAMESPACE_FIELDS=new Set();
${namespaceSource}
${operationsSource}
const cordisCtx=new cordis.Context();const pickerCtx=cordisCtx.extend({caller:'native-picker'});
const ns=new RemoteNamespaceService(cordisCtx,'llm',async(d,s,ctx,args)=>{localCalls++;if(ctx.caller!=='native-picker')throw Error('lost caller context');return {ok:true,value:emptyRoute?[]:[{id:'gpt-6-sol'},{id:'gpt-6-luna'}]};});ns.installDirect({method:'discoverModels'},{});
const remote={get llm(){return pickerCtx.get('remote.llm');}};
const connection={rpc:{async call(route,method,request,signal){if(route!=='/api'||method!=='model-probe/refreshDiscovery'||request.provider!=='openai-codex'||!signal)throw Error('bad wire contract');calls++;return await new Promise((resolve,reject)=>{window.completeRefresh=()=>{if(phase===3){reject(Error('offline'));return;}resolve(phase===2?{ok:false,error:{message:'测试：厂商未返回有效 JSON。'}}:{ok:true,value:[{id:'gpt-6-sol'},{id:'gpt-6-luna'},...(phase===1?[{id:'gpt-6.1-sol'}]:[])]});};});}}};
const mount=()=>modules['dsh-live-model-probe'].apply({remote,get:name=>name==='connection'?connection:undefined,effect(fn){fn();}});mount();window.remountPlugin=mount;
const operations=createModelsOperations({remote});
const nativeRoot=createRoot(document.querySelector('#root'));let editorKey=0;
window.renderEditor=()=>nativeRoot.render(React.createElement(modules['@deepseek-ai/dsh-client-ui-settings-models'].NativePicker,{key:++editorKey,models:[],onChange(){writes++;},probe:{settingsNs:'llm-pi-ai',provider:'openai-codex'},catalogProvider:'openai-codex',operations,t:k=>words[k]??k,disabled:false,onBusyChange(){}}));renderEditor();`;
const esc=s=>s.replaceAll('</script','<\\/script');
const html=`<!doctype html><html><meta charset='utf-8'><style>.native-modal-root{position:fixed;inset:0;display:grid;place-items:center}.native-modal-mask{position:absolute;inset:0;background:#0008}.native-modal-dialog{position:relative;background:#2b2b2b;border:1px solid #444;border-radius:24px;width:560px;max-height:90vh;overflow:auto}.native-modal-content{padding:24px 32px}.native-modal-header{display:flex;justify-content:space-between;align-items:center}.native-modal-title{font-size:20px}.native-modal-footer{display:flex;gap:12px;justify-content:end;padding:0 32px 24px}.native-modal-close{border:0;background:transparent;color:inherit;font-size:20px}button{padding:8px 12px;border:1px solid #555;border-radius:8px;background:#2b2b2b;color:inherit;font:inherit;cursor:pointer}body{font:16px system-ui;background:#151515;color:#eee;padding:40px;--dsw-alias-label-primary:#eee;--dsw-alias-bg-base:#252525;--dsw-alias-bg-layer-2:#303030;--dsw-alias-settings-card-fill:#252525;--dsw-alias-border-l2:#555;--dsw-alias-modal-backdrop:rgba(0,0,0,.4)}</style><div id='root'></div><script>${esc(built.outputFiles[0].text)}</script><script>${esc(boot)}</script><script>${esc(native)}</script><script>${esc(plugin)}</script><script>${esc(fixture)}</script></html>`;
const page=path.join(out,'native.html');await fs.writeFile(page,html);const profile=await fs.mkdtemp(path.join(out,'chrome-'));
const browser=spawn(process.env.DSH_MODEL_TEST_BROWSER??'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-first-run','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
let ws,session,id=0;const pending=new Map();const delay=ms=>new Promise(r=>setTimeout(r,ms));
function call(method,params={},sid=session){return new Promise((resolve,reject)=>{const seq=++id,timer=setTimeout(()=>{pending.delete(seq);reject(Error('CDP timeout '+method));},15000);pending.set(seq,{resolve,reject,timer});ws.send(JSON.stringify({id:seq,method,params,...sid?{sessionId:sid}:{}}));});}
const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
const waitFor=async expression=>{for(let i=0;i<100;i++){if(await evaluate(`Boolean(${expression})`))return;await delay(50);}throw Error('Condition timed out: '+expression);};
try{
 let lines;for(let i=0;i<100;i++){try{lines=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);break;}catch{await delay(50);}}assert.ok(lines);
 ws=new WebSocket(`ws://127.0.0.1:${lines[0]}${lines[1]}`);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});ws.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);if(m.error)p.reject(Error(m.error.message));else p.resolve(m.result);}};
 const {targetId}=await call('Target.createTarget',{url:'about:blank'},null);({sessionId:session}=await call('Target.attachToTarget',{targetId,flatten:true},null));await call('Page.enable');await call('Network.enable');await call('Network.setBlockedURLs',{urls:['http://*','https://*']});await call('Page.navigate',{url:pathToFileURL(page).href});
 await waitFor("window.localCalls===1 && document.querySelector('[data-model-probe-picker-refresh]')");
 assert.equal(await evaluate('calls'),0); // Real catalog useEffect must be local.
 await evaluate("window.refreshButton=document.querySelector('[data-model-probe-picker-refresh]');[...document.querySelectorAll('button')].find(b=>b.textContent==='获取可用模型').click()");
 await waitFor("document.querySelector('[role=dialog] li label') && refreshButton.closest('[role=dialog]')");
 assert.equal(await evaluate('calls'),0);assert.equal(await evaluate('localCalls'),2);
 const inputQuery=async value=>{await evaluate(`(()=>{const s=document.querySelector('[role=dialog] input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s,${JSON.stringify(value)});s.dispatchEvent(new Event('input',{bubbles:true}));})()`);};
 const checked=id=>`[...document.querySelectorAll('[role=dialog] li label')].find(l=>l.textContent===${JSON.stringify(id)})?.querySelector('input').checked`;
 await evaluate("[...document.querySelectorAll('[role=dialog] li label')].find(l=>l.textContent==='gpt-6-sol').querySelector('input').click()");
 await inputQuery('luna');await waitFor("document.querySelectorAll('[role=dialog] li label').length===1");
 await evaluate("phase=1;refreshButton.click();refreshButton.click()");await waitFor('calls===1');
 // User changes both the current selection and filter during the network wait.
 await evaluate("document.querySelector('[role=dialog] li label input').click()");await inputQuery('gpt');
 await waitFor("document.querySelectorAll('[role=dialog] li label').length===2");
 await evaluate('completeRefresh()');
 await waitFor("document.querySelector('[role=dialog]').textContent.includes('gpt-6.1-sol')&&!refreshButton.disabled && document.querySelector('[role=dialog] input[type=search]').value==='gpt'");
 assert.equal(await evaluate(checked('gpt-6-sol')),false);assert.equal(await evaluate(checked('gpt-6-luna')),false);
 // Hide a deselected choice through the entire next successful refresh.
 await inputQuery('luna');await waitFor("document.querySelectorAll('[role=dialog] li label').length===1");
 await evaluate('refreshButton.click()');await waitFor('calls===2');await evaluate('completeRefresh()');
 await waitFor("!refreshButton.disabled && document.querySelector('[role=dialog] input[type=search]').value==='luna'");
 await inputQuery('');await waitFor("document.querySelectorAll('[role=dialog] li label').length===3");
 assert.equal(await evaluate(checked('gpt-6-sol')),false);assert.equal(await evaluate(checked('gpt-6-luna')),false);
 const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});await fs.writeFile(path.join(out,'picker-refresh.png'),Buffer.from(shot.data,'base64'));
 await inputQuery('luna');await evaluate('phase=2;refreshButton.click()');await waitFor('calls===3');await evaluate('completeRefresh()');
 await waitFor("refreshButton.title.includes('JSON')&&!refreshButton.disabled");
 assert.equal(await evaluate("document.querySelector('[role=dialog] input[type=search]').value"),'luna');assert.equal(await evaluate(checked('gpt-6-luna')),false);
 await inputQuery('');await waitFor("document.querySelectorAll('[role=dialog] li label').length===3");assert.equal(await evaluate(checked('gpt-6-sol')),false);
 // Transport rejection must also reach the native error and remain retryable.
 await evaluate('phase=3;refreshButton.click()');await waitFor('calls===4');await evaluate('completeRefresh()');await waitFor("refreshButton.title.includes('连接')&&!refreshButton.disabled");
 assert.equal(await evaluate(checked('gpt-6-sol')),false);
 await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='取消').click()");
 await waitFor("!document.querySelector('[role=dialog]') && refreshButton.isConnected && !refreshButton.closest('[role=dialog]')");
 assert.equal(await evaluate("document.querySelectorAll('[data-model-probe-picker-refresh]').length"),1);
 // New/empty route has no picker at all until its explicit refresh succeeds.
 await evaluate('emptyRoute=true;renderEditor()');await waitFor('localCalls===3');
 await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='获取可用模型').click()");await waitFor("localCalls===4 && document.querySelector('section').textContent.includes('没有可用模型')");
 assert.equal(await evaluate("Boolean(document.querySelector('[role=dialog]'))"),false);assert.equal(await evaluate('calls'),4);
 await evaluate("phase=1;window.refreshButton=document.querySelector('[data-model-probe-picker-refresh]');refreshButton.click()");await waitFor('calls===5');await evaluate('completeRefresh()');
 await waitFor("document.querySelector('[role=dialog] li label') && refreshButton.closest('[role=dialog]') && !refreshButton.disabled");
 assert.equal(await evaluate("document.querySelectorAll('[data-model-probe-picker-refresh]').length"),1);
 assert.equal(await evaluate('writes'),0);assert.equal(await evaluate('localCalls'),4);
 // Plugin effect replacement restores then rewraps the real namespace getter.
 await evaluate('remountPlugin()');await waitFor("document.querySelectorAll('[data-model-probe-picker-refresh]').length===1 && document.querySelector('[role=dialog] [data-model-probe-picker-refresh]')");
 await evaluate("remote.llm.discoverModels('llm-pi-ai',{provider:'openai-codex'})");assert.equal(await evaluate('calls'),5);
 console.log(JSON.stringify({nativeComponent:true,nativeModal:true,realCordisNamespace:true,nativeOperations:true,mountEffectAndNativeFetchLocal:true,oneMovableButton:true,emptyRouteRefresh:true,newModelVisible:true,picksAndInFlightEditsPreserved:true,hiddenPicksPreserved:true,failedRefreshVisible:true,transportFailureVisible:true,noConfigWrite:true,vendorFixtureCalls:await evaluate('calls'),screenshot:path.join(out,'picker-refresh.png')}));
}finally{if(ws?.readyState===WebSocket.OPEN){await call('Browser.close',{},null).catch(()=>{});ws.close();}if(browser.exitCode===null)browser.kill();for(const p of pending.values())clearTimeout(p.timer);}
