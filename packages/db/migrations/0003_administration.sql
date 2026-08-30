-- Administrative projection is deliberately narrower than tenant content.
CREATE VIEW admin_business_status AS
SELECT id, name, status, created_at, last_technical_activity_at FROM businesses;
GRANT SELECT ON admin_business_status TO agendia_admin_runtime;
REVOKE ALL ON tenant_records, audit_events, technical_events, outbox_events, inbox_events FROM agendia_admin_runtime;
GRANT SELECT ON businesses, admin_business_status TO agendia_admin_runtime;
