import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProbeBody, diffModels, validateDraft } from '../lib/model.js';

test('normalize data: empty, primitives, missing name, duplicates and unknown fields', () => {
  assert.deepEqual(normalizeProbeBody({data:[]}), []);
  const rows = normalizeProbeBody({data:[null,3,'x',{id:'a',secret:'sentinel'},{id:'a'},{id:' white '},{id:'b',name:'Bee',contextWindow:3,input:['text','video']}]});
  assert.deepEqual(rows.map(x=>x.id), ['a','b']);
  assert.equal(rows[0].name, undefined); assert.equal(rows[0].secret,undefined);
  assert.deepEqual(rows[1].input,['text']); assert.equal(rows[1].sources.contextWindow,'vendor');
});
test('normalize rich models objects use map key, not attacker id', () => {
  const result = normalizeProbeBody({models:{a:{id:'other',name:'A',context_length:123},b:12,c:{max_output_tokens:42}}});
  assert.deepEqual(result.map(x=>x.id),['a','c']); assert.equal(result[0].contextWindow,123); assert.equal(result[1].maxTokens,42);
});
test('unsupported shape and oversized lists are rejected', () => {
  assert.throws(()=>normalizeProbeBody({data:{}}),{code:'DISCOVERY_PARSE_UNSUPPORTED'});
  assert.throws(()=>normalizeProbeBody({data:Array(10001).fill({id:'a'})}),{code:'TOO_MANY_MODELS'});
});
test('diff preserves declared/outside/missing, including empty lists', () => {
  const diff = diffModels([{id:'a'},{id:'b'}],[{id:'b'},{id:'c'}]);
  assert.deepEqual(Object.fromEntries(Object.entries(diff).map(([key,v])=>[key,v.map(x=>x.id)])),{declared:['b'],outside:['c'],missing:['a']});
  assert.deepEqual(diffModels([],[]),{declared:[],outside:[],missing:[]});
});
test('draft validation rejects blank, whitespace, duplicate ids and invalid parameters', () => {
  for(const models of [[],[{id:''}],[{id:'a b'}],[{id:'a\n'}],[{id:'a'},{id:'a'}],[{id:'a',contextWindow:0}],[{id:'a',maxTokens:Infinity}],[{id:'a',input:['audio']}],[{id:'a',name:3}]]) assert.throws(()=>validateDraft(models));
});
test('draft output is strictly allowlisted', () => {
  assert.deepEqual(validateDraft([{id:'a',name:' A ',contextWindow:42,cost:22,apiKey:'sentinel',baseURL:'http://evil.invalid',sources:{id:'vendor'}}]),[{id:'a',name:'A',contextWindow:42}]);
});
