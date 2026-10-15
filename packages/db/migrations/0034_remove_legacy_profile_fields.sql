-- Permanently retire free-text profile fields superseded by structured services
-- and business calendars. Retained profile fields and schedules are unchanged.
ALTER TABLE business_profiles
  DROP COLUMN business_hours,
  DROP COLUMN offerings;
