// Shared NVIDIA Nemotron client for api/explain.ts and api/propose.ts.
// Files starting with "_" in api/ are not Vercel routes.
//
// Not every catalog model is served for every free key, so a model that
// returns HTTP 404 is skipped and the next one is tried. NVIDIA_MODEL, if set,
// goes first; the last model that answered on this warm instance goes first
// after that.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DeviceJson } from '../src/lib/types.js';

// NVIDIA_API_URL exists only so tests can point at a local mock server.
const API_URL = process.env.NVIDIA_API_URL || 'https://integrate.api.nvidia.com/v1/chat/completions';

export interface Candidate {
  id: string;
  /** The model accepts chat_template_kwargs.enable_thinking. */
  thinkingToggle: boolean;
}

const CANDIDATE_MODELS: Candidate[] = [
  { id: 'nvidia/nemotron-3-super-120b-a12b', thinkingToggle: true },
  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', thinkingToggle: true },
  { id: 'nvidia/nemotron-nano-3-30b-a3b', thinkingToggle: true },
  { id: 'nvidia/llama-3.1-nemotron-70b-instruct', thinkingToggle: false },
];
// Vercel's limit is 60 s (vercel.json maxDuration). Keep the whole request under ~45 s:
// no single model call may take more than 20 s, and a retry is skipped when it can't finish.
export const TOTAL_BUDGET_MS = 45_000;
const PER_CALL_MS = 20_000;
const MIN_RETRY_MS = 8_000;
let workingModel: string | undefined;

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export const CHIP_RE = /^[a-z0-9]{4,24}$/;

const deviceCache = new Map<string, Promise<DeviceJson>>();
export function loadDevice(chip: string): Promise<DeviceJson> {
  let p = deviceCache.get(chip);
  if (!p) {
    const file = path.join(process.cwd(), 'public', 'svd', `${chip}.json`);
    p = readFile(file, 'utf8').then((s) => JSON.parse(s) as DeviceJson);
    deviceCache.set(chip, p);
    p.catch(() => deviceCache.delete(chip));
  }
  return p;
}

export function hasKey(): boolean {
  return !!process.env.NVIDIA_API_KEY;
}

function modelOrder(): Candidate[] {
  const order = [...CANDIDATE_MODELS];
  const pinned = process.env.NVIDIA_MODEL?.trim();
  if (pinned) {
    order.unshift(order.find((m) => m.id === pinned) ?? { id: pinned, thinkingToggle: !/llama-3\.1/.test(pinned) });
  }
  if (workingModel) {
    order.unshift(order.find((m) => m.id === workingModel)!);
  }
  return order.filter((m, i) => order.findIndex((x) => x.id === m.id) === i);
}

export type Attempt =
  | { kind: 'ok'; text: string; model: string }
  | { kind: 'empty' }
  | { kind: 'http'; status: number; detail: string }
  | { kind: 'network'; timedOut: boolean };

export async function callModel(
  model: string,
  thinkingToggle: boolean,
  system: string,
  userText: string,
  deadline: number,
  temperature = 0.3,
  maxTokens = 1024,
): Promise<Attempt> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userText },
    ],
    // Low temperature: factual summaries and register plans, not open-ended text.
    temperature,
    top_p: 0.9,
    max_tokens: maxTokens,
    stream: false,
  };
  // No reasoning trace needed; skip it for speed.
  if (thinkingToggle) body.chat_template_kwargs = { enable_thinking: false };

  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1_000, Math.min(PER_CALL_MS, deadline - Date.now()))),
    });
  } catch (e) {
    return { kind: 'network', timedOut: e instanceof DOMException && e.name === 'TimeoutError' };
  }
  if (!res.ok) return { kind: 'http', status: res.status, detail: await errorDetail(res) };
  try {
    const data = (await res.json()) as ChatCompletion;
    const text = stripReasoning(data.choices?.[0]?.message?.content ?? '');
    return text ? { kind: 'ok', text, model: data.model ?? model } : { kind: 'empty' };
  } catch {
    return { kind: 'empty' };
  }
}

export type ChatResult =
  | { ok: true; text: string; model: string; candidate: Candidate; deadline: number; maxTokens: number; timings: Timing[] }
  | { ok: false; response: Response };

/** One model call, for the response's `timings` (diagnosing slow requests). */
export interface Timing {
  model: string;
  ms: number;
  outcome: string;
}

/**
 * Ask the first model this key can reach. Errors come back as ready-made
 * JSON responses with messages a user can act on.
 */
