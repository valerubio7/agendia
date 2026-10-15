-- Interval endpoints retain validated input text; DAO derives exact epoch milliseconds.
-- No SQL timestamp interpretation, overlap exclusion or automatic coalescing.
CREATE TABLE business_calendar_closures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  kind text NOT NULL CHECK (kind IN ('date', 'interval')),
  closed_date date,
  start_raw text,
  end_raw text,
  start_ms bigint,
  end_ms bigint,
  CHECK (
    (kind = 'date' AND closed_date IS NOT NULL
      AND closed_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND start_raw IS NULL AND end_raw IS NULL AND start_ms IS NULL AND end_ms IS NULL)
    OR (kind = 'interval' AND closed_date IS NULL
      AND start_raw IS NOT NULL AND end_raw IS NOT NULL
      AND start_ms IS NOT NULL AND end_ms IS NOT NULL AND end_ms > start_ms
      AND start_ms BETWEEN -62135683140000 AND 253402387139999
      AND end_ms BETWEEN -62135683140000 AND 253402387139999)
  )
);
CREATE INDEX business_calendar_closures_business_id ON business_calendar_closures(business_id, id);
ALTER TABLE business_calendar_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_calendar_closures FORCE ROW LEVEL SECURITY;
CREATE POLICY business_calendar_closures_tenant ON business_calendar_closures FOR ALL TO agendia_runtime
  USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON business_calendar_closures TO agendia_runtime;
