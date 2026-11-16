// Genesis: the planner's model client for Ollama. Thin on purpose: one chat call with a
// structured reply, and one health probe. Uses only fetch (a Node built-in).
//
// From Ollama's API documentation (github.com/ollama/ollama, docs/api.md):
//   POST /api/chat   "format: the format to return a response in. Format can be `json` or a
//                    JSON schema." ("Structured outputs are supported by providing a JSON
//                    schema in the `format` parameter.") With "stream": false the answer is
//                    one object: message.content holds the JSON text, prompt_eval_count and
//                    eval_count the token counts, model the model's name.
//   GET /api/version answers {"version": "..."}: used as the health probe.
//
// Has the shape the broker takes as `model`: { name, chat(), probe() }.

import { ModelError, ModelUnavailableError, ModelTimeoutError, ModelInvalidResponseError } from '../lib/model_errors.js';

// url:     the Ollama address, for example "http://192.168.1.50:11434"
// model:   the model's name
// options: Ollama model options (the request's "options" field), sent only when given
export function createOllamaPlanner({ url, model, options = null, probe_timeout_ms = 3000, fetch: fetch_fn = globalThis.fetch } = {}) {
    const chat_url = new URL('/api/chat', url).href;
    const version_url = new URL('/api/version', url).href;

    // Runs one request that ends when it answers, when `signal` aborts or after timeout_ms.
    async function request(target, init, { signal, timeout_ms }) {
        const details = { provider: 'ollama', model, url: target, timeout_ms };
        const started = Date.now();
        const controller = new AbortController();
        let timed_out = false;
        const timer = setTimeout(() => { timed_out = true; controller.abort(); }, timeout_ms);
        const onAbort = () => controller.abort();
        if (signal?.aborted) controller.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            const res = await fetch_fn(target, { ...init, signal: controller.signal });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new ModelUnavailableError(`Ollama Status: ${res.status}${text ? ' ' + text.slice(0, 300) : ''}`,
                    { ...details, status: res.status, elapsed_ms: Date.now() - started });
            }
            return await res.json();
        } catch (err) {
            if (err instanceof ModelError) throw err;
            const elapsed_ms = Date.now() - started;
            if (timed_out) throw new ModelTimeoutError(`Ollama request timed out after ${timeout_ms} ms.`, { ...details, elapsed_ms, cause: err });
            if (controller.signal.aborted) throw new ModelUnavailableError('Ollama request was cancelled.', { ...details, elapsed_ms, cause: err });
            if (err instanceof SyntaxError) throw new ModelInvalidResponseError('Ollama response was not valid JSON.', { ...details, elapsed_ms, cause: err });
            const code = err?.cause?.code ? ` (${err.cause.code})` : '';
            throw new ModelUnavailableError(`Ollama request failed: ${err?.message ?? err}${code}`, { ...details, elapsed_ms, cause: err });
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
    }

    return {
        name: model,
        // format: the JSON schema of the reply (genesis/broker/planner_reply.js)
        // max_tokens: the most tokens the reply may have, for the small calls (Ollama docs/api.md and
        //   docs/modelfile.md: the option "num_predict", "Maximum number of tokens to predict when
        //   generating text"). Left out for planning calls, whose size the schema bounds.
        async chat({ messages, format, signal, timeout_ms = 90000, max_tokens = null }) {
            const body = { model, messages, stream: false, format };
            if (options) body.options = options;
            if (Number.isInteger(max_tokens) && max_tokens > 0) body.options = { ...(body.options ?? {}), num_predict: max_tokens };
            const answer = await request(chat_url,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
                { signal, timeout_ms });
            const content = answer?.message?.content;
            if (typeof content !== 'string') {
                throw new ModelInvalidResponseError('Ollama response has no message content.', { provider: 'ollama', model, url: chat_url, timeout_ms });
            }
            return {
                content,
                prompt_tokens: Number.isFinite(answer.prompt_eval_count) ? answer.prompt_eval_count : null,
                completion_tokens: Number.isFinite(answer.eval_count) ? answer.eval_count : null,
                model: typeof answer.model === 'string' ? answer.model : model,
            };
        },
        // true when the Ollama server answers. Never throws.
        async probe() {
            try {
                const answer = await request(version_url, { method: 'GET' }, { timeout_ms: probe_timeout_ms });
                return typeof answer?.version === 'string';
            } catch {
                return false;
            }
        },
    };
}
