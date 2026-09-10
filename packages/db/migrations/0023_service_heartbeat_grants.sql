-- Manager and worker runtime identities inherit only these capability roles.
-- The upsert needs every inserted column, its three mutable columns, and reads
-- of the conflict and mutable columns; started_at remains insert-only.
GRANT INSERT (service, instance_id, release_digest, state, started_at, last_seen_at),
  UPDATE (release_digest, state, last_seen_at),
  SELECT (service, instance_id, release_digest, state, last_seen_at)
  ON agendia_service_heartbeats
  TO agendia_whatsapp_runtime, agendia_worker_runtime;
