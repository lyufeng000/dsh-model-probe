import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichModels, createCatalog } from '../lib/enrich.js';
const catalog={lookup:(route,id)=>route==='google'&&id==='known'?{id,name:'Catalog name',contextWindow:200,maxTokens:60,input:['text','image']}:undefined};
test('five-level precedence is per-field: vendor, proven catalog, opt-in OpenRouter, manual, omit',()=>{
  const result=enrichModels([{id:'known',contextWindow:100},{id:'router'},{id:'manual'},{id:'unknown'}],{route:'google',catalog,useOpenRouterEnrich:true,openrouter:[{id:'known',contextWindow:300,maxTokens:300},{id:'router',contextWindow:300}],manual:[{id:'known',contextWindow:400},{id:'router',contextWindow:400,maxTokens:40},{id:'manual',contextWindow:400} ]});
  assert.equal(result[0].contextWindow,100);assert.equal(result[0].sources.contextWindow,'vendor');assert.equal(result[0].maxTokens,60);assert.equal(result[0].sources.maxTokens,'catalog');assert.equal(result[0].inCatalog,true);
  assert.equal(result[1].contextWindow,300);assert.equal(result[1].sources.contextWindow,'openrouter');assert.equal(result[1].maxTokens,40);assert.equal(result[1].sources.maxTokens,'manual');
  assert.equal(result[2].contextWindow,400);assert.equal(result[2].sources.contextWindow,'manual');assert.equal(result[3].contextWindow,undefined);assert.equal(result[3].maxTokens,undefined);assert.equal(result[3].input,undefined);assert.equal(result[3].inCatalog,false);
});
test('OpenRouter is disabled by default and requires exact id match',()=>{
  assert.equal(enrichModels([{id:'a'}],{openrouter:[{id:'a',contextWindow:200}]} )[0].contextWindow,undefined);
  assert.equal(enrichModels([{id:'a'}],{useOpenRouterEnrich:true,openrouter:[{id:'vendor/a',contextWindow:200}]} )[0].contextWindow,undefined);
});
test('catalog adapter proves exact membership and excludes prototype properties',()=>{
  const model={id:'known',api:'google-generative-ai',contextWindow:100};const c=createCatalog({builtinProviders:()=>[{id:'google',baseUrl:'https://generativelanguage.googleapis.com/v1beta'}],getBuiltinProviders:()=>['google'],getBuiltinModels:()=>[model],getBuiltinModelDataGeneratedAt:()=>123});
  assert.equal(c.lookup('google','known'),model);assert.equal(c.lookup('google','constructor'),undefined);assert.equal(c.lookup('constructor','known'),undefined);assert.equal(c.lookup('google','unknown'),undefined);assert.equal(c.defaults('google').api,'google-generative-ai');assert.equal(c.generatedAt,123);
});
test('enrichment never mutates inputs or keeps arbitrary fields',()=>{
  const input=[{id:'known',unknown:'fixture-secret'}],before=JSON.stringify(input);const result=enrichModels(input,{route:'google',catalog});assert.equal(JSON.stringify(input),before);assert.ok(!JSON.stringify(result).includes('fixture-secret'));
});
