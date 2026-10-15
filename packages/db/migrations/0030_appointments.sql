-- Installer requires permission to CREATE the trusted btree_gist extension
-- (including database CREATE), or an administrator must preinstall it.
-- Production installer privileges are not inferred; runtime grants stay narrow.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Frozen server snapshot: logical catalog IDs, labels and agreed service terms.
-- Current client names are joined through client_id, never copied into history.
-- SQL validates scalar shape/ownership, not caller authority or current prices.
-- Like calendar closures, start_raw is retained verbatim; repository B validates
-- it with parseInstantMs and derives the matching epoch from trusted input.
-- No SQL timestamp conversion/calendar parser or arbitrary future horizon.
CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  client_id uuid NOT NULL,
  service_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  customer_resource_preference_id uuid,
  service_label text NOT NULL CHECK (
    btrim(service_label, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> ''
  ),
  resource_label text NOT NULL CHECK (
    btrim(resource_label, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> ''
  ),
  price_ars numeric NOT NULL CHECK (price_ars >= 0 AND price_ars < 'Infinity'::numeric),
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0 AND duration_minutes % 15 = 0),
  start_raw text NOT NULL,
  start_ms bigint NOT NULL CHECK (start_ms BETWEEN -62135683140000 AND 253402387139999),
  end_ms bigint NOT NULL CHECK (end_ms BETWEEN -62135683140000 AND 253402387139999),
  -- Numeric arithmetic makes this coherence check safe even for malformed bigint input.
  CHECK (end_ms > start_ms AND end_ms::numeric = start_ms::numeric + duration_minutes::numeric * 60000),
  state text NOT NULL CHECK (state IN ('confirmed', 'done', 'cancelled', 'no_show')),
  origin text NOT NULL CHECK (origin IN ('manual', 'ai')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, client_id) REFERENCES clients(business_id, id),
  FOREIGN KEY (business_id, service_id) REFERENCES services(business_id, id),
  FOREIGN KEY (business_id, resource_id) REFERENCES resources(business_id, id),
  FOREIGN KEY (business_id, customer_resource_preference_id) REFERENCES resources(business_id, id),
  -- No cascades: catalog deletion must not erase appointment history (T09).
  CONSTRAINT appointments_confirmed_capacity EXCLUDE USING gist (
    business_id WITH =,
    resource_id WITH =,
    int8range(start_ms, end_ms, '[)') WITH &&
  ) WHERE (state = 'confirmed')
);

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
CREATE POLICY appointments_tenant ON appointments FOR ALL TO agendia_runtime
  USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON appointments TO agendia_runtime;
