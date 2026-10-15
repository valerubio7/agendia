-- Composite keys enforce catalog ownership even for privileged SQL writers.
ALTER TABLE services ADD CONSTRAINT services_business_id_id_key UNIQUE (business_id, id);

CREATE TABLE resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  name text NOT NULL,
  description text,
  normalized_name text COLLATE "C" GENERATED ALWAYS AS (
    lower(btrim(name, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') COLLATE service_name_case)
  ) STORED,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  weekly_schedule jsonb NOT NULL CHECK (valid_business_weekly_schedule(weekly_schedule)),
  CHECK (normalized_name <> ''),
  UNIQUE (business_id, id)
);
-- Same approved full-digest policy as services: no text/index length cap.
CREATE UNIQUE INDEX resources_business_name_key
  ON resources (business_id, service_name_sha256(normalized_name));

CREATE TABLE resource_services (
  business_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  service_id uuid NOT NULL,
  PRIMARY KEY (business_id, resource_id, service_id),
  FOREIGN KEY (business_id, resource_id) REFERENCES resources(business_id, id),
  FOREIGN KEY (business_id, service_id) REFERENCES services(business_id, id)
);

ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources FORCE ROW LEVEL SECURITY;
CREATE POLICY resources_tenant ON resources FOR ALL TO agendia_runtime
  USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE resource_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_services FORCE ROW LEVEL SECURITY;
CREATE POLICY resource_services_tenant ON resource_services FOR ALL TO agendia_runtime
  USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- Deletion/future-booking lifecycle guards integrate in T09, not against fictional tables.
GRANT SELECT, INSERT, UPDATE ON resources TO agendia_runtime;
GRANT SELECT, INSERT, DELETE ON resource_services TO agendia_runtime;
