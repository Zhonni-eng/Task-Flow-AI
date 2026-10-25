// OpenAI provider adapter (main process only), over the Responses API without an SDK:
//   testConnection -> GET  https://api.openai.com/v1/models/{model}   (no tokens, no task data)
//   proposePlan    -> POST https://api.openai.com/v1/responses        (structured output)
// Request and response shapes follow OpenAI's API reference (checked 2026-10-24). Responses are
// not stored on OpenAI's side (store: false); the conversation is replayed from the app's memory
// with every output item passed back unchanged, as the docs require for reasoning models.
const { SYSTEM_PROMPT } = require('../prompt.cjs');
const { RESPONSE_SCHEMA, planFromText, requestJson, isPlainObject } = require('./shared.cjs');

const API_BASE_URL = 'https://api.openai.com/v1';
const REQUEST_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 15_000;
// OpenAI recommends reserving at least 25,000 tokens for reasoning and output.
const MAX_OUTPUT_TOKENS = 25_000;

const authHeaders = (apiKey) => ({ authorization: `Bearer ${apiKey}` });

function createOpenAiAdapter({ fetch = (...args) => globalThis.fetch(...args) } = {}) {
  return {
    providerId: 'openai',

    async testConnection({ apiKey, model }) {
      const result = await requestJson({ fetch, url: `${API_BASE_URL}/models/${encodeURIComponent(model)}`, headers: authHeaders(apiKey), timeoutMs: TEST_TIMEOUT_MS });
      if (!result.ok) return result;
      const info = result.json;
      if (!isPlainObject(info) || info.object !== 'model' || typeof info.id !== 'string') return { ok: false, code: 'MALFORMED' };
      return { ok: true };
    },

    async proposePlan({ apiKey, model, history, userContent }) {
      const userMessage = { role: 'user', content: userContent };
      const result = await requestJson({
        fetch,
        url: `${API_BASE_URL}/responses`,
        method: 'POST',
        headers: authHeaders(apiKey),
        timeoutMs: REQUEST_TIMEOUT_MS,
        body: {
          model,
          instructions: SYSTEM_PROMPT,
          input: [...history, userMessage],
          text: { format: { type: 'json_schema', name: 'taskflow_plan', schema: RESPONSE_SCHEMA, strict: true } },
          reasoning: { effort: 'low' },
          max_output_tokens: MAX_OUTPUT_TOKENS,
          store: false,
        },
      });
      if (!result.ok) return result;
      const response = result.json;
      if (!isPlainObject(response) || !Array.isArray(response.output)) return { ok: false, code: 'MALFORMED' };
      if (response.status === 'incomplete') {
        const reason = response.incomplete_details?.reason;
        return { ok: false, code: reason === 'max_output_tokens' ? 'TRUNCATED' : reason === 'content_filter' ? 'REFUSED' : 'MALFORMED' };
      }
      if (response.status !== 'completed') return { ok: false, code: 'MALFORMED' };
      const parts = response.output.filter((item) => item?.type === 'message' && Array.isArray(item.content)).flatMap((item) => item.content);
      if (parts.some((part) => part?.type === 'refusal')) return { ok: false, code: 'REFUSED' };
      const text = parts.filter((part) => part?.type === 'output_text' && typeof part.text === 'string').map((part) => part.text).join('');
      const { plan, code } = planFromText(text);
      if (!plan) return { ok: false, code };
      const usage = response.usage && typeof response.usage.input_tokens === 'number' && typeof response.usage.output_tokens === 'number'
        ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
        : null;
      // Every output item (reasoning included) goes back unchanged in later turns.
      return { ok: true, plan, turn: [userMessage, ...response.output], usage };
    },
  };
}

module.exports = { createOpenAiAdapter, API_BASE_URL, MAX_OUTPUT_TOKENS, TEST_TIMEOUT_MS };
