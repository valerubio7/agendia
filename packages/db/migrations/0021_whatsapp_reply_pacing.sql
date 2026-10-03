ALTER TABLE conversations
  ADD COLUMN reply_due_at timestamptz,
  ADD COLUMN latest_inbound_id uuid,
  ADD COLUMN last_exchange_at timestamptz,
  ADD COLUMN last_reply_at timestamptz;

GRANT UPDATE (published_at) ON outbox_events TO agendia_whatsapp_runtime;
-- A column-level UPDATE grant also permits the worker's conversation row lock.
GRANT UPDATE (reply_due_at) ON conversations TO agendia_worker_runtime;

-- Inbound received_at is provider-controlled. Outbox creation is the historical
-- accepted-inbound clock; sent outbound received_at was written by our DB worker.
-- Compute the gap BEFORE the first pending inbound, not after the latest inbound
-- has overwritten activity. Later messages cannot slide that group's deadline.
WITH activity AS (
  SELECT m.*,CASE WHEN m.direction='inbound' THEN
    (SELECT min(o.created_at) FROM outbox_events o WHERE o.business_id=m.business_id
      AND o.topic='ai.generate' AND o.payload->>'messageId'=m.id::text)
    ELSE m.received_at END activity_at
  FROM messages m WHERE m.direction='inbound' OR m.processing_state='sent'
)
UPDATE conversations c SET
  latest_inbound_id=(SELECT a.id FROM activity a WHERE a.conversation_id=c.id AND a.direction='inbound' ORDER BY a.sequence DESC LIMIT 1),
  last_exchange_at=(SELECT max(a.activity_at) FROM activity a WHERE a.conversation_id=c.id),
  last_reply_at=(SELECT max(a.activity_at) FROM activity a WHERE a.conversation_id=c.id AND a.direction='outbound'),
  reply_due_at=(
    SELECT opener.activity_at + CASE WHEN
      NOT EXISTS (SELECT 1 FROM activity prior WHERE prior.conversation_id=c.id
        AND prior.sequence<opener.sequence AND prior.direction='outbound')
      OR opener.activity_at-coalesce((SELECT max(prior.activity_at) FROM activity prior
        WHERE prior.conversation_id=c.id AND prior.sequence<opener.sequence),'-infinity'::timestamptz)>interval '1 hour'
      THEN interval '600 seconds' ELSE interval '90 seconds' END
    FROM activity opener WHERE opener.conversation_id=c.id
      AND opener.direction='inbound' AND opener.processing_state='pending'
      AND (SELECT newest.processing_state FROM activity newest WHERE newest.conversation_id=c.id
        AND newest.direction='inbound' ORDER BY newest.sequence DESC LIMIT 1)='pending'
    ORDER BY opener.sequence LIMIT 1
  );

-- A fresh key retains a durable wake-up even if the old job was already published.
UPDATE outbox_events o SET next_attempt_at=c.reply_due_at
  FROM conversations c WHERE o.topic='ai.generate' AND o.payload->>'messageId'=c.latest_inbound_id::text
  AND o.published_at IS NULL AND c.reply_due_at IS NOT NULL;
INSERT INTO outbox_events(business_id,topic,stable_key,payload,next_attempt_at)
  SELECT c.business_id,'ai.generate','ai:pacing:'||c.latest_inbound_id,
    jsonb_build_object('businessId',c.business_id,'messageId',c.latest_inbound_id),c.reply_due_at
  FROM conversations c WHERE c.reply_due_at IS NOT NULL ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION claim_owned_outbound(_owner text)
RETURNS TABLE(outbound_id uuid,business_id uuid,conversation_id uuid,connection_id uuid,remote_jid text,text text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE candidate record;
BEGIN
  -- Lock the conversation first, exactly like ingest and save. Recheck the
  -- command in a separate statement after the lock (fresh READ COMMITTED snapshot).
  FOR candidate IN
    SELECT c.id FROM conversations c
    WHERE EXISTS (SELECT 1 FROM outbound_commands o JOIN whatsapp_connections w
      ON w.id=o.connection_id AND w.business_id=o.business_id
      WHERE o.conversation_id=c.id AND o.state='generated' AND w.state='CONNECTED' AND w.owner_id=_owner)
    ORDER BY c.created_at FOR UPDATE OF c SKIP LOCKED
  LOOP
    -- Unknown-source legacy output is compatible only without an open burst.
    -- Retire it before claiming fresh output, so closing a burst cannot revive it.
    UPDATE outbound_commands o SET state='failed',failure_code='superseded',updated_at=now()
      FROM conversations c WHERE c.id=candidate.id AND o.conversation_id=c.id
      AND o.state='generated' AND (
        (o.source_message_id IS NULL AND c.reply_due_at IS NOT NULL)
        OR (o.source_message_id IS NOT NULL AND o.source_message_id IS DISTINCT FROM c.latest_inbound_id));
    RETURN QUERY
      UPDATE outbound_commands o SET state='sending',send_started_at=now(),
        claimed_by=_owner,claimed_at=now(),updated_at=now()
      FROM conversations c,whatsapp_connections w
      WHERE c.id=candidate.id AND o.conversation_id=c.id AND o.business_id=c.business_id
        AND w.id=o.connection_id AND w.business_id=o.business_id
        AND w.state='CONNECTED' AND w.owner_id=_owner AND o.state='generated'
        AND (c.reply_due_at IS NULL OR c.reply_due_at<=now())
        AND ((o.source_message_id IS NULL AND c.reply_due_at IS NULL)
          OR o.source_message_id=c.latest_inbound_id)
        AND o.outbound_id=(SELECT q.outbound_id FROM outbound_commands q
          WHERE q.conversation_id=c.id AND q.state='generated'
            AND ((q.source_message_id IS NULL AND c.reply_due_at IS NULL)
              OR q.source_message_id=c.latest_inbound_id)
          ORDER BY q.created_at LIMIT 1)
      RETURNING o.outbound_id,o.business_id,o.conversation_id,o.connection_id,c.remote_jid,o.text;
    IF FOUND THEN
      UPDATE conversations SET reply_due_at=NULL WHERE id=candidate.id;
      RETURN;
    END IF;
  END LOOP;
END $$;
