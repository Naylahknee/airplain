// store.js
// State for AirPlain v1: settings registry, decision log, feedback, change log.
//
// LOCAL (how Phase 1 runs): everything lives in memory (module scope).
// That is fine for local dev and tests.
//
// DEPLOY: set the AIRPLAIN_KV binding (see wrangler.toml comments) and the
// same code persists to Workers KV instead. No code changes needed.
//
// Privacy rule, enforced here: we NEVER store raw customer message text.
// Decisions store a short hash of the question plus the outcome. That is
// enough for calibration and the paper trail, and nothing more.

const DEFAULT_SETTINGS = {
  thresholds: { auto: 0.85, review: 0.5 },
  criteria: "Choose the option the message best matches. When unsure, say so with low confidence.",
  version: 1,
};

const KV_KEY = "airplain-state-v1";

let mem = null;

function seed() {
  return {
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    decisions: [], // {id, time, kind, result, confidence, action, engine, model, questionHash}
    feedback: {}, // decisionId -> {correct: true/false, time}
    changes: [], // {id, time, key, oldValue, newValue, summary}
  };
}

export function defaultSettings() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

export async function loadState(env) {
  if (mem) return mem;
  if (env.AIRPLAIN_KV) {
    try {
      const raw = await env.AIRPLAIN_KV.get(KV_KEY);
      if (raw) {
        mem = JSON.parse(raw);
        return mem;
      }
    } catch (e) {
      // KV hiccup: fall through to memory rather than crash.
    }
  }
  mem = seed();
  // The first paper-trail entry: how AirPlain started. No silent defaults.
  mem.changes.push({
    id: "chg_init",
    time: new Date().toISOString(),
    key: "settings",
    oldValue: null,
    newValue: mem.settings,
    summary:
      "AirPlain started with default settings: decisions at 85% confidence or higher may act on their own, anything lower needs a human. Decision instructions set to the default text.",
  });
  return mem;
}

export async function saveState(env) {
  if (!mem) return;
  if (env.AIRPLAIN_KV) {
    try {
      await env.AIRPLAIN_KV.put(KV_KEY, JSON.stringify(mem));
    } catch (e) {
      // Best effort only.
    }
  }
}

// FNV-1a hash. Not cryptographic, just a stand-in so raw text never rests here.
export function hashText(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ("0000000" + (h >>> 0).toString(16)).slice(-8);
}

export function newId(prefix) {
  const rand =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return prefix + "_" + Date.now().toString(36) + "_" + rand;
}
