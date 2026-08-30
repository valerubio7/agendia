CREATE TABLE assistant_configs (
  business_id uuid PRIMARY KEY REFERENCES businesses(id), personality varchar(8000) NOT NULL DEFAULT '', tone varchar(8000) NOT NULL DEFAULT '',
  instructions varchar(8000) NOT NULL DEFAULT '', knowledge varchar(8000) NOT NULL DEFAULT '', rules varchar(8000) NOT NULL DEFAULT '',
  restrictions varchar(8000) NOT NULL DEFAULT '', active boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE assistant_configs ENABLE ROW LEVEL SECURITY; ALTER TABLE assistant_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_configs_tenant ON assistant_configs FOR ALL TO agendia_runtime USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON assistant_configs TO agendia_runtime;
