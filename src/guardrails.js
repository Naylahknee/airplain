// guardrails.js
// Input cleaning and safety rules for AirPlain.
// Everything in this file is REAL and runs on every request.
// Plain rule: never trust raw input, never let the model do math,
// and never invent an answer that was not on the allowed list.

export const LIMITS = {
  question: 2000,
  context: 8000,
  criteria: 2000,
  optionsMax: 50,
  optionLen: 200,
};

// bad() makes an error the router turns into a 400 with a plain-English message.
export function bad(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

// Remove control characters, trim, and cap length.
export function sanitizeText(value, maxLen) {
  let s = String(value ?? "");
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  s = s.trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

// Strip anything shaped like an HTML tag. Defense in depth: values saved to
// the database must never contain markup, no matter how a future page
// renders them. Not a substitute for escaping on render.
export function stripTags(value) {
  return String(value ?? "").replace(/<[^>]*>/g, "");
}

// Security headers for every response the worker sends.
// page=true for the HTML landing/admin/setup pages (they use inline scripts
// and styles plus Google Fonts, so the CSP allows those and nothing else).
// API and error responses get the strictest policy: no active content at all.
const API_CSP = "default-src 'none'; frame-ancestors 'none'";
const PAGE_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export function securityHeaders(page = false) {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "strict-transport-security": "max-age=31536000",
    "content-security-policy": page ? PAGE_CSP : API_CSP,
  };
}

// Clean the allowed-answers list: dedupe, drop empties, cap size,
// and ALWAYS return them in the same deterministic order.
// Fixed order matters: some models answer differently when options
// are shuffled, so we never let the order be an accident.
export function normalizeOptions(raw) {
  if (!Array.isArray(raw)) throw bad("options must be a list of allowed answers.");
  const seen = new Map();
  for (const item of raw) {
    const clean = sanitizeText(item, LIMITS.optionLen);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (!seen.has(key)) seen.set(key, clean); // keep first wording on dupes
  }
  const list = [...seen.values()];
  if (list.length === 0) throw bad("Give at least one allowed answer in options.");
  if (list.length > LIMITS.optionsMax) throw bad("Too many options. The limit is " + LIMITS.optionsMax + ".");
  list.sort((a, b) => a.localeCompare(b));
  return list;
}

// All number shaping happens here, in regular code, never in the model.
export function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function round2(n) {
  return Math.round(clamp01(n) * 100) / 100;
}

// The action rule from the spec: at or above the auto line the decision
// may act on its own; below it, a human must review. No exceptions.
export function actionFor(confidence, settings) {
  const autoLine = settings.thresholds.auto;
  return confidence >= autoLine ? "auto" : "needs_human_review";
}
