# AirPlain, Phase 1: shared decision core

AI routes plus AI notes. Decisions with a paper trail.

This is Phase 1 only: one decision endpoint, honest confidence tracking,
and a plain-English paper trail for every settings change. No model training,
no accounts, no spending. Built to run on Cloudflare Workers.

## Run it locally

```bash
cd ~/workspace/airplain
node test/run.mjs        # runs the acceptance tests, no network needed
npx wrangler dev --port 8787   # serves it locally at http://localhost:8787
```

## Endpoints

| Method | Route | What it does |
|---|---|---|
| GET | / | The AirPlain landing page (static asset) |
| GET | /api | Plain-English overview of the API |
| GET | /health | Liveness check |
| POST | /api/pilot-signup | Request a pilot spot (saves to D1) |
| POST | /decide | Ask a question, get a decision |
| POST | /feedback | Mark a past decision right or wrong |
| GET | /calibration | Plain-English honesty report on confidence numbers |
| GET | /settings | See the current settings |
| POST | /settings | Change settings (always logged) |
| GET | /changes | The paper trail, newest first |

### POST /api/pilot-signup

```json
{ "name": "Jane Doe", "business": "Doe's Bakery", "email": "jane@doesbakery.com", "where": "Email" }
```

Saves a pilot spot request to the `pilot_signups` table in the `airplain`
D1 database. `name`, `business`, and `email` are required; `email` must
look like an email address. Only those four fields are ever stored, plus
an id and timestamp. Bad input gets a 400 with a plain-English message.

### POST /decide

```json
{
  "question": "Where should this ticket go?",
  "kind": "pick",
  "options": ["billing", "tech support", "sales"],
  "context": "Customer says: my invoice is wrong"
}
```

`kind` can be `pick` (choose from the list), `score` (0 to 100), or
`probability` (0 to 1). For `pick`, options are required. The model is
forced to answer only from the allowed list: answers are validated,
retried up to 3 times, and never invented.

Response:

```json
{
  "decision_id": "dec_abc123",
  "kind": "pick",
  "pick": "billing",
  "confidence": 0.82,
  "confidence_pct": 82,
  "action": "needs_human_review",
  "action_meaning": "Not confident enough to act alone. A human should review this.",
  "explanation": "The message mentions \"invoice\", which points to billing more than the other options.",
  "engine": "stub"
}
```

`action` is `auto` at or above the auto line (default 85%) and
`needs_human_review` below it. No exceptions.

### POST /feedback

```json
{ "decision_id": "dec_abc123", "correct": true }
```

### GET /calibration

Plain-English report, for example: "When AirPlain said it was 80 to 90%
sure, it was right 7 out of 8 times." Only human-checked decisions count.

### POST /settings and GET /changes

Change thresholds or the decision instructions. Every change writes one
plain-English entry, for example: "The auto-act line moved from 85% to
90% confidence. From now on, fewer decisions will act on their own and
more will ask a human first." There are no silent changes.

## Stub vs. real

Today `/decide` runs on the **stub engine**: a small, deterministic keyword
heuristic. Every response says `"engine": "stub"` so nobody mistakes it
for a real model. It exists so Phase 1 works with zero accounts and zero
spending.

The **Workers AI engine** is implemented in `src/engine.js` (open-weight
model `@cf/meta/llama-3.1-8b-instruct`, strict JSON output, allowed-list
validation, 3 retries). It activates when `ENGINE` is set to `workers-ai`
AND the Worker has the `AI` binding. It has not run yet because the
binding only exists on a real deploy.

## What is real vs. scaffold

- Real: input sanitizing, fixed option ordering, allowed-list enforcement,
  validation with retries, confidence math in code, action thresholds,
  settings registry, paper-trail logging, decision logging, feedback,
  calibration math and plain-English reporting.
- Scaffold: the stub's keyword "thinking" (a placeholder until a real
  model is plugged in), in-memory storage (fine locally; deploy should
  add the KV binding shown in wrangler.toml).

## Deploy checklist (NOT done)

- [ ] Create the D1 database and `pilot_signups` table (done 2026-10-12 via the Cloudflare API; migrations in `migrations/` keep local dev in sync)
- [ ] Uncomment the `[ai]` binding in wrangler.toml and set `ENGINE = "workers-ai"`
- [ ] Create one KV namespace, paste its id into wrangler.toml, uncomment `[[kv_namespaces]]`
- [ ] Run `node test/run.mjs` again after the switch
- [ ] Exercise the Workers AI path once and confirm allowed-list enforcement holds
- [ ] Get NaLonni's explicit approval before deploying (her rule)
