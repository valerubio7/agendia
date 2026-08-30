CREATE TABLE conversation_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL, conversation_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0), covered_through bigint NOT NULL CHECK (covered_through >= 0),
  structured_summary jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, conversation_id, version), UNIQUE (business_id, id),
  FOREIGN KEY (business_id, conversation_id) REFERENCES conversations(business_id, id)
);
ALTER TABLE conversation_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_summaries FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_summaries_worker ON conversation_summaries FOR ALL TO agendia_worker_runtime
  USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON conversation_summaries TO agendia_worker_runtime;
CREATE INDEX messages_context_order_idx ON messages (business_id, conversation_id, sequence DESC);
CREATE INDEX messages_context_search_idx ON messages USING gin (to_tsvector('simple', raw_text));
-- Every retrieval query must still include business_id and conversation_id; the index never weakens forced RLS.
