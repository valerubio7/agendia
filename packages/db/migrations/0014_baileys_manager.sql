CREATE FUNCTION claim_whatsapp_link_command()
RETURNS TABLE(command_id uuid,business_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  WITH candidate AS (
    SELECT o.id FROM outbox_events o WHERE o.topic='whatsapp.link_requested' AND o.published_at IS NULL
    ORDER BY o.created_at FOR UPDATE SKIP LOCKED LIMIT 1
  )
  UPDATE outbox_events o SET published_at=now() FROM candidate c WHERE o.id=c.id
  RETURNING o.id,o.business_id
$$;
CREATE FUNCTION restorable_whatsapp_connections()
RETURNS TABLE(id uuid,business_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  SELECT w.id,w.business_id FROM whatsapp_connections w
  JOIN businesses b ON b.id=w.business_id
  WHERE b.status='active' AND w.state IN ('CONNECTED','RECONNECTING','DISCONNECTED')
$$;
REVOKE ALL ON FUNCTION claim_whatsapp_link_command(),restorable_whatsapp_connections() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_whatsapp_link_command(),restorable_whatsapp_connections() TO agendia_whatsapp_runtime;
