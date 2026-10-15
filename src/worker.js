// worker.js
// AirPlain Phase 1: shared decision core. Cloudflare Worker.
//
// Routes:
//   GET  /                friendly overview (plain English)
//   GET  /health           liveness check
//   POST /decide           the decision endpoint (pick | score | probability)
//   POST /feedback         mark a past decision right or wrong (feeds calibration)
//   GET  /calibration      plain-English report on how honest the confidence numbers are
//   GET  /settings         current settings registry
//   POST /settings         change settings (every change is logged in plain English)
//   GET  /changes          the paper trail: every settings change, newest first
//
// Nothing here deploys itself. Local dev only unless someone runs the deploy.

import {
  sanitizeText,
  stripTags,
  normalizeOptions,
  actionFor,
  bad,
  LIMITS,
  securityHeaders,
} from "./guardrails.js";
import { decide } from "./engine.js";
import { loadState, saveState, hashText, newId, defaultSettings } from "./store.js";
import { describeChange } from "./paperTrail.js";
import { calibrationReport } from "./calibration.js";
import { handleOnboarding } from "./onboarding.js";
import { checkLimit, limitError } from "./ratelimit.js";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", ...securityHeaders(false), ...extraHeaders },
  });
}

// The router's error formatter. Intentional errors (the plain-English 400s,
// 401s, 503s the code raises on purpose) keep their messages. Unexpected
// failures (no status, or a bare 500) NEVER leak internals like database
// messages or stack traces: they get a generic note instead.
function errorResponse(e) {
  const status = e.status || 500;
  const expected = e.status !== undefined && e.status !== 500;
  const message = expected
    ? e.message || "Something went wrong."
    : "Something went wrong on our side. Please try again in a moment.";
  const extra = status === 429 && e.retryAfter ? { "retry-after": String(e.retryAfter) } : {};
  return json({ error: message }, status, extra);
}

// Admin key check for the settings endpoint. Same constant-time comparison
// the /api/admin/* routes use. The key must be at least 32 characters;
// without a real key configured, nobody is authorized.
function secureCompare(a, b) {
  const aa = new TextEncoder().encode(a), bb = new TextEncoder().encode(b);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) diff |= (aa[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}

function authorizedAdmin(request, env) {
  const expected = String(env.AIRPLAIN_ADMIN_KEY || "");
  const auth = request.headers.get("authorization") || "";
  return expected.length >= 32 && auth.startsWith("Bearer ") && secureCompare(auth.slice(7), expected);
}

const ROUTES_HELP =
  "Try POST /decide, POST /feedback, GET /calibration, GET /settings, POST /settings, GET /changes, or POST /api/pilot-signup.";

// GET / serves the AirPlain landing page (Workers static assets).
// GET /api is the plain-English overview of the API.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path.startsWith("/api/admin/") || path.startsWith("/api/setup/")) return await handleOnboarding(request, env, path);
      if (request.method === "GET" && path === "/api") return handleApiOverview(env);
      if (request.method === "GET" && path === "/health") return handleHealth(env);
      if (request.method === "POST" && path === "/decide") return await handleDecide(request, env);
      if (request.method === "POST" && path === "/feedback") return await handleFeedback(request, env);
      if (request.method === "GET" && path === "/calibration") return await handleCalibration(env);
      if (request.method === "GET" && path === "/settings") return await handleGetSettings(env);
      if (request.method === "POST" && path === "/settings") return await handlePostSettings(request, env);
      if (request.method === "GET" && path === "/changes") return await handleChanges(env);
      if (request.method === "POST" && path === "/api/pilot-signup") return await handlePilotSignup(request, env);
      if (request.method === "GET") return await handleAsset(request, env);
      return json({ error: "Unknown route. " + ROUTES_HELP }, 404);
    } catch (e) {
      return errorResponse(e);
    }
  },
};

async function handleAsset(request, env) {
  // The landing page lives in site/index.html, served by Workers static assets.
  // In plain node tests there is no ASSETS binding, so answer plainly instead.
  if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
    const res = await env.ASSETS.fetch(request);
    const isPage = (res.headers.get("content-type") || "").includes("text/html");
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(securityHeaders(isPage))) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
  return json({ error: "The landing page is served by static assets, which are not connected here. " + ROUTES_HELP }, 404);
}

