// AI provider registry (main process). Everything provider-specific lives in a provider
// descriptor and its adapter (providers/<file>.cjs); the default interface never names providers.
//
// Descriptor shape:
//   id            stable identifier stored in settings
//   label         name shown only in the advanced settings
//   model         the default model id for this provider (null: configured by the user); the
//                 user may set another model id in the advanced settings - it is verified by the
//                 connection test before it is used, never substituted silently
//   keyHint       RegExp of a key shape that suggests this provider in automatic detection, or
//                 null when the provider is only used when chosen explicitly
//   isApiKeyFormat(key)  local format check (never a network call)
//   createAdapter(deps)  the provider's adapter - loaded only when first used
//
// Model ids were checked against each provider's model documentation on 2026-10-24/25:
//   Anthropic claude-opus-5-5; OpenAI gpt-6-luna ("most efficient model for focused, high-volume
//   tasks"); Google gemini-3.8-flash (stable; structured output supported). Whether a given key
//   may use the model is checked by the connection test with that exact id.
//
// Detection: a key shape only suggests ONE candidate provider; the key counts as belonging to it
// only after that provider's own test request succeeds. Key shapes are not documented by every
// provider and can change (new Gemini keys have no documented format), so a key that suggests no
// provider - or several - is never guessed and never sent to several services: the user chooses
// the service in the advanced settings instead.

const SAFE_KEY = /^[A-Za-z0-9._~+/=-]+$/;
const lengthOk = (key, min, max) => key.length >= min && key.length <= max;

const PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'anthropic',
    label: 'Anthropic Claude',
    model: 'claude-opus-5-5',
    keyHint: /^sk-ant-/,
    isApiKeyFormat: (key) => /^sk-ant-[A-Za-z0-9_-]{20,250}$/.test(key),
    createAdapter: (deps) => require('./providers/anthropic.cjs').createAnthropicAdapter(deps),
  }),
  Object.freeze({
    id: 'openai',
    label: 'OpenAI GPT',
    model: 'gpt-6-luna',
    // "sk-..." keys that are not Anthropic's.
    keyHint: /^sk-(?!ant-)/,
    isApiKeyFormat: (key) => SAFE_KEY.test(key) && lengthOk(key, 20, 300),
    createAdapter: (deps) => require('./providers/openai.cjs').createOpenAiAdapter(deps),
  }),
  Object.freeze({
    id: 'gemini',
    label: 'Google Gemini',
    model: 'gemini-3.8-flash',
    // Classic Google API keys; newer key formats are not documented - choose Gemini explicitly.
    keyHint: /^AIza/,
    isApiKeyFormat: (key) => SAFE_KEY.test(key) && lengthOk(key, 20, 300),
    createAdapter: (deps) => require('./providers/gemini.cjs').createGeminiAdapter(deps),
  }),
  Object.freeze({
    id: 'openai-compatible',
    label: 'OpenAI-compatible API',
    model: null,
    keyHint: null,
    isApiKeyFormat: (key) => /^[\x21-\x7e]+$/.test(key) && lengthOk(key, 1, 512),
    createAdapter: (deps) => require('./providers/openaiCompatible.cjs').createOpenAiCompatibleAdapter(deps),
  }),
]);

const DEFAULT_PROVIDER = PROVIDERS[0].id;

// API prices in USD per million tokens [input, output], only where read from the provider's own
// model documentation (OpenAI models page, 2026-10-24). Other models have no estimate: no figure
// is better than a made-up one. Cached-input discounts are ignored, so estimates are upper bounds.
const PRICES = Object.freeze({
  'gpt-6-luna': [0.1, 0.5],
  'gpt-6.1-sol': [2, 10],
  'gpt-6-astra': [10, 50],
});

/** Estimated USD cost of one request, or null when the model's price is not known. */
function estimateCost(model, usage) {
  const price = PRICES[model];
  if (!price || !usage) return null;
  return ((usage.inputTokens ?? 0) * price[0] + (usage.outputTokens ?? 0) * price[1]) / 1_000_000;
}
const PROVIDER_IDS = PROVIDERS.map((provider) => provider.id);
const CONFIGURABLE_PROVIDER = 'openai-compatible';

function getProvider(id) {
  return PROVIDERS.find((provider) => provider.id === id) ?? null;
}

/**
 * Suggests the provider of an API key (already trimmed) from its shape.
 * Returns { provider } or { code }: 'UNIDENTIFIED_KEY' (no provider suggested - choose one in the
 * advanced settings), 'AMBIGUOUS_KEY' (several suggested) or 'INVALID_KEY' (suggested, but not a
 * well-formed key of that provider).
 */
function detectProvider(key, providers = PROVIDERS) {
  if (typeof key !== 'string' || key.length === 0) return { code: 'INVALID_KEY' };
  const candidates = providers.filter((provider) => provider.keyHint?.test(key));
  if (candidates.length === 0) return { code: 'UNIDENTIFIED_KEY' };
  if (candidates.length > 1) return { code: 'AMBIGUOUS_KEY' };
  const [provider] = candidates;
  return provider.isApiKeyFormat(key) ? { provider } : { code: 'INVALID_KEY' };
}

const MAX_BASE_URL_LENGTH = 300;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Base URL of an OpenAI-compatible API, normalized without a trailing slash, or null. HTTPS only,
 * except plain HTTP to this computer (local servers). No credentials, query or fragment.
 */
function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BASE_URL_LENGTH) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** A model id for an OpenAI-compatible API (as listed by its /models), or null. */
function normalizeModelId(value) {
  if (typeof value !== 'string') return null;
  const model = value.trim();
  return /^[A-Za-z0-9._:/@+-]{1,200}$/.test(model) ? model : null;
}

module.exports = { PROVIDERS, PROVIDER_IDS, DEFAULT_PROVIDER, CONFIGURABLE_PROVIDER, PRICES, getProvider, detectProvider, normalizeBaseUrl, normalizeModelId, estimateCost };
