// Adapter for OpenAI-compatible services (main process only), configured by the user in the
// advanced settings with a base URL and a model id (for example a local server or a gateway):
//   testConnection -> GET  {baseUrl}/models             (the model must be listed; no tokens)
//   proposePlan    -> POST {baseUrl}/chat/completions   (json_schema structured output)
// These third-party services implement the de-facto Chat Completions format; how completely each
// one supports structured output varies, so the expected JSON shape is also stated in the
// instructions and every answer is validated by the app like any other.
const { SYSTEM_PROMPT } = require('../prompt.cjs');
const { RESPONSE_SCHEMA, planFromText, requestJson, isPlainObject } = require('./shared.cjs');

const REQUEST_TIMEOUT_MS = 120_000; // local models can be slow
const TEST_TIMEOUT_MS = 15_000;
const JSON_INSTRUCTION =
  '\n\nAnswer with one JSON object only, with exactly these keys: "reply" (string), "question" (string), "actions" (array of action objects, each with every field of the action schema).';

const authHeaders = (apiKey) => ({ authorization: `Bearer ${apiKey}` });

function createOpenAiCompatibleAdapter({ fetch = (...args) => globalThis.fetch(...args) } = {}) {
  return {
    providerId: 'openai-compatible',

    async testConnection({ apiKey, model, baseUrl }) {
      const result = await requestJson({ fetch, url: `${baseUrl}/models`, headers: authHeaders(apiKey), timeoutMs: TEST_TIMEOUT_MS });
      if (!result.ok) return result.code === 'MODEL_UNAVAILABLE' ? { ok: false, code: 'ENDPOINT_NOT_FOUND' } : result;
      const list = result.json?.data;
      if (!Array.isArray(list)) return { ok: false, code: 'MALFORMED' };
      if (!list.some((item) => isPlainObject(item) && item.id === model)) return { ok: false, code: 'MODEL_UNAVAILABLE' };
      return { ok: true };
    },

    async proposePlan({ apiKey, model, baseUrl, history, userContent }) {
      const userMessage = { role: 'user', content: userContent };
      const result = await requestJson({
        fetch,
        url: `${baseUrl}/chat/completions`,
        method: 'POST',
        headers: authHeaders(apiKey),
        timeoutMs: REQUEST_TIMEOUT_MS,
        body: {
          model,
          messages: [{ role: 'system', content: SYSTEM_PROMPT + JSON_INSTRUCTION }, ...history, userMessage],
          response_format: { type: 'json_schema', json_schema: { name: 'taskflow_plan', schema: RESPONSE_SCHEMA, strict: true } },
        },
      });
      if (!result.ok) return result;
      const choice = Array.isArray(result.json?.choices) ? result.json.choices[0] : null;
      if (!isPlainObject(choice) || !isPlainObject(choice.message)) return { ok: false, code: 'MALFORMED' };
      if (choice.finish_reason === 'length') return { ok: false, code: 'TRUNCATED' };
      if (choice.finish_reason === 'content_filter' || (typeof choice.message.refusal === 'string' && choice.message.refusal)) return { ok: false, code: 'REFUSED' };
      const text = choice.message.content;
      const { plan, code } = planFromText(text);
      if (!plan) return { ok: false, code };
      const reported = result.json.usage;
      const usage = reported && typeof reported.prompt_tokens === 'number' && typeof reported.completion_tokens === 'number'
        ? { inputTokens: reported.prompt_tokens, outputTokens: reported.completion_tokens }
        : null;
      return { ok: true, plan, turn: [userMessage, { role: 'assistant', content: text }], usage };
    },
  };
}

module.exports = { createOpenAiCompatibleAdapter, JSON_INSTRUCTION };