function handleApiOverview(env) {
  return json({
    product: "AirPlain",
    tagline: "AI routes plus AI notes. Decisions with a paper trail.",
    phase: "Phase 1: shared decision core",
    engine: String(env.ENGINE || "stub"),
    routes: {
      "POST /decide": "Ask a question, give the allowed answers, get back a decision.",
      "POST /feedback": "Tell AirPlain whether a past decision was right or wrong.",
      "GET /calibration": "Plain-English report on how honest the confidence numbers are.",
      "GET /settings": "See the current decision settings.",
      "POST /settings": "Change settings. Every change is written to the paper trail.",
      "GET /changes": "Read the paper trail, newest first.",
      "POST /api/pilot-signup": "Request a pilot spot. Saves name, business, email, and where messages pile up.",
      "GET /api/admin/applications": "Administrator-only review of seat applications.",
      "GET /api/setup/status": "Approved customer onboarding status.",
    },
  });
}

function handleHealth(env) {
  return json({
    ok: true,
    product: "AirPlain",
    phase: "Phase 1 shared core",
    engine: String(env.ENGINE || "stub"),
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function handleDecide(request, env) {
  // Every /decide call runs the AI model, which costs money. Per-IP limits
  // keep one script from running up the bill. Public demo use stays open.
  const limit = checkLimit(request, "decide", { perMinute: 20, perDay: 200 });
  if (!limit.ok) throw limitError(limit);

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    throw bad("Send JSON with question, kind, options, and context. " + ROUTES_HELP);
  }

  const kind = String(body.kind || "pick");
  if (!["pick", "score", "probability"].includes(kind)) {
    throw bad("kind must be pick, score, or probability.");
  }

  const question = sanitizeText(body.question, LIMITS.question);
  if (!question) throw bad("question is required and cannot be empty.");
  const context = sanitizeText(body.context, LIMITS.context);

  // pick REQUIRES the allowed list; score/probability may include one.
  let options = [];
  if (kind === "pick" || body.options !== undefined) {
    options = normalizeOptions(body.options);
  }

  const state = await loadState(env);
  const out = await decide(env, { kind, question, options, context }, state.settings);

  if (out.ok === false) {
    // The engine refused to answer rather than make something up.
    return json({ error: out.error, engine: out.engine }, 502);
  }

  const action = actionFor(out.confidence, state.settings);
  const id = newId("dec");
  const now = new Date().toISOString();
  state.decisions.push({
    id,
    time: now,
    kind,
    result: out.pick !== undefined ? out.pick : out.score !== undefined ? out.score : out.probability,
    confidence: out.confidence,
    action,
    engine: out.engine,
    model: out.model,
    questionHash: hashText(question + "|" + context), // hash only, never raw text
  });
  await saveState(env);

  const resp = {
    decision_id: id,
    kind,
    confidence: out.confidence,
    confidence_pct: Math.round(out.confidence * 100),
    action,
    action_meaning:
      action === "auto"
        ? "Confident enough to act on its own."
        : "Not confident enough to act alone. A human should review this.",
    explanation: out.explanation,
    engine: out.engine,
  };
  if (kind === "pick") resp.pick = out.pick;
  if (kind === "score") resp.score = out.score;
  if (kind === "probability") resp.probability = out.probability;
  if (out.warning) resp.warning = out.warning;
  return json(resp);
}

async function handleFeedback(request, env) {
  const body = await readJson(request);
  if (!body || typeof body !== "object") throw bad("Send JSON with decision_id and correct (true or false).");
  const decisionId = sanitizeText(body.decision_id, 100);
  if (typeof body.correct !== "boolean") throw bad("correct must be true or false.");
  const state = await loadState(env);
  const found = state.decisions.find((d) => d.id === decisionId);
  if (!found) throw bad("No decision found with that id. Check the decision_id and try again.");
  state.feedback[decisionId] = { correct: body.correct, time: new Date().toISOString() };
  await saveState(env);
  return json({
    ok: true,
    decision_id: decisionId,
    recorded: body.correct ? "marked correct" : "marked wrong",
    note: "This now counts toward the calibration report at GET /calibration.",
  });
}

async function handleCalibration(env) {
  const state = await loadState(env);
  const report = calibrationReport(state);
  return json({
    ...report,
    note: "Only decisions a human has marked right or wrong count here. Unchecked decisions are ignored.",
  });
}

async function handleGetSettings(env) {
  const state = await loadState(env);
  return json({
    settings: state.settings,
    note: "Change these with POST /settings. Every change is written to the paper trail at GET /changes.",
  });
}

async function handlePostSettings(request, env) {
  // Changing the decision brain is an owner-only action. No key, no change.
  if (!authorizedAdmin(request, env)) {
    const e = new Error("Administrator access required.");
    e.status = 401;
    throw e;
  }
  const body = await readJson(request);
  if (!body || typeof body !== "object") throw bad("Send JSON with the settings to change, for example {\"thresholds\": {\"auto\": 0.9}}.");
  const state = await loadState(env);
  const next = JSON.parse(JSON.stringify(state.settings));
  const newEntries = [];

  if (body.thresholds !== undefined) {
    if (typeof body.thresholds !== "object" || body.thresholds === null) {
      throw bad("thresholds must look like {\"auto\": 0.85}.");
    }
    for (const key of ["auto", "review"]) {
      if (body.thresholds[key] !== undefined) {
        const v = Number(body.thresholds[key]);
        if (!Number.isFinite(v) || v <= 0 || v >= 1) {
          throw bad("thresholds." + key + " must be a number between 0 and 1, like 0.85.");
        }
        if (v !== next.thresholds[key]) {
          const changeKey = "thresholds." + key;
          newEntries.push({
            id: newId("chg"),
            time: new Date().toISOString(),
            key: changeKey,
            oldValue: next.thresholds[key],
            newValue: v,
            summary: describeChange(changeKey, next.thresholds[key], v),
          });
          next.thresholds[key] = v;
        }
      }
    }
    if (next.thresholds.auto <= next.thresholds.review) {
      throw bad("The auto line must stay above the review line.");
    }
  }

  if (body.criteria !== undefined) {
    const v = sanitizeText(body.criteria, LIMITS.criteria);
    if (!v) throw bad("criteria cannot be empty.");
    if (v !== next.criteria) {
      newEntries.push({
        id: newId("chg"),
        time: new Date().toISOString(),
        key: "criteria",
        oldValue: next.criteria,
        newValue: v,
        summary: describeChange("criteria", next.criteria, v),
      });
      next.criteria = v;
    }
  }

  if (newEntries.length === 0) {
    return json({ settings: state.settings, changes: [], note: "Nothing changed, so nothing was logged." });
  }

  state.settings = next;
  state.changes.push(...newEntries);
  await saveState(env);
  return json({ settings: state.settings, changes: newEntries });
}

async function handleChanges(env) {
  const state = await loadState(env);
  const entries = [...state.changes].reverse(); // newest first
  return json({
    count: entries.length,
    changes: entries,
    note: "Every settings change AirPlain has ever made, newest first. There are no silent changes.",
  });
}

// POST /api/pilot-signup
// Saves a pilot spot request to the D1 database. Only the fields below are
// ever stored; anything extra in the request is ignored.
function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ""));
}

