CREATE TABLE whatsapp_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL UNIQUE REFERENCES businesses(id),
  session_public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  state varchar(24) NOT NULL DEFAULT 'LINK_REQUIRED' CHECK (state IN ('LINK_REQUIRED','LINKING','CONNECTED','RECONNECTING','DISCONNECTED','ERROR')),
  linked_number varchar(40), linked_at timestamptz, last_connected_at timestamptz,
  owner_id text, heartbeat_at timestamptz, version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (business_id, id)
);
ALTER TABLE whatsapp_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_connections_tenant ON whatsapp_connections FOR SELECT TO agendia_runtime
  USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY whatsapp_connections_manager ON whatsapp_connections FOR ALL TO agendia_whatsapp_runtime
  USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON whatsapp_connections TO agendia_runtime;
GRANT SELECT, INSERT, UPDATE ON whatsapp_connections TO agendia_whatsapp_runtime;
