/**
 * LLM Provider Wrapper
 * ---------------------------------------------------------------
 * Provider-agnostic on purpose. Swapping Gemini for Anthropic or
 * OpenAI is a change to this one file, not to every call site.
 *
 * TWO HARD RULES enforced here, not left to call-site discipline:
 *
 *   1. Nothing reaches a model without passing through redaction.
 *      `complete()` calls assertSafeForModel() and throws on failure.
 *      A broken redaction layer stops the request; it does not
 *      degrade into sending PHI with a warning logged.
 *
 *   2. Tiered routing. Classification and extraction use the FAST
 *      (cheap) model; only the conversational surface uses the CHAT
 *      model. This is the main cost lever in the whole system.
 */

import 'server-only';
import { assertSafeForModel } from './redaction';

export type Tier = 'fast' | 'chat';

export interface CompletionRequest {
  system?: string;
  prompt: string;
  tier?: Tier;
  /** ask the model for JSON and parse it */
  json?: boolean;
  maxTokens?: number;
}

export interface CompletionResult {
  text: string;
  /** populated when json: true and parsing succeeded */
  parsed?: unknown;
  model: string;
  /** rough token accounting for the cost model in the Technical Brief */
  promptChars: number;
  completionChars: number;
}

const PROVIDER = process.env.LLM_PROVIDER ?? 'gemini';

function modelFor(tier: Tier): string {
  return tier === 'chat'
    ? process.env.LLM_MODEL_CHAT ?? 'gemini-2.0-flash'
    : process.env.LLM_MODEL_FAST ?? 'gemini-2.0-flash';
}

/* ---------------- Gemini ---------------- */

async function callGemini(
  req: CompletionRequest,
  model: string
): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Missing GEMINI_API_KEY in .env.local');

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const body: Record<string, unknown> = {
    contents: [{ parts: [{ text: req.prompt }] }],
    generationConfig: {
      maxOutputTokens: req.maxTokens ?? 800,
      temperature: req.json ? 0 : 0.7,
      ...(req.json ? { responseMimeType: 'application/json' } : {}),
    },
  };
  if (req.system) {
    body.systemInstruction = { parts: [{ text: req.system }] };
  }

  // Hard timeout. A hanging third-party call must never stall an
  // intake request — the deterministic layers can carry the response.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text)
      .join('') ?? '';
  if (!text) throw new Error('Gemini returned an empty completion');
  return text;
}

/* ---------------- Anthropic (swap-ready) ---------------- */

async function callAnthropic(
  req: CompletionRequest,
  model: string
): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Missing ANTHROPIC_API_KEY');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: req.maxTokens ?? 800,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: 'user', content: req.prompt }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.content ?? [])
    .map((b: { type: string; text?: string }) => (b.type === 'text' ? b.text : ''))
    .join('');
}

/* ---------------- Public API ---------------- */

/**
 * The only way to reach a model in this codebase.
 *
 * @throws if the prompt still contains unredacted identifiers.
 */
export async function complete(
  req: CompletionRequest
): Promise<CompletionResult> {
  // HARD GATE — see rule 1 above.
  assertSafeForModel(req.prompt);

  const tier = req.tier ?? 'fast';
  const model = modelFor(tier);

  let text: string;
  switch (PROVIDER) {
    case 'anthropic':
      text = await callAnthropic(req, model);
      break;
    case 'gemini':
    default:
      text = await callGemini(req, model);
      break;
  }

  const result: CompletionResult = {
    text,
    model,
    promptChars: req.prompt.length + (req.system?.length ?? 0),
    completionChars: text.length,
  };

  if (req.json) {
    try {
      result.parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch {
      // Leave parsed undefined; callers must handle it. We do not
      // retry blindly — a malformed response on a safety path should
      // fail closed, not loop.
    }
  }

  return result;
}

/**
 * Graceful degradation helper.
 * If the model is unavailable, the deterministic layers still work —
 * so callers can fall back rather than failing the whole request.
 */
export async function completeOrNull(
  req: CompletionRequest
): Promise<CompletionResult | null> {
  try {
    return await complete(req);
  } catch (err) {
    console.error('[llm] falling back:', (err as Error).message);
    return null;
  }
}
