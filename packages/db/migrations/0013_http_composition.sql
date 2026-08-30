CREATE OR REPLACE VIEW admin_business_status AS SELECT b.id,b.name,b.status,b.created_at,b.last_technical_activity_at,CASE WHEN a.active THEN 'active' ELSE 'inactive' END assistant_status,coalesce(lower(w.state),'link_required') whatsapp_status FROM businesses b LEFT JOIN assistant_configs a ON a.business_id=b.id LEFT JOIN whatsapp_connections w ON w.business_id=b.id;
CREATE POLICY audit_events_admin_http ON audit_events FOR SELECT TO agendia_admin_runtime USING (business_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY audit_events_admin_http_insert ON audit_events FOR INSERT TO agendia_admin_runtime WITH CHECK (business_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY outbox_events_admin_http ON outbox_events FOR INSERT TO agendia_admin_runtime WITH CHECK (business_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT, INSERT ON audit_events TO agendia_admin_runtime;
GRANT INSERT ON outbox_events TO agendia_admin_runtime;
