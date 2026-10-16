import test from 'node:test';
import assert from 'node:assert/strict';
import { probeModels } from '../lib/probes.js';

test('vendor key echoes are rejected before RPC even when JSON escapes quotes or backslashes', async () => {
  for (const key of ['synthetic-key', 'synthetic"key', 'synthetic\\key']) {
    for (const field of ['id', 'name']) {
      const model = { id: 'model', [field]: `echo-${key}-suffix` };
      await assert.rejects(probeModels({ api: 'openai-completions', key }, { fetch: async () => Response.json({ data: [model] }) }), error => error.code === 'SENSITIVE_RESPONSE' && !error.message.includes(key));
    }
    const safe = await probeModels({ api: 'openai-completions', key }, { fetch: async () => Response.json({ data: [{ id: 'safe', name: 'Safe model' }] }) });
    assert.equal(safe.models[0].id, 'safe');
  }
});
