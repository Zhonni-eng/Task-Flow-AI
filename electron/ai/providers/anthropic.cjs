// Anthropic provider adapter (main process only). All Anthropic-specific request building,
// response parsing and error mapping lives here; the app only sees app-level results:
//   proposePlan -> { ok: true, plan: { reply, question, actions }, turn }  or  { ok: false, code }
//   testConnection -> { ok: true }  or  { ok: false, code }
// `turn` is this provider's own history entry pair; the chat service stores it opaquely and
// passes it back unchanged, so history is only ever appended to.
const { SYSTEM_PROMPT } = require('../prompt.cjs');
const { RESPONSE_SCHEMA, toPlan, planFromText, codeForStatus } = require('./shared.cjs');

const API_BASE_URL = 'https://api.anthropic.com';
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;
// The connection test is one small read-only request; a dead network should not keep the user
// waiting for a minute.
const TEST_TIMEOUT_MS = 15_000;
const TEST_MAX_RETRIES = 1;
const MAX_OUTPUT_TOKENS = 16_000;

/** The SDK's main export (also used for its error classes). */
function loadSdk() {
  const sdk = require('@anthropic-ai/sdk');
  return sdk.default ?? sdk;
}

/** Real client. Tests inject `createClient` instead, so no request ever leaves the machine. */
function defaultCreateClient({ apiKey, fetch, timeout = REQUEST_TIMEOUT_MS, maxRetries = MAX_RETRIES }) {
  const Anthropic = loadSdk();
  return new Anthropic({
    apiKey,
    // Pinned: ignore ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN from the environment, so the key can
    // only ever go to Anthropic's API.
    baseURL: API_BASE_URL,
    authToken: null,
    timeout,
    maxRetries,
    ...(fetch ? { fetch } : {}),
  });
}

/** Maps SDK errors to app codes by class/status only - never by (or with) their messages. */
function errorCode(error) {
  const sdk = loadSdk();
  if (error instanceof sdk.APIConnectionTimeoutError) return 'TIMEOUT';
  if (error instanceof sdk.APIUserAbortError) return 'CANCELLED';
  if (error instanceof sdk.APIConnectionError) return 'NETWORK';
  return typeof error?.status === 'number' ? codeForStatus(error.status) : 'PROVIDER_ERROR';
}

/** Tokens as reported by the API (cached and newly cached input count as input). */
function usageOf(usage) {
  if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return null;
  return {
    inputTokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens,
  };
}

function createAnthropicAdapter({ createClient = defaultCreateClient } = {}) {
  return {
    providerId: 'anthropic',
    /**
     * Checks that the key is accepted and can use `model`: one "retrieve model" request (no
     * messages, no task data, no tokens used). Returns { ok: true } or { ok: false, code }.
     */
    async testConnection({ apiKey, model }) {
      const client = createClient({ apiKey, timeout: TEST_TIMEOUT_MS, maxRetries: TEST_MAX_RETRIES });
      let info;
      try {
        info = await client.models.retrieve(model);
      } catch (error) {
        return { ok: false, code: errorCode(error) };
      }
      // Anything but the model's own description is not a response this app understands.
      if (!info || typeof info !== 'object' || info.type !== 'model' || typeof info.id !== 'string') return { ok: false, code: 'MALFORMED' };
      return { ok: true };
    },
    /**
     * One request. `history` is the provider turns stored so far; `userContent` the new turn.
     * Returns { ok, plan, turn } or { ok: false, code }.
     */
    async proposePlan({ apiKey, model, history, userContent }) {
      const client = createClient({ apiKey });
      const userMessage = { role: 'user', content: userContent };
      let response;
      try {
        response = await client.messages.create({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          // Stable instructions are cached; per-turn context lives in the messages.
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          // History is passed back exactly as received (thinking blocks included).
          messages: [...history, userMessage],
          output_config: { effort: 'low', format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
        });
      } catch (error) {
        return { ok: false, code: errorCode(error) };
      }
      if (!response || !Array.isArray(response.content)) return { ok: false, code: 'MALFORMED' };
      if (response.stop_reason === 'refusal') return { ok: false, code: 'REFUSED' };
      if (response.stop_reason === 'max_tokens') return { ok: false, code: 'TRUNCATED' };
      const text = response.content.filter((block) => block?.type === 'text').map((block) => block.text).join('');
      const { plan, code } = planFromText(text);
      if (!plan) return { ok: false, code };
      return { ok: true, plan, turn: [userMessage, { role: 'assistant', content: response.content }], usage: usageOf(response.usage) };
    },
  };
}

module.exports = { createAnthropicAdapter, defaultCreateClient, RESPONSE_SCHEMA, REQUEST_TIMEOUT_MS, TEST_TIMEOUT_MS, MAX_OUTPUT_TOKENS, errorCode, toPlan };
