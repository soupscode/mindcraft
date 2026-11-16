import { strictFormat } from '../utils/text.js';
import { ModelError, ModelUnavailableError, ModelTimeoutError, ModelInvalidResponseError } from '../../genesis/lib/model_errors.js';

const DEFAULT_TIMEOUT_MS = 90000;

export class Ollama {
    static prefix = 'ollama';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        // request_timeout_ms is an option of this client, not an Ollama parameter: keep it out of the request body
        const { request_timeout_ms, ...model_params } = params || {};
        this.params = model_params;
        this.timeout_ms = Number(request_timeout_ms) > 0 ? Number(request_timeout_ms) : DEFAULT_TIMEOUT_MS;
        this.url = url || 'http://127.0.0.1:11434';
        this.chat_endpoint = '/api/chat';
        this.embedding_endpoint = '/api/embeddings';
    }

    async sendRequest(turns, systemMessage) {
        let model = this.model_name || 'sweaterdog/andy-4:micro-q8_0';
        let messages = strictFormat(turns);
        messages.unshift({ role: 'system', content: systemMessage });
        const maxAttempts = 5;
        let attempt = 0;
        let finalRes = null;

        while (attempt < maxAttempts) {
            attempt++;
            console.log(`Awaiting local response... (model: ${model}, attempt: ${attempt})`);
            let res = null;
            try {
                let apiResponse = await this.send(this.chat_endpoint, {
                    model: model,
                    messages: messages,
                    stream: false,
                    ...(this.params || {})
                });
                res = apiResponse?.message?.content;
                if (typeof res !== 'string') {
                    throw new ModelInvalidResponseError('Ollama response has no message content.', this._details(this.chat_endpoint, model));
                }
            } catch (err) {
                if (err.message.toLowerCase().includes('context length') && turns.length > 1) {
                    console.log('Context length exceeded, trying again with shorter context.');
                    return await this.sendRequest(turns.slice(1), systemMessage);
                }
                throw err; // typed ModelError: callers decide what to do, no placeholder text
            }

            const hasOpenTag = res.includes("<think>");
            const hasCloseTag = res.includes("</think>");

            if ((hasOpenTag && !hasCloseTag)) {
                console.warn("Partial <think> block detected. Re-generating...");
                continue; // after the last attempt this falls through to the error below
            }
            if (hasCloseTag && !hasOpenTag) {
                res = '<think>' + res;
            }
            if (hasOpenTag && hasCloseTag) {
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            }
            finalRes = res;
            break;
        }

        if (finalRes == null) {
            throw new ModelInvalidResponseError(`Ollama gave no complete response after ${maxAttempts} attempts (unfinished <think> block).`, this._details(this.chat_endpoint, model));
        }
        return finalRes;
    }

    async embed(text) {
        let model = this.model_name || 'embeddinggemma';
        let body = { model: model, input: text };
        let res = await this.send(this.embedding_endpoint, body);
        if (!Array.isArray(res?.embedding) || res.embedding.length === 0) {
            throw new ModelInvalidResponseError('Ollama embedding response has no embedding.', this._details(this.embedding_endpoint, model));
        }
        return res['embedding'];
    }

    _details(endpoint, model) {
        return { provider: 'ollama', model: model ?? null, url: `${this.url}${endpoint}`, timeout_ms: this.timeout_ms };
    }

    // Resolves with the parsed JSON body, or rejects with a typed ModelError.
    // The timeout covers the whole exchange: connecting, waiting and reading the body.
    async send(endpoint, body) {
        const details = this._details(endpoint, body?.model);
        const started = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout_ms);
        try {
            const url = new URL(endpoint, this.url);
            let method = 'POST';
            let headers = new Headers();
            const res = await fetch(url, { method, headers, body: JSON.stringify(body), signal: controller.signal });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new ModelUnavailableError(`Ollama Status: ${res.status}${text ? ' ' + text.slice(0, 300) : ''}`,
                    { ...details, status: res.status, elapsed_ms: Date.now() - started });
            }
            return await res.json();
        } catch (err) {
            if (err instanceof ModelError) throw err;
            const elapsed_ms = Date.now() - started;
            if (controller.signal.aborted) {
                throw new ModelTimeoutError(`Ollama request timed out after ${this.timeout_ms} ms.`, { ...details, elapsed_ms, cause: err });
            }
            if (err instanceof SyntaxError) {
                throw new ModelInvalidResponseError('Ollama response was not valid JSON.', { ...details, elapsed_ms, cause: err });
            }
            const code = err?.cause?.code ? ` (${err.cause.code})` : '';
            throw new ModelUnavailableError(`Ollama request failed: ${err?.message ?? err}${code}`, { ...details, elapsed_ms, cause: err });
        } finally {
            clearTimeout(timer);
        }
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: "user",
            content: [
                { type: "text", text: systemMessage },
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
                    }
                }
            ]
        });
        
        return this.sendRequest(imageMessages, systemMessage);
    }
}
