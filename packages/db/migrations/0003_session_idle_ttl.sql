-- NULL preserves the previous idle policy for sessions issued before this migration.
ALTER TABLE web_sessions ADD COLUMN idle_ttl_ms bigint;
