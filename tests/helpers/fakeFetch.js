// A scripted stand-in for `fetch`: no network. Each call takes the next scripted reply - a
// { status, body } object (body is JSON-encoded unless it is a string), an Error to throw, or a
// function of the request. Every request is recorded (url, method, headers, parsed JSON body).

export const json = (body, status = 200) => ({ status, body });

export function createFakeFetch(script = []) {
  const queue = [...script];
  const calls = [];
  const fetch = async (url, init = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    const call = { url: String(url), method: init.method ?? 'GET', headers, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body /* FormData stays as is */, redirect: init.redirect };
    calls.push(call);
    const next = queue.shift();
    if (next === undefined) throw new Error('No scripted response left');
    const value = typeof next === 'function' ? await next(call, init) : next;
    if (value instanceof Error) throw value;
    const text = typeof value.body === 'string' ? value.body : JSON.stringify(value.body);
    return new Response(text, { status: value.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls, push: (...items) => queue.push(...items), pending: () => queue.length };
}
