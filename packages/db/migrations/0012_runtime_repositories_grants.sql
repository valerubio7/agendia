-- Runtime composition uses four independent pools and these non-login capability roles.
GRANT SELECT ON auth_identities TO agendia_runtime;
GRANT INSERT, UPDATE ON businesses TO agendia_admin_runtime;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['audit_events','technical_events','outbox_events','inbox_events'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO agendia_whatsapp_runtime USING (business_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (business_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', t || '_manager_runtime', t);
  END LOOP;
END $$;
CREATE POLICY outbox_events_worker_runtime ON outbox_events FOR SELECT TO agendia_worker_runtime
  USING (business_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY outbox_events_worker_publish ON outbox_events FOR UPDATE TO agendia_worker_runtime
  USING (business_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT, INSERT ON audit_events, technical_events, outbox_events, inbox_events TO agendia_whatsapp_runtime;
GRANT SELECT, UPDATE (published_at) ON outbox_events TO agendia_worker_runtime;

-- Unit 20 workers dispatch durable envelopes only; later workers receive narrow functions as needed.
REVOKE ALL ON conversations, messages, conversation_summaries, outbound_commands FROM agendia_worker_runtime;
REVOKE ALL ON whatsapp_auth_records FROM agendia_worker_runtime, agendia_admin_runtime;
REVOKE ALL ON conversations, messages FROM agendia_admin_runtime;

CREATE SCHEMA IF NOT EXISTS pgboss;
REVOKE ALL ON SCHEMA pgboss FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA pgboss TO agendia_worker_runtime;
