import OpenAI from 'openai';
import { config } from '../config.js';
import { log } from '../util/log.js';

const client = new OpenAI({
  apiKey: config.llm.apiKey,
  baseURL: config.llm.baseURL,
  timeout: config.llm.timeoutMs,
  maxRetries: 0, // we do our own backoff so we can fall back between tiers
});

const TIERS = {
  fast: config.llm.fast,
  smart: config.llm.smart,
  chat: config.llm.chat,
};

const stats = { calls: 0, fails: 0, totalMs: 0, byModel: {} };

export function llmStats() {
  return {
    ...stats,
    avgMs: stats.calls ? Math.round(stats.totalMs / stats.calls) : 0,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One raw completion. Returns the assistant text.
 * tier: 'fast' | 'smart' | 'chat'  (or pass an explicit model name)
 */
const FALLBACKS = {
  fast: config.llm.fastFallbacks,
  chat: config.llm.fastFallbacks,
  smart: config.llm.smartFallbacks,
};

/** Relay channels die without warning (503 "no available channel"), so every
 *  tier has a fallback lineup rather than a single model. */
function candidatesFor(tier, model) {
  if (model) return [model];
  const primary = TIERS[tier] || TIERS.fast;
  return [primary, ...(FALLBACKS[tier] || []).filter((m) => m !== primary)];
}

export async function complete({
  tier = 'fast',
  model,
  system,
  messages = [],
  maxTokens = 700,
  temperature = 0.6,
  attempts = 2,
}) {
  const candidates = candidatesFor(tier, model);
  let lastErr;

  for (const chosen of candidates) {
    const payload = {
      model: chosen,
      max_tokens: maxTokens,
      temperature,
      messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    };

    for (let i = 0; i < attempts; i++) {
      const t0 = Date.now();
      try {
        stats.calls++;
        const res = await client.chat.completions.create(payload);
        const ms = Date.now() - t0;
        stats.totalMs += ms;
        stats.byModel[chosen] = stats.byModel[chosen] || { calls: 0, ms: 0 };
        stats.byModel[chosen].calls++;
        stats.byModel[chosen].ms += ms;

        const text = res?.choices?.[0]?.message?.content;
        if (!text || !String(text).trim()) throw new Error('empty completion');
        if (chosen !== candidates[0]) log.warn(`llm fell back to ${chosen}`);
        return String(text);
      } catch (err) {
        lastErr = err;
        stats.fails++;
        const status = err?.status ?? err?.response?.status;
        const deadModel = status === 503 || status === 404;
        const retryable = !status || status === 429 || (status >= 500 && !deadModel) || /timeout|aborted|ECONN/i.test(err?.message || '');
        log.warn(`llm ${chosen} ${i + 1}/${attempts}: ${status || ''} ${String(err?.message || err).slice(0, 90)}`);
        if (deadModel) break; // this model is gone, try the next one
        if (!retryable || i === attempts - 1) break;
        await sleep(1200 * Math.pow(2, i) + Math.random() * 400);
      }
    }
  }
  throw lastErr;
}

/** Strip markdown fences / prose and pull the first balanced JSON object out. */
export function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();

  // ```json ... ``` fences
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const start = s.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const slice = s.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          try {
            // tolerate trailing commas
            return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

/**
 * Completion that must return JSON. Retries once with a stricter nudge.
 */
export async function completeJson(opts) {
  const text = await complete({ ...opts, temperature: opts.temperature ?? 0.4 });
  const parsed = extractJson(text);
  if (parsed) return parsed;

  log.warn('llm returned non-JSON, retrying strict');
  const retry = await complete({
    ...opts,
    temperature: 0.1,
    messages: [
      ...(opts.messages || []),
      { role: 'assistant', content: text.slice(0, 400) },
      { role: 'user', content: 'That was not valid JSON. Reply with ONLY the raw JSON object. No prose, no code fences.' },
    ],
  });
  return extractJson(retry);
}

export async function pingModel(model) {
  const t0 = Date.now();
  try {
    const text = await complete({
      model,
      messages: [{ role: 'user', content: 'Reply exactly: OK' }],
      maxTokens: 300,
      temperature: 0,
      attempts: 1,
    });
    return { model, ok: /OK/i.test(text), ms: Date.now() - t0, sample: text.trim().slice(0, 60) };
  } catch (err) {
    return { model, ok: false, ms: Date.now() - t0, error: err?.status ? `HTTP ${err.status}` : String(err?.message || err) };
  }
}