async function handlePilotSignup(request, env) {
  // Bots can flood an application list with junk. Per-IP limits keep the
  // list human. (Cloudflare Turnstile would add stronger bot protection;
  // that needs a site key from the Cloudflare dashboard first.)
  const limit = checkLimit(request, "pilot-signup", { perMinute: 3, perDay: 10 });
  if (!limit.ok) throw limitError(limit);

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    throw bad("Send your name, business name, and email as JSON to request a pilot spot.");
  }
  // Strip HTML tags before storing: markup must never reach the database,
  // no matter how a future page renders these fields.
  const name = stripTags(sanitizeText(body.name, 100));
  const business = stripTags(sanitizeText(body.business, 150));
  const email = stripTags(sanitizeText(body.email, 254)).toLowerCase();
  const where = stripTags(sanitizeText(body.where, 60));
  // Pilot requests do not create a subscription or reserve seats.
  const tier = sanitizeText(body.tier === undefined ? "business" : body.tier, 20).toLowerCase();
  const seat = body.seat == null || body.seat === "" ? null : sanitizeText(body.seat, 4).toUpperCase();
  const seatPreferences = {
    economy: ["6D", "8A", "9B"],
    business: ["3B", "4C", "5A"],
    first: ["1C", "2A", "2D"],
  };

  if (!name) throw bad("Please include your name so we know who is asking.");
  if (!business) throw bad("Please include your business name.");
  if (!isEmail(email)) throw bad("That email does not look right. Please check it and try again.");
  if (!Object.hasOwn(seatPreferences, tier)) throw bad("Choose Economy, Business, or First class before sending your request.");
  if (seat && !seatPreferences[tier].includes(seat)) throw bad("That seat preference does not match your selected fare.");
  if (tier === "economy" && where === "All of it") throw bad("Economy includes one channel. Please choose Email, Texts, or DMs.");

  if (!env.AIRPLAIN_DB || typeof env.AIRPLAIN_DB.prepare !== "function") {
    const e = new Error("Pilot signups are not connected yet. Please try again later.");
    e.status = 503;
    throw e;
  }

  const id = newId("signup");
  const now = new Date().toISOString();
  await env.AIRPLAIN_DB.prepare(
    "INSERT INTO pilot_signups (id, name, business, email, where_piled_up, fare, preferred_seat, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(id, name, business, email, where || null, tier, seat, now)
    .run();

  return json({
    ok: true,
    request_id: id,
    fare: tier,
    preferred_seat: seat,
    message: "You're on the list. NaLonni will reply personally within two business days to schedule a 20-minute call.",
  });
}
