-- Retain catalog identity/FKs and appointment history; retirement never overloads status.
ALTER TABLE services ADD COLUMN deleted_at timestamptz;
ALTER TABLE resources ADD COLUMN deleted_at timestamptz;

-- Deleted names may be reused by NEW IDs. Active and suspended LIVE rows still
-- share the same full-digest Unicode case/outer-trim uniqueness policy.
DROP INDEX services_business_name_key;
CREATE UNIQUE INDEX services_business_name_key
  ON services (business_id, service_name_sha256(normalized_name)) WHERE deleted_at IS NULL;
DROP INDEX resources_business_name_key;
CREATE UNIQUE INDEX resources_business_name_key
  ON resources (business_id, service_name_sha256(normalized_name)) WHERE deleted_at IS NULL;
-- Ownership keys, historical FKs, forced RLS and narrow runtime grants are unchanged.
