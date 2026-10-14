// engine.js
// The "brain" interface for AirPlain. Two implementations:
//
// 1. stub (DEFAULT): a small, honest, fully local keyword heuristic.
//    It is clearly marked as a stub in every response ("engine": "stub").
//    It exists so Phase 1 can be built and tested with zero accounts,
//    zero spending, and zero network calls.
//
// 2. workers-ai: calls Cloudflare Workers AI with an open-weight model.
//    IMPLEMENTED but NOT exercised in local tests, because the AI binding
//    only exists on a real Cloudflare deploy. The code path is real;
//    it just has not run yet.
//
// Switching engines never changes the API contract: same inputs in,
// same shape of outputs out. The guardrails (allowed-list enforcement,
// validation, retries) wrap BOTH engines.

import { sanitizeText, clamp01, round2 } from "./guardrails.js";

export const STUB_MODEL = "stub-v1";
// Open-weight model used when the Workers AI engine is active.
export const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export async function decide(env, input, settings) {
  const wantAI = String(env.ENGINE || "stub").toLowerCase() === "workers-ai";
  if (wantAI && env.AI && typeof env.AI.run === "function") {
    return decideWorkersAI(env, input, settings);
  }
  const out = decideStub(input);
  out.engine = "stub";
  out.model = STUB_MODEL;
  if (wantAI) {
    // Asked for Workers AI but no AI binding is present (for example,
    // local dev). Never crash: fall back to the stub and say so out loud.
    out.warning = "ENGINE was set to workers-ai but no AI binding was found, so the stub answered instead.";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stub engine. Deterministic keyword heuristics. Honest about what it is.
// ---------------------------------------------------------------------------

function words(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

function joinQuoted(arr) {
  const q = arr.map((w) => '"' + w + '"');
  if (q.length === 1) return q[0];
  return q.slice(0, -1).join(", ") + " and " + q[q.length - 1];
}

const URGENCY_WORDS = [
  "urgent", "asap", "immediately", "immediate", "broken", "down",
  "angry", "furious", "refund", "cancel", "escalate", "critical",
  "emergency", "deadline", "fraud", "stolen", "hack", "lawsuit",
];
const CALM_WORDS = [
  "thanks", "thank", "question", "curious", "wondering", "maybe",
  "someday", "idea", "suggestion", "feedback", "hello",
];
const LIKELY_WORDS = ["yes", "definitely", "certainly", "sure", "will", "guaranteed", "always", "confirmed"];
const UNLIKELY_WORDS = ["no", "not", "never", "unlikely", "doubt", "cannot", "impossible", "wont"];

function countHits(haystack, needles) {
  const found = [];
  for (const w of needles) if (haystack.includes(w)) found.push(w);
  return found;
}

function decideStub(input) {
  const { kind, question, options, context } = input;
  const text = (question + " " + context).toLowerCase();
  if (kind === "pick") return stubPick(text, options);
  if (kind === "score") return stubScore(text);
  return stubProbability(text);
}

function stubPick(text, options) {
  const ws = new Set(words(text));
  let best = options[0];
  let bestScore = -1;
  let second = -1;
  let bestHits = [];
  for (const opt of options) {
    const ow = words(opt);
    let s = 0;
    const hits = [];
    for (const w of ow) {
      if (ws.has(w)) {
        s += 1;
        hits.push(w);
      }
    }
    if (text.includes(opt.toLowerCase())) s += 2; // full phrase match counts extra
    if (s > bestScore) {
      second = bestScore;
      bestScore = s;
      best = opt;
      bestHits = hits;
    } else if (s > second) {
      second = s;
    }
  }
  let confidence;
  if (bestScore <= 0) {
    confidence = 0.3; // no signal at all: say so with a low number
  } else {
    const margin = second < 0 ? 1 : (bestScore - second) / bestScore;
    confidence = 0.55 + 0.4 * margin;
  }
  confidence = round2(clamp01(confidence));
  const explanation =
    bestHits.length > 0
      ? "The message mentions " +
        joinQuoted(bestHits.slice(0, 3)) +
        ", which points to " +
        best +
        " more than the other options."
      : "Nothing in the message clearly matches any option, so this is a low-confidence guess. A human should review it before acting.";
  return { kind: "pick", pick: best, confidence, explanation };
}

function stubScore(text) {
  const ws = words(text);
  const urgent = countHits(ws, URGENCY_WORDS);
  const calm = countHits(ws, CALM_WORDS);
  let score = 25 + urgent.length * 12 - calm.length * 8;
  score = Math.max(5, Math.min(97, Math.round(score))); // math in code, never in the model
  const confidence = round2(clamp01(0.45 + 0.08 * Math.min(urgent.length, 5)));
  const explanation =
    urgent.length > 0
      ? "Found urgency words like " + joinQuoted(urgent.slice(0, 3)) + ", so this scored " + score + " out of 100."
      : "No strong urgency words found, so this scored " + score + " out of 100.";
  return { kind: "score", score, confidence, explanation };
}

function stubProbability(text) {
  const ws = words(text);
  const likely = countHits(ws, LIKELY_WORDS);
  const unlikely = countHits(ws, UNLIKELY_WORDS);
  const net = likely.length - unlikely.length;
  const probability = round2(clamp01(0.5 + 0.12 * Math.max(-4, Math.min(4, net))));
  const confidence = round2(clamp01(0.5 + 0.1 * Math.min(Math.abs(net), 4)));
  const explanation =
    net === 0
      ? "The message gives no clear signal either way, so this is a coin flip at " + Math.round(probability * 100) + "%."
      : "Signal words like " +
        joinQuoted(likely.concat(unlikely).slice(0, 3)) +
        " point to " +
        Math.round(probability * 100) +
        "%.";
  return { kind: "probability", probability, confidence, explanation };
}

// ---------------------------------------------------------------------------
// Workers AI engine. REAL code, but untested locally (no AI binding in dev).
// ---------------------------------------------------------------------------

function tryParseDecision(text, input) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, error: "the model did not return JSON" };
  let obj;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return { ok: false, error: "the model returned broken JSON" };
  }
  return validateDecisionObject(obj, input);
}

