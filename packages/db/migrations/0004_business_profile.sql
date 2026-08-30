CREATE TABLE business_profiles (
  business_id uuid PRIMARY KEY REFERENCES businesses(id), display_name varchar(160) NOT NULL,
  description varchar(4000) NOT NULL DEFAULT '', address varchar(500) NOT NULL DEFAULT '', contact varchar(500) NOT NULL DEFAULT '',
  business_hours varchar(2000) NOT NULL DEFAULT '', offerings varchar(8000) NOT NULL DEFAULT '', faq varchar(8000) NOT NULL DEFAULT '',
  policies varchar(8000) NOT NULL DEFAULT '', additional_info varchar(8000) NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE business_profiles ENABLE ROW LEVEL SECURITY; ALTER TABLE business_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY business_profiles_tenant ON business_profiles FOR ALL TO agendia_runtime
USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON business_profiles TO agendia_runtime;
