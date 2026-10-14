-- Record selections with the pilot request; neither a seat nor a subscription is confirmed.
-- Apply before updating the live Worker that INSERTs these columns.
ALTER TABLE pilot_signups ADD COLUMN fare TEXT NOT NULL DEFAULT 'business';
ALTER TABLE pilot_signups ADD COLUMN preferred_seat TEXT;
