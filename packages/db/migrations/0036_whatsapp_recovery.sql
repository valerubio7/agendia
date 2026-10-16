ALTER TABLE whatsapp_connections
  ADD COLUMN ownership_token uuid,
  ADD COLUMN link_command_id uuid,
  ADD COLUMN link_pending boolean NOT NULL DEFAULT false;
ALTER TABLE outbound_commands ADD COLUMN ownership_token uuid;
ALTER TABLE outbox_events ADD COLUMN link_admitted_at timestamptz;
GRANT UPDATE (link_admitted_at) ON outbox_events TO agendia_whatsapp_runtime;

DROP FUNCTION claim_whatsapp_link_command();
CREATE FUNCTION claim_whatsapp_link_command(_token uuid)
RETURNS TABLE(command_id uuid,business_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH candidate AS (
    SELECT o.id FROM outbox_events o JOIN businesses b ON b.id=o.business_id
    WHERE b.status='active' AND o.topic='whatsapp.link_requested' AND o.published_at IS NULL
      AND _token IS NOT NULL
      AND (o.claim_token IS NULL OR o.claimed_at<=now()-interval '30 seconds')
    ORDER BY o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT 1
  )
  UPDATE outbox_events o SET claim_token=_token,claimed_at=now(),publish_attempts=o.publish_attempts+1
  FROM candidate c WHERE o.id=c.id RETURNING o.id,o.business_id
$$;

CREATE FUNCTION complete_whatsapp_link_command(_id uuid,_claim uuid,_ownership uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE completed boolean;
BEGIN
  -- A plain join could acknowledge using an old snapshot while takeover commits.
  PERFORM w.id FROM whatsapp_connections w JOIN outbox_events o ON o.business_id=w.business_id
    JOIN businesses b ON b.id=w.business_id
    WHERE o.id=_id AND w.ownership_token=_ownership AND b.status='active' FOR UPDATE OF w;
  IF NOT FOUND THEN RETURN false; END IF;
  WITH changed AS (
    UPDATE outbox_events o SET published_at=now(),claim_token=NULL,claimed_at=NULL
    FROM whatsapp_connections w JOIN businesses b ON b.id=w.business_id
    WHERE o.id=_id AND o.topic='whatsapp.link_requested' AND o.published_at IS NULL
      AND o.claim_token=_claim AND o.claimed_at>now()-interval '30 seconds'
      AND w.business_id=o.business_id AND o.link_admitted_at IS NOT NULL
      AND w.ownership_token=_ownership AND b.status='active'
    RETURNING o.id
  ) SELECT EXISTS(SELECT 1 FROM changed) INTO completed;
  RETURN completed;
END $$;

CREATE OR REPLACE FUNCTION restorable_whatsapp_connections()
RETURNS TABLE(id uuid,business_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT w.id,w.business_id FROM whatsapp_connections w
  JOIN businesses b ON b.id=w.business_id
  WHERE b.status='active' AND (w.state IN ('CONNECTED','RECONNECTING','DISCONNECTED') OR w.link_pending)
$$;

DROP FUNCTION claim_owned_outbound(text);
CREATE FUNCTION claim_owned_outbound(_owner text,_ownership uuid[])
RETURNS TABLE(outbound_id uuid,business_id uuid,conversation_id uuid,connection_id uuid,remote_jid text,text text,ownership_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE candidate record;
BEGIN
  -- Keep the current pacing/source guards and conversation-first lock order.
  FOR candidate IN
    SELECT c.id FROM conversations c
    WHERE EXISTS (SELECT 1 FROM outbound_commands o JOIN whatsapp_connections w
      ON w.id=o.connection_id AND w.business_id=o.business_id
      JOIN businesses b ON b.id=w.business_id
      WHERE o.conversation_id=c.id AND o.state='generated' AND w.state='CONNECTED'
        AND b.status='active' AND w.owner_id=_owner AND w.ownership_token=ANY(_ownership))
    ORDER BY c.created_at,c.id FOR UPDATE OF c SKIP LOCKED
  LOOP
    -- Serialize with takeover; the UPDATE below uses a fresh snapshot after this lock.
    PERFORM w.id FROM whatsapp_connections w JOIN conversations c
      ON c.connection_id=w.id AND c.business_id=w.business_id
      WHERE c.id=candidate.id FOR UPDATE OF w;
    UPDATE outbound_commands o SET state='failed',failure_code='superseded',updated_at=now()
      FROM conversations c WHERE c.id=candidate.id AND o.conversation_id=c.id
      AND o.state='generated' AND (
        (o.source_message_id IS NULL AND c.reply_due_at IS NOT NULL)
        OR (o.source_message_id IS NOT NULL AND o.source_message_id IS DISTINCT FROM c.latest_inbound_id));
    RETURN QUERY
      UPDATE outbound_commands o SET state='sending',send_started_at=now(),
        claimed_by=_owner,claimed_at=now(),ownership_token=w.ownership_token,updated_at=now()
      FROM conversations c,whatsapp_connections w,businesses b
      WHERE c.id=candidate.id AND o.conversation_id=c.id AND o.business_id=c.business_id
        AND w.id=o.connection_id AND w.business_id=o.business_id AND b.id=w.business_id AND b.status='active'
        AND w.state='CONNECTED' AND w.owner_id=_owner AND w.ownership_token=ANY(_ownership) AND o.state='generated'
        AND (c.reply_due_at IS NULL OR c.reply_due_at<=now())
        AND ((o.source_message_id IS NULL AND c.reply_due_at IS NULL)
          OR o.source_message_id=c.latest_inbound_id)
        AND o.outbound_id=(SELECT q.outbound_id FROM outbound_commands q
          WHERE q.conversation_id=c.id AND q.state='generated'
            AND ((q.source_message_id IS NULL AND c.reply_due_at IS NULL)
              OR q.source_message_id=c.latest_inbound_id)
          ORDER BY q.created_at LIMIT 1)
      RETURNING o.outbound_id,o.business_id,o.conversation_id,o.connection_id,c.remote_jid,o.text,o.ownership_token;
    IF FOUND THEN
      UPDATE conversations SET reply_due_at=NULL WHERE id=candidate.id;
      RETURN;
    END IF;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION claim_whatsapp_link_command(uuid),complete_whatsapp_link_command(uuid,uuid,uuid),
  restorable_whatsapp_connections(),claim_owned_outbound(text,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_whatsapp_link_command(uuid),complete_whatsapp_link_command(uuid,uuid,uuid),
  restorable_whatsapp_connections(),claim_owned_outbound(text,uuid[]) TO agendia_whatsapp_runtime;
