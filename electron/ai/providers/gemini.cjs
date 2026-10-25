// Google Gemini provider adapter (main process only), over the Gemini API REST endpoints without
// an SDK:
//   testConnection -> GET  .../v1beta/models/{model}                  (no tokens, no task data)
//   proposePlan    -> POST .../v1beta/models/{model}:generateContent  (structured output)
// Shapes follow Google's Gemini API reference (checked 2026-10-24; generateContent "remains fully
// supported"). The key goes in the x-goog-api-key header, never in the URL. Earlier model turns
// are sent back with their parts unchanged (they may carry thought signatures).
const { SYSTEM_PROMPT } = require('../prompt.cjs');
const { RESPONSE_SCHEMA, planFromText, requestJson, isPlainObject } = require('./shared.cjs');

const API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const REQUEST_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_TOKENS = 32_768;
const BLOCKED_FINISH = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE']);

/**
 * The app's JSON Schema in Gemini's Schema format (OpenAPI subset: upper-case types, no
 * additionalProperties). propertyOrdering keeps the documented field order.
 */
function toGeminiSchema(schema) {
  const out = { type: String(schema.type).toUpperCase() };
  if (schema.enum) out.enum = [...schema.enum];
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)]));
    out.propertyOrdering = Object.keys(schema.properties);
  }
  if (schema.required) out.required = [...schema.required];
  return out;
}

const RESPONSE_SCHEMA_GEMINI = toGeminiSchema(RESPONSE_SCHEMA);
const modelPath = (model) => `${API_BASE_URL}/models/${encodeURIComponent(model)}`;
const authHeaders = (apiKey) => ({ 'x-goog-api-key': apiKey });

function createGeminiAdapter({ fetch = (...args) => globalThis.fetch(...args) } = {}) {
  return {
    providerId: 'gemini',

    async testConnection({ apiKey, model }) {
      const result = await requestJson({ fetch, url: modelPath(model), headers: authHeaders(apiKey), timeoutMs: TEST_TIMEOUT_MS });
      // A GET without parameters can only be a bad request because of the key.
      if (!result.ok) return result.code === 'BAD_REQUEST' ? { ok: false, code: 'AUTH' } : result;
      const info = result.json;
      if (!isPlainObject(info) || typeof info.name !== 'string' || !info.name.startsWith('models/')) return { ok: false, code: 'MALFORMED' };
      if (Array.isArray(info.supportedGenerationMethods) && !info.supportedGenerationMethods.includes('generateContent')) return { ok: false, code: 'MODEL_UNAVAILABLE' };
      return { ok: true };
    },

    async proposePlan({ apiKey, model, history, userContent }) {
      const userTurn = { role: 'user', parts: [{ text: userContent }] };
      const result = await requestJson({
        fetch,
        url: `${modelPath(model)}:generateContent`,
        method: 'POST',
        headers: authHeaders(apiKey),
        timeoutMs: REQUEST_TIMEOUT_MS,
        body: {
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [...history, userTurn],
          generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA_GEMINI, maxOutputTokens: MAX_OUTPUT_TOKENS },
        },
      });
      if (!result.ok) return result;
      const response = result.json;
      if (!isPlainObject(response)) return { ok: false, code: 'MALFORMED' };
      if (response.promptFeedback?.blockReason) return { ok: false, code: 'REFUSED' };
      const candidate = Array.isArray(response.candidates) ? response.candidates[0] : null;
      if (!isPlainObject(candidate)) return { ok: false, code: 'MALFORMED' };
      if (candidate.finishReason === 'MAX_TOKENS') return { ok: false, code: 'TRUNCATED' };
      if (BLOCKED_FINISH.has(candidate.finishReason)) return { ok: false, code: 'REFUSED' };
      const parts = candidate.content?.parts;
      if (!Array.isArray(parts)) return { ok: false, code: 'MALFORMED' };
      // Thought parts are not part of the answer.
      const text = parts.filter((part) => typeof part?.text === 'string' && part.thought !== true).map((part) => part.text).join('');
      const { plan, code } = planFromText(text);
      if (!plan) return { ok: false, code };
      const meta = response.usageMetadata;
      // Thinking tokens are billed as output.
      const usage = meta && typeof meta.promptTokenCount === 'number'
        ? { inputTokens: meta.promptTokenCount, outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0) }
        : null;
      return { ok: true, plan, turn: [userTurn, { role: 'model', parts }], usage };
    },
  };
}

module.exports = { createGeminiAdapter, toGeminiSchema, RESPONSE_SCHEMA_GEMINI, API_BASE_URL, TEST_TIMEOUT_MS };
