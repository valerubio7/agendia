CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES businesses(id),
  actor_id text,
  event_type text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  request_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE TABLE technical_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  component text NOT NULL,
  code text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  safe_details jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id),
  topic text NOT NULL, stable_key text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
  UNIQUE (business_id, stable_key), UNIQUE (business_id, id)
);
CREATE TABLE inbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id),
  source text NOT NULL, stable_key text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, source, stable_key), UNIQUE (business_id, id)
);

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['audit_events','technical_events','outbox_events','inbox_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO agendia_runtime USING (business_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (business_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t || '_tenant', t);
END LOOP; END $$;
GRANT SELECT, INSERT ON audit_events, technical_events, outbox_events, inbox_events TO agendia_runtime;
GRANT UPDATE (published_at) ON outbox_events TO agendia_worker_runtime;

CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit events are append-only'; END $$;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
