CREATE TABLE whatsapp_link_codes (
  connection_id uuid PRIMARY KEY,
  business_id uuid NOT NULL,
  token uuid NOT NULL UNIQUE,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL CHECK (octet_length(nonce)=12),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag)=16),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id,connection_id) REFERENCES whatsapp_connections(business_id,id) ON DELETE CASCADE
);
CREATE INDEX whatsapp_link_codes_expiry ON whatsapp_link_codes(expires_at);
ALTER TABLE whatsapp_link_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_link_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_link_codes_tenant ON whatsapp_link_codes FOR SELECT TO agendia_runtime
  USING (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY whatsapp_link_codes_tenant_expiry ON whatsapp_link_codes FOR DELETE TO agendia_runtime
  USING (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY whatsapp_link_codes_manager ON whatsapp_link_codes FOR ALL TO agendia_whatsapp_runtime
  USING (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,DELETE ON whatsapp_link_codes TO agendia_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON whatsapp_link_codes TO agendia_whatsapp_runtime;
