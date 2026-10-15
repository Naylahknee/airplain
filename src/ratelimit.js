// ratelimit.js
// Per-IP rate limiting for the public write endpoints (/decide, /api/pilot-signup).
//
// This is per-isolate in-memory state: when Cloudflare rotates the isolate the
// counters reset, and a distributed attacker can spread across isolates. That
// makes this abuse friction, not a guarantee. The limits are documented in
// plain numbers below so the tradeoff is visible, not hidden.
//
// Limits are intentionally strict: /decide calls a paid AI model on every
// request, and pilot signup is a human form (one submission is normal).

const buckets = new Map(); // "name|ip" -> { windowStart, count, day, dayCount }
const MAX_BUCKETS = 10000;

function clientIp(request) {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return String(xff).split(",")[0].trim();
  return "unknown";
}

// Returns { ok: true } or { ok: false, scope: "minute"|"day", retryAfter }.
export function checkLimit(request, name, { perMinute, perDay }) {
  const now = Date.now();
  const day = Math.floor(now / 86400000);
  const key = name + "|" + clientIp(request);
  let b = buckets.get(key);
  if (!b || b.day !== day) b = { windowStart: now, count: 0, day, dayCount: 0 };
  if (now - b.windowStart >= 60000) {
    b.windowStart = now;
    b.count = 0;
  }
  b.count += 1;
  b.dayCount += 1;
  buckets.set(key, b);
  if (buckets.size > MAX_BUCKETS) {
    // Shed the oldest day's buckets first; this is a cache, not a ledger.
    for (const [k, v] of buckets) {
      if (v.day !== day) buckets.delete(k);
      if (buckets.size <= MAX_BUCKETS - 1000) break;
    }
  }
  if (b.dayCount > perDay) return { ok: false, scope: "day" };
  if (b.count > perMinute) {
    return {
      ok: false,
      scope: "minute",
      retryAfter: Math.max(1, Math.ceil((60000 - (now - b.windowStart)) / 1000)),
    };
  }
  return { ok: true };
}

// Build the 429 error the router turns into a plain-English response.
export function limitError(result) {
  const e = new Error(
    result.scope === "day"
      ? "You have reached the daily limit for this. Please try again tomorrow."
      : "Too many requests. Please wait a moment and try again."
  );
  e.status = 429;
  if (result.retryAfter) e.retryAfter = result.retryAfter;
  return e;
}

// Test helper only: clears all counters. Not used by any production path.
export function resetRateLimits() {
  buckets.clear();
}
