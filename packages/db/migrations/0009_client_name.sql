-- Backfill in place (including legacy rows retained for deleted businesses).
-- The transactional DDL locks both tables; only the migration owner bypasses forced RLS.
ALTER TABLE clients ADD COLUMN name text;
ALTER TABLE clients NO FORCE ROW LEVEL SECURITY;
ALTER TABLE clients DISABLE TRIGGER business_live_write;
ALTER TABLE appointment_operation_receipts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE appointment_operation_receipts DISABLE TRIGGER business_live_write;

DO $$
DECLARE
  whitespace CONSTANT text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
  runs CONSTANT text := '[' || whitespace || ']+';
BEGIN
  UPDATE clients SET name = btrim(regexp_replace(first_name || ' ' || last_name, runs, ' ', 'g'));

  -- Migrate the historical snapshot, not today's client row. Keep the original
  -- fingerprints: a split-name payload cannot be recovered from its digest.
  UPDATE appointment_operation_receipts
  SET result = jsonb_set(result, '{body,client}',
    (result #> '{body,client}') - 'firstName' - 'lastName' || jsonb_build_object('name',
      btrim(regexp_replace((result #>> '{body,client,firstName}') || ' ' ||
        (result #>> '{body,client,lastName}'), runs, ' ', 'g'))))
  WHERE state = 'completed'
    AND jsonb_typeof(result #> '{body,client,firstName}') = 'string'
    AND jsonb_typeof(result #> '{body,client,lastName}') = 'string';
END $$;

ALTER TABLE clients ALTER COLUMN name SET NOT NULL,
  ADD CONSTRAINT clients_name_nonblank CHECK (
    btrim(name, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> ''
  ),
  DROP COLUMN first_name,
  DROP COLUMN last_name;
ALTER TABLE clients ENABLE TRIGGER business_live_write;
ALTER TABLE clients FORCE ROW LEVEL SECURITY;
ALTER TABLE appointment_operation_receipts ENABLE TRIGGER business_live_write;
ALTER TABLE appointment_operation_receipts FORCE ROW LEVEL SECURITY;
