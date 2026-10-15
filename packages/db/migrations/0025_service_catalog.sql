-- ICU's locale-neutral lowercase includes contextual Unicode mappings (e.g. Greek sigma).
CREATE COLLATION service_name_case (provider = icu, locale = 'und', deterministic = true);

-- Fixed UTF-8 conversion is deterministic within this database. The immutable wrapper
-- permits indexing despite convert_to's conservative STABLE volatility declaration.
CREATE FUNCTION service_name_sha256(text) RETURNS bytea
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT pg_catalog.sha256(pg_catalog.convert_to($1, 'UTF8')) $$;

CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  name text NOT NULL,
  description text,
  -- Explicit ECMAScript TrimString whitespace; ordinary btrim only removes ASCII spaces.
  normalized_name text COLLATE "C" GENERATED ALWAYS AS (
    lower(btrim(name, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') COLLATE service_name_case)
  ) STORED,
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0 AND duration_minutes % 15 = 0),
  price_ars numeric NOT NULL CHECK (price_ars >= 0 AND price_ars < 'Infinity'::numeric),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  CHECK (normalized_name <> '')
);

-- A bounded full digest supports unbounded names. Theoretical collision false
-- conflicts are explicitly accepted; do not truncate the digest or the name.
CREATE UNIQUE INDEX services_business_name_key
  ON services (business_id, service_name_sha256(normalized_name));

ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE services FORCE ROW LEVEL SECURITY;
CREATE POLICY services_tenant ON services FOR ALL TO agendia_runtime
  USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON services TO agendia_runtime;
