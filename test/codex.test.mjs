import test from 'node:test';
import assert from 'node:assert/strict';
import { codexStatus, resolveCodexGrant } from '../lib/codex.js';
const module = { credentialKey: (scope, route) => `${scope}/${route}` };
const sentinel = 'SECRET-CODEX-MUST-NOT-LEAVE-HOST';
const valid = { kind: 'grant', payload: { type: 'oauth', access: sentinel, refresh: sentinel, accountId: sentinel, expires: 2000 } };
async function check(record, code, manualOnly = true) {
  const before = structuredClone(record); let reads = 0;
  const ctx = { credentials: new Proxy({ readRecord: async key => { reads++; assert.equal(key, 'llm-pi-ai/openai-codex'); return record; } }, { get(target, key) { assert.equal(key, 'readRecord', 'No credential mutation or resolution allowed'); return target[key]; } }) };
  const status = await codexStatus(ctx, module, 'openai-codex', 1000);
  assert.equal(status.code, code); assert.equal(status.manualOnly, manualOnly); assert.equal(reads, 1);
  assert.deepEqual(Object.keys(status).sort(), ['code', 'manualOnly', 'message']);
  assert.ok(!JSON.stringify(status).includes(sentinel)); assert.deepEqual(record, before);
  return status;
}
test('Codex missing grant gives actionable manual-only login guidance', async () => {
  const status = await check(undefined, 'CODEX_NOT_SIGNED_IN', true); assert.match(status.message, /设置 → 模型 → OpenAI Codex 重新登录/);
});
test('Codex valid-looking grant is ready for live model listing without token leakage or refresh', async () => {
  const status = await check(valid, 'CODEX_READY', false); assert.match(status.message, /可直接询问厂商模型列表/);
  const grant = await resolveCodexGrant({ credentials: { readRecord: async () => valid } }, module, 'openai-codex', 1000);
  assert.deepEqual(grant, { key: sentinel, accountId: sentinel });
});
test('Codex expired grant is never refreshed or rewritten', async () => {
  await check({ ...valid, payload: { ...valid.payload, expires: 1000 } }, 'CODEX_EXPIRED', true);
  await assert.rejects(resolveCodexGrant({ credentials: { readRecord: async () => ({ ...valid, payload: { ...valid.payload, expires: 1000 } }) } }, module, 'openai-codex', 1000), { code: 'CODEX_EXPIRED' });
});
test('Codex unsupported records fail closed without exposing fields', async () => {
  for (const record of [{ kind: 'api-key', key: sentinel }, { kind: 'grant', payload: null }, { ...valid, payload: { ...valid.payload, expires: Infinity } }, { ...valid, payload: { ...valid.payload, access: '' } }, { ...valid, payload: { ...valid.payload, type: 'unknown' } }]) await check(record, 'CODEX_RECORD_UNSUPPORTED', true);
});
test('Codex read failures are sanitized and do not echo sensitive exceptions', async () => {
  const result = await codexStatus({ credentials: { readRecord() { throw Error(sentinel); } } }, module);
  assert.equal(result.code, 'CODEX_RECORD_UNAVAILABLE'); assert.ok(!JSON.stringify(result).includes(sentinel));
});
