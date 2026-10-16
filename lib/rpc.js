import { CHANNEL, UserError } from './model.js';

export function registerRpcRoutes(ctx, requestSchema, operations) {
  const disposers = [];
  try {
    for (const [endpoint, operation] of Object.entries(operations)) {
      const method = `model-probe/${endpoint}`;
      disposers.push(ctx.connection.fetch.register({
        path: `${CHANNEL}/${method}`, methods: ['POST'], requestBody: 'buffered',
        async fetch(request) {
          if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return new Response('unsupported media type', { status: 415 });
          if (Number(request.headers.get('content-length')) > 1049600) return new Response('request too large', { status: 413 });
          let raw;
          try { const text = await request.text(); if (Buffer.byteLength(text, 'utf8') > 1049600) return new Response('request too large', { status: 413 }); raw = JSON.parse(text); }
          catch { return new Response('invalid JSON', { status: 400 }); }
          const parsed = requestSchema.safeParse(raw);
          if (!parsed.success) return new Response('invalid envelope', { status: 400 });
          const message = parsed.data;
          let result;
          try {
            if (message.method !== method) throw new UserError('METHOD_MISMATCH', '请求方法与路径不一致。');
            if (request.signal.aborted) throw new UserError('CANCELLED', '操作已取消。');
            if (!message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) throw new UserError('INVALID_REQUEST', '请求格式无效。');
            result = { ok: true, value: await operation(message.payload, request.signal) };
          } catch (error) {
            result = { ok: false, error: { code: error instanceof UserError ? error.code : 'OPERATION_FAILED', message: error instanceof UserError ? error.message : '操作失败；请检查配置或存储权限。为保护凭据，未回显底层错误。', details: {} } };
          }
          return Response.json({ type: 'server-response', rpcId: message.rpcId, result });
        }
      }));
    }
  } catch (error) { for (const dispose of disposers.reverse()) void dispose(); throw error; }
  return async () => { for (const dispose of disposers.reverse()) await dispose(); };
}
