ALTER TABLE outbound_commands ADD COLUMN source_message_id uuid;
CREATE UNIQUE INDEX outbound_commands_source_message_idx ON outbound_commands(source_message_id) WHERE source_message_id IS NOT NULL;
CREATE POLICY business_profiles_worker ON business_profiles FOR SELECT TO agendia_worker_runtime USING (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY assistant_configs_worker ON assistant_configs FOR SELECT TO agendia_worker_runtime USING (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY whatsapp_connections_worker ON whatsapp_connections FOR SELECT TO agendia_worker_runtime USING (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY audit_events_worker_select ON audit_events FOR SELECT TO agendia_worker_runtime USING (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY audit_events_worker_insert ON audit_events FOR INSERT TO agendia_worker_runtime WITH CHECK (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY technical_events_worker ON technical_events FOR INSERT TO agendia_worker_runtime WITH CHECK (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT ON business_profiles,assistant_configs,whatsapp_connections,conversations,messages,conversation_summaries,outbound_commands TO agendia_worker_runtime;
GRANT INSERT,UPDATE ON messages,outbound_commands TO agendia_worker_runtime;
GRANT SELECT,INSERT ON audit_events TO agendia_worker_runtime;
GRANT INSERT ON technical_events TO agendia_worker_runtime;

CREATE FUNCTION route_whatsapp_session(_session uuid) RETURNS TABLE(business_id uuid,connection_id uuid,business_status text,assistant_active boolean)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT w.business_id,w.id,b.status,coalesce(a.active,false) FROM whatsapp_connections w JOIN businesses b ON b.id=w.business_id LEFT JOIN assistant_configs a ON a.business_id=b.id WHERE w.session_public_id=_session AND w.state='CONNECTED'
$$;
CREATE FUNCTION claim_owned_outbound(_owner text) RETURNS TABLE(outbound_id uuid,business_id uuid,conversation_id uuid,connection_id uuid,text text)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH candidate AS (SELECT o.outbound_id FROM outbound_commands o JOIN whatsapp_connections w ON w.id=o.connection_id AND w.business_id=o.business_id WHERE o.state='generated' AND w.state='CONNECTED' AND w.owner_id=_owner ORDER BY o.created_at FOR UPDATE SKIP LOCKED LIMIT 1)
 UPDATE outbound_commands o SET state='sending',send_started_at=now(),claimed_by=_owner,claimed_at=now(),updated_at=now() FROM candidate c WHERE o.outbound_id=c.outbound_id RETURNING o.outbound_id,o.business_id,o.conversation_id,o.connection_id,o.text
$$;
REVOKE ALL ON FUNCTION route_whatsapp_session(uuid),claim_owned_outbound(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION route_whatsapp_session(uuid),claim_owned_outbound(text) TO agendia_whatsapp_runtime;