export async function chat(system: string, userText: string, temperature = 0.3, maxTokens = 1024): Promise<ChatResult> {
  const tried: string[] = [];
  const timings: Timing[] = [];
  const timed = async (c: Candidate, toggle: boolean) => {
    const t = Date.now();
    const a = await callModel(c.id, toggle, system, userText, deadline, temperature, maxTokens);
    timings.push({ model: c.id, ms: Date.now() - t, outcome: a.kind === 'http' ? `HTTP ${a.status}` : a.kind === 'network' ? (a.timedOut ? 'timeout' : 'network') : a.kind });
    return a;
  };
  let lastDetail = '';
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  for (const candidate of modelOrder()) {
    if (deadline - Date.now() < 3_000) break;
    tried.push(candidate.id);
    let attempt = await timed(candidate, candidate.thinkingToggle);
    // Some deployments reject chat_template_kwargs; retry that model once without it.
    if (attempt.kind === 'http' && attempt.status === 400 && candidate.thinkingToggle) {
      attempt = await timed(candidate, false);
    }
    if (attempt.kind === 'ok') {
      workingModel = candidate.id;
      return { ok: true, text: attempt.text, model: attempt.model, candidate, deadline, maxTokens, timings };
    }
    // A stalled call is usually transient (seen live: one 20 s hang in 9 Write runs),
    // so try the same model once more while the budget still allows a full answer.
    if (attempt.kind === 'network' && attempt.timedOut && deadline - Date.now() >= MIN_RETRY_MS) {
      attempt = await timed(candidate, candidate.thinkingToggle);
      if (attempt.kind === 'ok') {
        workingModel = candidate.id;
        return { ok: true, text: attempt.text, model: attempt.model, candidate, deadline, maxTokens, timings };
      }
    }
    if (attempt.kind === 'network') {
      return { ok: false, response: json(504, { error: attempt.timedOut ? 'The model took too long. Try again.' : 'Could not reach the model API. Try again.', timings }) };
    }
    if (attempt.kind === 'empty') {
      lastDetail = 'empty reply';
      continue;
    }
    const { status, detail } = attempt;
    if (status === 401 || status === 403) {
      return { ok: false, response: json(503, { error: 'The AI is misconfigured on this server (bad or expired NVIDIA API key).' }) };
    }
    if (status === 402) return { ok: false, response: json(503, { error: 'The free NVIDIA API credits for this demo are used up.' }) };
    if (status === 429) return { ok: false, response: json(429, { error: 'Rate limited by the free NVIDIA API. Wait a minute and try again.' }) };
    lastDetail = `${status}${detail ? `: ${detail}` : ''}`;
    if (status === 404 || status === 400 || status === 422) continue; // model not available to this key; try the next
    return { ok: false, response: json(502, { error: `Model API error (${lastDetail}). Try again.` }) };
  }
  console.error(`[nvidia] no Nemotron model answered; tried ${tried.join(', ')}; last: ${lastDetail}`);
  return {
    ok: false,
    response: json(502, {
      error: `No Nemotron model answered for this NVIDIA key (tried ${tried.join(', ')}). Last error: ${lastDetail || 'none'}. Set NVIDIA_MODEL to a model your key can use.`,
    }),
  };
}

/**
 * A second call on the model that just answered (for a verification retry).
 * Skipped when too little of the time budget is left for it to finish.
 */
export async function retrySame(first: Extract<ChatResult, { ok: true }>, system: string, userText: string): Promise<string | undefined> {
  if (first.deadline - Date.now() < MIN_RETRY_MS) {
    first.timings.push({ model: first.candidate.id, ms: 0, outcome: 'retry skipped: time budget' });
    return undefined;
  }
  const t = Date.now();
  const r = await callModel(first.candidate.id, first.candidate.thinkingToggle, system, userText, first.deadline, 0, first.maxTokens);
  first.timings.push({ model: first.candidate.id, ms: Date.now() - t, outcome: `retry ${r.kind === 'http' ? `HTTP ${r.status}` : r.kind}` });
  return r.kind === 'ok' ? r.text : undefined;
}

/** A short, key-free description of an error response body. */
async function errorDetail(res: Response): Promise<string> {
  const raw = (await res.text().catch(() => '')).trim();
  let msg = raw;
  try {
    const j = JSON.parse(raw) as { detail?: unknown; title?: unknown; message?: unknown; error?: { message?: unknown } | string };
    const e = typeof j.error === 'object' ? j.error?.message : j.error;
    msg = String(j.detail ?? e ?? j.message ?? j.title ?? raw);
  } catch {
    /* not JSON */
  }
  return msg.replace(/nvapi-[A-Za-z0-9_-]+/g, 'nvapi-…').replace(/\s+/g, ' ').slice(0, 160);
}

/** The subset of an OpenAI-style chat completion this code reads. */
interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null } }[];
}

/**
 * Nemotron reasoning models may wrap a reasoning trace in <think>…</think>
 * inside `content` even when thinking is disabled. Keep only the answer.
 */
export function stripReasoning(content: string): string {
  let t = content;
  const close = t.lastIndexOf('</think>');
  if (close >= 0) t = t.slice(close + '</think>'.length);
  return t.replace(/<think>[\s\S]*$/, '').replace(/\*\*(.+?)\*\*/g, '$1').trim();
}
