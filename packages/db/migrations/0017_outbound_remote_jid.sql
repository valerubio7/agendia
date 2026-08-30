DROP FUNCTION claim_owned_outbound(text);
CREATE FUNCTION claim_owned_outbound(_owner text) RETURNS TABLE(outbound_id uuid,business_id uuid,conversation_id uuid,connection_id uuid,remote_jid text,text text)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH candidate AS (
  SELECT o.outbound_id,c.remote_jid FROM outbound_commands o
  JOIN whatsapp_connections w ON w.id=o.connection_id AND w.business_id=o.business_id
  JOIN conversations c ON c.id=o.conversation_id AND c.business_id=o.business_id
  WHERE o.state='generated' AND w.state='CONNECTED' AND w.owner_id=_owner
  ORDER BY o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT 1
 )
 UPDATE outbound_commands o SET state='sending',send_started_at=now(),claimed_by=_owner,claimed_at=now(),updated_at=now()
 FROM candidate c WHERE o.outbound_id=c.outbound_id
 RETURNING o.outbound_id,o.business_id,o.conversation_id,o.connection_id,c.remote_jid,o.text
$$;
REVOKE ALL ON FUNCTION claim_owned_outbound(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_owned_outbound(text) TO agendia_whatsapp_runtime;
