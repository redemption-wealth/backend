-- Heartbeat column for the treasury-inflow sweep (round-2 audit #6-alert).
-- Set on every successful sweep; GET /api/cron/health reports its staleness so
-- an external monitor can alert if the sweep stops running. Idempotent.
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS "lastInflowSweepAt" timestamptz;
