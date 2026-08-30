ALTER TABLE whatsapp_connections ADD COLUMN wrapped_dek bytea;
ALTER TABLE whatsapp_connections ADD COLUMN wrapped_dek_nonce bytea;
ALTER TABLE whatsapp_connections ADD COLUMN wrapped_dek_tag bytea;
ALTER TABLE whatsapp_connections ADD COLUMN kek_version text;

CREATE TABLE whatsapp_auth_records (
  business_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  record_name text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  nonce bytea NOT NULL, ciphertext bytea NOT NULL, auth_tag bytea NOT NULL,
  PRIMARY KEY (business_id, connection_id, record_name),
  FOREIGN KEY (business_id, connection_id) REFERENCES whatsapp_connections(business_id, id)
);
ALTER TABLE whatsapp_auth_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_auth_records FORCE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_auth_manager_only ON whatsapp_auth_records FOR ALL TO agendia_whatsapp_runtime
  USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_auth_records TO agendia_whatsapp_runtime;
-- No API, web, admin, or worker grants: auth material is manager-exclusive and append-only outside rotations.