function validateDecisionObject(obj, input) {
  if (!obj || typeof obj !== "object") return { ok: false, error: "the model did not return an object" };
  const confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, error: "the model gave a bad confidence number" };
  }
  const explanation = sanitizeText(obj.explanation, 300) || "No explanation given.";
  if (input.kind === "pick") {
    const rawPick = String(obj.pick ?? "").trim();
    // Exact match first, then case-insensitive match back to the canonical
    // wording. Anything else is rejected: the model may never invent options.
    const canonical =
      input.options.find((o) => o === rawPick) ||
      input.options.find((o) => o.toLowerCase() === rawPick.toLowerCase());
    if (!canonical) return { ok: false, error: "the model picked something not on the allowed list" };
    return { ok: true, value: { kind: "pick", pick: canonical, confidence: round2(confidence), explanation } };
  }
  if (input.kind === "score") {
    const score = Number(obj.score);
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      return { ok: false, error: "the model gave a bad score" };
    }
    return { ok: true, value: { kind: "score", score: Math.round(score), confidence: round2(confidence), explanation } };
  }
  const probability = Number(obj.probability);
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    return { ok: false, error: "the model gave a bad probability" };
  }
  return { ok: true, value: { kind: "probability", probability: round2(probability), confidence: round2(confidence), explanation } };
}

async function decideWorkersAI(env, input, settings) {
  const { kind, question, options, context } = input;
  const criteria = settings.criteria || "";
  let taskLine;
  if (kind === "pick") {
    taskLine =
      "Pick exactly one option from this list and copy it word for word: " +
      options.map((o) => JSON.stringify(o)).join(", ") +
      '. Example of the exact format, with your own values: {"pick": "answer now", "confidence": 0.9, "explanation": "The customer has a billing question."}';
  } else if (kind === "score") {
    taskLine =
      'Give a score from 0 to 100. Example of the exact format, with your own values: {"score": 85, "confidence": 0.9, "explanation": "The customer is losing sales every minute."}';
  } else {
    taskLine =
      'Estimate the probability from 0 to 1 that the statement is true. Example of the exact format, with your own values: {"probability": 0.7, "confidence": 0.8, "explanation": "The message sounds likely but not certain."}';
  }
  const prompt =
    "You are AirPlain, a decision helper. Rules: never invent an option, use plain English, one sentence for the explanation.\n" +
    "Question: " +
    question +
    "\nBackground: " +
    context +
    "\nDecision instructions: " +
    criteria +
    "\n" +
    taskLine;

  const maxAttempts = 3; // validate and retry; never accept an invalid answer
  let lastError = "no valid answer";
  for (let i = 0; i < maxAttempts; i++) {
    let raw;
    try {
      raw = await env.AI.run(WORKERS_AI_MODEL, {
        prompt,
        response_format: { type: "json_object" },
      });
    } catch (e) {
      lastError = "the model call failed: " + (e && e.message ? e.message : String(e));
      break;
    }
    const resp = typeof raw === "string" ? null : raw.response;
    let parsed;
    if (resp && typeof resp === "object") {
      parsed = validateDecisionObject(resp, input); // JSON mode: already a parsed object
    } else {
      const text = typeof raw === "string" ? raw : resp || JSON.stringify(raw);
      parsed = tryParseDecision(text, input);
    }
    if (parsed.ok) {
      return { ...parsed.value, engine: "workers-ai", model: WORKERS_AI_MODEL };
    }
    lastError = parsed.error;
  }
  return {
    ok: false,
    engine: "workers-ai",
    model: WORKERS_AI_MODEL,
    error: "The model did not give a valid answer after 3 tries (" + lastError + "). No decision was made rather than a bad one.",
  };
}
