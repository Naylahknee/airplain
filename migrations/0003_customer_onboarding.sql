-- 0003: approved customer onboarding, stored separately from seat applications.
-- Apply to production D1 BEFORE deploying the onboarding Worker.
-- A seat application never auto-approves itself.
CREATE TABLE IF NOT EXISTS onboarding_profiles (
  signup_id TEXT PRIMARY KEY REFERENCES pilot_signups(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  approved_at TEXT,
  declined_at TEXT,
  preferred_channels TEXT NOT NULL DEFAULT '[]',
  routes_json TEXT,
  preferences_saved_at TEXT,
  rules_text TEXT,
  rules_approved_at TEXT,
  last_test_engine TEXT,
  last_test_result TEXT,
  last_test_at TEXT,
  gmail_address TEXT,
  gmail_refresh_encrypted TEXT,
  gmail_connected_at TEXT,
  microsoft_address TEXT,
  microsoft_refresh_encrypted TEXT,
  microsoft_connected_at TEXT
);
CREATE TABLE IF NOT EXISTS onboarding_invites (
  id TEXT PRIMARY KEY,
  signup_id TEXT NOT NULL REFERENCES pilot_signups(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_onboarding_invites_signup ON onboarding_invites(signup_id);
CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id TEXT PRIMARY KEY,
  signup_id TEXT NOT NULL REFERENCES pilot_signups(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_signup ON onboarding_sessions(signup_id);
CREATE TABLE IF NOT EXISTS onboarding_oauth_states (
  state_hash TEXT PRIMARY KEY,
  signup_id TEXT NOT NULL REFERENCES pilot_signups(id),
  verifier TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('gmail','microsoft')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS onboarding_events (
  id TEXT PRIMARY KEY,
  signup_id TEXT NOT NULL REFERENCES pilot_signups(id),
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_onboarding_events_signup ON onboarding_events(signup_id);
