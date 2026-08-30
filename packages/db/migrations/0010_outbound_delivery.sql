CREATE TABLE outbound_commands (
  outbound_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  text text NOT NULL CHECK (length(text) > 0),
  state varchar(24) NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','processing','generated','sending','sent','failed','delivery_unknown')),
  claimed_by text,
  claimed_at timestamptz,
  send_started_at timestamptz,
  provider_message_id text,
  acknowledged_at timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, outbound_id),
  FOREIGN KEY (business_id, conversation_id) REFERENCES conversations(business_id, id),
  FOREIGN KEY (business_id, connection_id) REFERENCES whatsapp_connections(business_id, id)
);

ALTER TABLE outbound_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY outbound_commands_worker ON outbound_commands
  FOR ALL TO agendia_worker_runtime
  USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY outbound_commands_manager ON outbound_commands
  FOR ALL TO agendia_whatsapp_runtime
  USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON outbound_commands TO agendia_worker_runtime;
GRANT SELECT, UPDATE ON outbound_commands TO agendia_whatsapp_runtime;
CREATE INDEX outbound_commands_claim_idx
  ON outbound_commands (connection_id, state, created_at)
  WHERE state = 'generated';
CREATE UNIQUE INDEX outbound_commands_provider_message_idx
  ON outbound_commands (business_id, connection_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
