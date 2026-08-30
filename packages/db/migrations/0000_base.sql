-- AgendIA base: migration role owns DDL; runtime roles never own tenant tables.
DO $$ BEGIN
  CREATE ROLE agendia_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE agendia_admin_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE agendia_whatsapp_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE agendia_worker_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE businesses (
  id uuid PRIMARY KEY,
  name varchar(160) NOT NULL CHECK (length(trim(name)) > 0),
  status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_technical_activity_at timestamptz
);

-- A minimal tenant-owned relation proves the policy before feature tables exist.
CREATE TABLE tenant_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  value text NOT NULL,
  UNIQUE (business_id, id)
);

ALTER TABLE tenant_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_records_business_user ON tenant_records
  FOR ALL TO agendia_runtime
  USING (
    current_setting('app.actor_role', true) = 'business_user'
    AND business_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('app.actor_role', true) = 'business_user'
    AND business_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );
-- Admin has table visibility only when an explicit policy is added; currently zero rows.
CREATE POLICY tenant_records_admin_deny ON tenant_records FOR SELECT TO agendia_admin_runtime USING (false);

GRANT USAGE ON SCHEMA public TO agendia_runtime, agendia_admin_runtime, agendia_whatsapp_runtime, agendia_worker_runtime;
GRANT SELECT, INSERT, UPDATE ON tenant_records TO agendia_runtime;
GRANT SELECT ON tenant_records, businesses TO agendia_admin_runtime;
GRANT SELECT ON businesses TO agendia_runtime, agendia_whatsapp_runtime, agendia_worker_runtime;
