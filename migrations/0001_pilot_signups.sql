-- 0001: pilot signup requests for the AirPlain landing page.
-- Only these six columns are ever stored. Nothing else.
CREATE TABLE IF NOT EXISTS pilot_signups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  business TEXT NOT NULL,
  email TEXT NOT NULL,
  where_piled_up TEXT,
  created_at TEXT NOT NULL
);
