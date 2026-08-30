ALTER TABLE audit_events
  ADD COLUMN stream_sequence bigint NOT NULL CHECK (stream_sequence > 0),
  ADD COLUMN previous_hash varchar(64) NOT NULL CHECK (previous_hash ~ '^[0-9a-f]{64}$' OR previous_hash = 'GENESIS'),
  ADD COLUMN event_hash char(64) NOT NULL CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN hmac_key_version text NOT NULL CHECK (length(hmac_key_version) > 0);

CREATE UNIQUE INDEX audit_events_stream_sequence_idx
  ON audit_events ((coalesce(business_id::text, 'platform')), stream_sequence);
CREATE INDEX audit_events_verify_idx
  ON audit_events (business_id, stream_sequence, previous_hash, event_hash);

CREATE OR REPLACE FUNCTION project_last_technical_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE businesses
  SET last_technical_activity_at = greatest(
    coalesce(last_technical_activity_at, NEW.occurred_at),
    NEW.occurred_at
  )
  WHERE id = NEW.business_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER technical_events_project_activity
AFTER INSERT ON technical_events
FOR EACH ROW EXECUTE FUNCTION project_last_technical_activity();

CREATE TABLE operational_controls (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  automation_disabled boolean NOT NULL DEFAULT false,
  incident_reference text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT automation_disabled OR length(trim(incident_reference)) > 0)
);
INSERT INTO operational_controls (singleton) VALUES (true);
REVOKE ALL ON operational_controls FROM PUBLIC;
GRANT SELECT ON operational_controls TO agendia_worker_runtime, agendia_whatsapp_runtime;
-- Operations update this singleton through the deployment control plane using the DDL owner.
