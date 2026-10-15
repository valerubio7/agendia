-- Weekly values use Sunday=0 .. Saturday=6, integer minutes and overnight spans.
CREATE FUNCTION valid_business_weekly_schedule(schedule jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE day record; span jsonb; start_min numeric; end_min numeric;
BEGIN
  IF jsonb_typeof(schedule) <> 'object' THEN RETURN false; END IF;
  FOR day IN SELECT * FROM jsonb_each(schedule) LOOP
    IF day.key !~ '^[0-6]$' OR jsonb_typeof(day.value) <> 'array' THEN RETURN false; END IF;
    FOR span IN SELECT * FROM jsonb_array_elements(day.value) LOOP
      IF jsonb_typeof(span) <> 'object'
        OR NOT (span ? 'startMinute' AND span ? 'endMinute')
        OR (span - 'startMinute' - 'endMinute') <> '{}'::jsonb
        OR jsonb_typeof(span->'startMinute') <> 'number'
        OR jsonb_typeof(span->'endMinute') <> 'number' THEN RETURN false; END IF;
      start_min := (span->>'startMinute')::numeric;
      end_min := (span->>'endMinute')::numeric;
      IF start_min <> trunc(start_min) OR end_min <> trunc(end_min)
        OR start_min < 0 OR start_min > 1439 OR end_min < 0 OR end_min > 1440
        OR start_min = end_min THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  RETURN true;
END $$;

CREATE TABLE business_calendars (
  business_id uuid PRIMARY KEY REFERENCES businesses(id),
  weekly_schedule jsonb NOT NULL CHECK (valid_business_weekly_schedule(weekly_schedule))
);
ALTER TABLE business_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_calendars FORCE ROW LEVEL SECURITY;
CREATE POLICY business_calendars_tenant ON business_calendars FOR ALL TO agendia_runtime
  USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON business_calendars TO agendia_runtime;
