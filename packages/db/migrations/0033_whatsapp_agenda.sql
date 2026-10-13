-- Only the WhatsApp manager writes evidence from successful live receives.
-- A durable mapping is never authority without consistent evidence on this message.
CREATE TABLE whatsapp_sender_bindings (
  business_id uuid NOT NULL REFERENCES businesses(id),
  connection_id uuid NOT NULL,
  FOREIGN KEY (business_id, connection_id) REFERENCES whatsapp_connections(business_id, id),
  phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  pn_jid text NOT NULL,
  lid_jid text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, connection_id, phone),
  UNIQUE (business_id, connection_id, pn_jid),
  UNIQUE (business_id, connection_id, lid_jid)
);
CREATE TABLE whatsapp_received_senders (
  business_id uuid NOT NULL REFERENCES businesses(id),
  message_id uuid PRIMARY KEY,
  connection_id uuid NOT NULL,
  FOREIGN KEY (business_id, message_id) REFERENCES messages(business_id, id),
  FOREIGN KEY (business_id, connection_id) REFERENCES whatsapp_connections(business_id, id),
  phone text NOT NULL,
  FOREIGN KEY (business_id, connection_id, phone)
    REFERENCES whatsapp_sender_bindings(business_id, connection_id, phone)
);
CREATE TABLE whatsapp_agenda_dialogues (
  business_id uuid NOT NULL REFERENCES businesses(id),
  connection_id uuid NOT NULL,
  FOREIGN KEY (business_id, connection_id) REFERENCES whatsapp_connections(business_id, id),
  phone text NOT NULL,
  dialogue jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, connection_id, phone),
  FOREIGN KEY (business_id, connection_id, phone)
    REFERENCES whatsapp_sender_bindings(business_id, connection_id, phone)
);
-- Unlike manual receipts, this key is a received message and needs no impersonated auth identity.
CREATE TABLE whatsapp_agenda_receipts (
  business_id uuid NOT NULL REFERENCES businesses(id),
  message_id uuid PRIMARY KEY,
  outbound_id uuid NOT NULL,
  FOREIGN KEY (business_id, message_id) REFERENCES messages(business_id, id),
  FOREIGN KEY (business_id, outbound_id) REFERENCES outbound_commands(business_id, outbound_id),
  operation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['whatsapp_sender_bindings','whatsapp_received_senders',
    'whatsapp_agenda_dialogues','whatsapp_agenda_receipts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY tenant_manager ON %I FOR ALL TO agendia_whatsapp_runtime
      USING (business_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)
      WITH CHECK (business_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
    EXECUTE format('CREATE POLICY tenant_worker ON %I FOR ALL TO agendia_worker_runtime
      USING (business_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)
      WITH CHECK (business_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON whatsapp_sender_bindings TO agendia_whatsapp_runtime;
GRANT INSERT ON whatsapp_received_senders TO agendia_whatsapp_runtime;
GRANT SELECT ON whatsapp_sender_bindings,whatsapp_received_senders TO agendia_worker_runtime;
GRANT SELECT, INSERT, UPDATE ON whatsapp_agenda_dialogues TO agendia_worker_runtime;
GRANT SELECT, INSERT ON whatsapp_agenda_receipts TO agendia_worker_runtime;

-- Shared repository policies remain unchanged for panel callers. AI gets no catalog writes,
-- client edits, manual receipt access, attendance authority, or DELETE privileges.
DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['services','resources','resource_services','business_calendars',
    'business_calendar_closures','clients','appointments'] LOOP
    EXECUTE format('CREATE POLICY agenda_worker_read ON %I FOR SELECT TO agendia_worker_runtime
      USING (business_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
  END LOOP;
END $$;
CREATE POLICY agenda_worker_client_create ON clients FOR INSERT TO agendia_worker_runtime
  WITH CHECK (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY agenda_worker_appointment_create ON appointments FOR INSERT TO agendia_worker_runtime
  WITH CHECK (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY agenda_worker_appointment_change ON appointments FOR UPDATE TO agendia_worker_runtime
  USING (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT ON services,resources,resource_services,business_calendars,business_calendar_closures,clients,appointments TO agendia_worker_runtime;
GRANT INSERT ON clients TO agendia_worker_runtime;
GRANT INSERT, UPDATE ON appointments TO agendia_worker_runtime;
CREATE POLICY agenda_worker_outbox ON outbox_events FOR INSERT TO agendia_worker_runtime
  WITH CHECK (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT INSERT ON outbox_events TO agendia_worker_runtime;
