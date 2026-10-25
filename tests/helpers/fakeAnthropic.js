// A stand-in for the Anthropic SDK client: no network. Each `messages.create` or
// `models.retrieve` call takes the next scripted reply (a response object, an Error to throw, or a
// function of the request params). Recorded requests let tests check exactly what would have been
// sent: `requests` (messages), `modelRequests` (model ids) and each client's `options`.

/** A response shaped like the Messages API's, carrying the given structured JSON (or raw text). */
export function planResponse({ reply = '', question = '', tasks = [], statusChanges = [], dueDateChanges = [] } = {}, overrides = {}) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: '', signature: 'test-signature' },
      { type: 'text', text: JSON.stringify({ reply, question, tasks, statusChanges, dueDateChanges }) },
    ],
    usage: { input_tokens: 10, output_tokens: 10 },
    ...overrides,
  };
}

export const textResponse = (text, overrides = {}) => ({ ...planResponse(), content: [{ type: 'text', text }], ...overrides });

/** A task entry in the provider's schema shape. */
/** A response shaped like the Models API's "retrieve model". */
export const modelInfo = (id = 'claude-opus-5-5') => ({ type: 'model', id, display_name: 'Test model', created_at: '2026-01-01T00:00:00Z' });

export const task = (title, extra = {}) => ({ title, dueDate: '', priority: 'medium', categoryId: '', subtasks: [], ...extra });

export function createFakeAnthropic(script = []) {
  const queue = [...script];
  const fake = {
    requests: [],
    modelRequests: [],
    clients: [],
    push: (...items) => queue.push(...items),
    createClient({ apiKey, ...options }) {
      const reply = async (params) => {
        const next = queue.shift();
        if (next === undefined) throw new Error('No scripted response left');
        const value = typeof next === 'function' ? await next(params) : next;
        if (value instanceof Error) throw value;
        return structuredClone(value);
      };
      const client = {
        apiKey,
        options,
        messages: {
          create: async (params) => {
            fake.requests.push(structuredClone(params));
            return reply(params);
          },
        },
        models: {
          retrieve: async (id) => {
            fake.modelRequests.push(id);
            return reply(id);
          },
        },
      };
      fake.clients.push(client);
      return client;
    },
  };
  return fake;
}

/** A response in the action-list format: { reply, question, actions }. */
export const actionsResponse = ({ reply = '', question = '', actions = [] } = {}) => ({
  ...planResponse(),
  content: [{ type: 'text', text: JSON.stringify({ reply, question, actions }) }],
});
