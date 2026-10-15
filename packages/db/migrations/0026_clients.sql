CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  first_name text NOT NULL,
  last_name text NOT NULL,
  phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{1,14}$'),
  CHECK (btrim(first_name, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> ''),
  CHECK (btrim(last_name, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> ''),
  CONSTRAINT clients_business_phone_key UNIQUE (business_id, phone),
  -- Future appointment FKs can enforce tenant identity without copying names.
  CONSTRAINT clients_business_id_key UNIQUE (business_id, id)
);

-- Names remain unbounded text: no name uniqueness or name Btree index.
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients FORCE ROW LEVEL SECURITY;
CREATE POLICY clients_tenant ON clients FOR ALL TO agendia_runtime
  USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON clients TO agendia_runtime;
