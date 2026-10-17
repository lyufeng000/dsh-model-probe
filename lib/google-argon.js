// Gemini 4 Argon supports GenerateContent thinkingLevel, not thinkingBudget.
// Keep this exception exact: do not infer support for other Google model families
// or compatible gateways. The caller must install the hook before advertising it.
const API = 'google-generative-ai';
const BASES = new Set([
  'https://generativelanguage.googleapis.com/v1beta',
  'https://generativelanguage.googleapis.com/v1',
]);
const LEVELS = new Set(['low', 'medium', 'high']);
export const GOOGLE_ARGON_HOOK = Symbol.for('dsh-model-probe.google-argon');

export function argonReasoning(model, { api } = {}) {
  if (!model || model.provider !== 'google' || model.id !== 'gemini-4-argon'
    || model.api !== API || (api !== undefined && api !== API)
    || !BASES.has(model.baseUrl)) return undefined;
  return { low: 'low', medium: 'medium', high: 'high' };
}

function thinkingLevel(model, reasoning) {
  // Absence is Google's documented default, never an implicit request for off.
  if (reasoning === undefined) return 'MEDIUM';
  if (!LEVELS.has(reasoning)) throw new Error('Gemini 4 Argon requires reasoning low, medium, or high; disabling thinking is unsupported.');
  const map = model.thinkingLevelMap;
  const alias = map && Object.hasOwn(map, reasoning) ? map[reasoning] : reasoning;
  const level = typeof alias === 'string' ? alias.toLowerCase() : undefined;
  if (!LEVELS.has(level)) throw new Error('Gemini 4 Argon has an unsupported thinking-level mapping; expected low, medium, or high.');
  return level.toUpperCase();
}

function correctedPayload(payload, level) {
  const { thinkingBudget: _budget, ...thinking } = payload.config?.thinkingConfig ?? {};
  return {
    ...payload,
    config: { ...payload.config, thinkingConfig: { ...thinking, thinkingLevel: level } },
  };
}

// Use the same createModels module as DSH. Never replace the provider, bypass
// authentication/retries, spoof a model id, or alter installed runtime files.
export function hookGoogleArgon(createModels) {
  if (typeof createModels !== 'function') throw new TypeError('Argon hook requires core.createModels.');
  const prototype = Object.getPrototypeOf(createModels());
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'streamSimple');
  if (!descriptor || typeof descriptor.value !== 'function' || (!descriptor.configurable && !descriptor.writable)) {
    throw new Error('Argon hook cannot find a replaceable Models.streamSimple method.');
  }
  const original = descriptor.value;
  let active = true;
  function streamSimple(model, context, options) {
    if (!active || !argonReasoning(model)) return original.apply(this, arguments);
    const callback = options?.onPayload;
    const reasoning = options?.reasoning;
    const nextOptions = {
      ...options,
      async onPayload(payload, actualModel) {
        // Auth may have rewritten the base URL. Never apply the official API
        // correction to a gateway; disposal also deactivates queued callbacks.
        if (!active || !argonReasoning(actualModel)) return callback?.call(this, payload, actualModel);
        const corrected = correctedPayload(payload, thinkingLevel(actualModel, reasoning));
        const replacement = await callback?.call(this, corrected, actualModel);
        // A caller's replacement (including null) is authoritative, as in pi-ai.
        // Undefined means use its in-place edits to the corrected payload.
        return replacement === undefined ? corrected : replacement;
      },
    };
    return original.call(this, model, context, nextOptions);
  }
  Object.defineProperty(streamSimple, GOOGLE_ARGON_HOOK, { get: () => active });
  Object.defineProperty(prototype, 'streamSimple', { ...descriptor, value: streamSimple });
  return () => {
    if (!active) return;
    active = false;
    // Do not erase a later hook. Retained closures become transparent instead.
    if (Object.getOwnPropertyDescriptor(prototype, 'streamSimple')?.value === streamSimple) {
      Object.defineProperty(prototype, 'streamSimple', descriptor);
    }
  };
}
