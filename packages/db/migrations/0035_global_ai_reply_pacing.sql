ALTER TABLE operational_controls
  ADD COLUMN initial_delay_seconds integer NOT NULL DEFAULT 600
    CHECK (initial_delay_seconds BETWEEN 0 AND 86400),
  ADD COLUMN active_delay_seconds integer NOT NULL DEFAULT 90
    CHECK (active_delay_seconds BETWEEN 0 AND 86400),
  ADD COLUMN inactivity_reset_seconds integer NOT NULL DEFAULT 3600
    CHECK (inactivity_reset_seconds BETWEEN 1 AND 604800);

GRANT SELECT (initial_delay_seconds, active_delay_seconds, inactivity_reset_seconds),
  UPDATE (initial_delay_seconds, active_delay_seconds, inactivity_reset_seconds)
  ON operational_controls TO agendia_admin_runtime;
-- Ingest reads the current policy without access to supplementary instructions.
GRANT SELECT (initial_delay_seconds, active_delay_seconds, inactivity_reset_seconds)
  ON operational_controls TO agendia_whatsapp_runtime;
-- Workers retain their existing read-only grant; neither processing role may edit policy.
