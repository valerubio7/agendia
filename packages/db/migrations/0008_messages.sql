CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL,
  connection_id uuid NOT NULL, remote_jid text NOT NULL, next_sequence bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, connection_id, remote_jid), UNIQUE (business_id, id),
  FOREIGN KEY (business_id, connection_id) REFERENCES whatsapp_connections(business_id, id)
);
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL, conversation_id uuid NOT NULL,
  connection_id uuid NOT NULL, provider_message_id text NOT NULL, sequence bigint NOT NULL,
  direction varchar(16) NOT NULL CHECK (direction IN ('inbound','outbound')),
  raw_text text NOT NULL, received_at timestamptz NOT NULL, processing_state varchar(24) NOT NULL DEFAULT 'pending',
  UNIQUE (business_id, connection_id, provider_message_id), UNIQUE (business_id, conversation_id, sequence), UNIQUE (business_id, id),
  FOREIGN KEY (business_id, conversation_id) REFERENCES conversations(business_id, id),
  FOREIGN KEY (business_id, connection_id) REFERENCES whatsapp_connections(business_id, id)
);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['conversations','messages'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO agendia_whatsapp_runtime, agendia_worker_runtime USING (business_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (business_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t || '_internal', t);
END LOOP; END $$;
GRANT SELECT, INSERT, UPDATE ON conversations, messages TO agendia_whatsapp_runtime;
GRANT SELECT, INSERT, UPDATE ON conversations, messages TO agendia_worker_runtime;
CREATE INDEX messages_conversation_order_idx ON messages (business_id, conversation_id, sequence);
