ALTER TABLE services DROP CONSTRAINT services_duration_minutes_check;
ALTER TABLE services ADD CONSTRAINT services_duration_minutes_check CHECK (duration_minutes > 0 AND duration_minutes % 5 = 0);

ALTER TABLE appointments DROP CONSTRAINT appointments_duration_minutes_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_duration_minutes_check CHECK (duration_minutes > 0 AND duration_minutes % 5 = 0);
