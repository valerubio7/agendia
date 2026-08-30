ALTER TABLE outbox_events
  ADD COLUMN claim_token uuid,
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN publish_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX outbox_events_ai_dispatch_idx ON outbox_events(next_attempt_at,created_at)
  WHERE topic='ai.generate' AND published_at IS NULL;

CREATE FUNCTION claim_ai_outbox(_token uuid,_limit integer,_stale_ms integer)
RETURNS TABLE(id uuid,business_id uuid,stable_key text,payload jsonb,publish_attempts integer)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH candidate AS (
    SELECT o.id FROM outbox_events o
    WHERE o.topic='ai.generate' AND o.published_at IS NULL AND o.next_attempt_at<=now()
      AND (o.claim_token IS NULL OR o.claimed_at<=now()-make_interval(secs=>greatest(_stale_ms,0)/1000.0))
    ORDER BY o.created_at FOR UPDATE SKIP LOCKED LIMIT least(greatest(_limit,1),100)
  )
  UPDATE outbox_events o SET claim_token=_token,claimed_at=now(),publish_attempts=o.publish_attempts+1
  FROM candidate c WHERE o.id=c.id
  RETURNING o.id,o.business_id,o.stable_key,o.payload,o.publish_attempts
$$;
CREATE FUNCTION complete_ai_outbox(_id uuid,_token uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH changed AS (UPDATE outbox_events SET published_at=now(),claim_token=NULL,claimed_at=NULL
    WHERE id=_id AND claim_token=_token AND published_at IS NULL RETURNING id)
  SELECT EXISTS(SELECT 1 FROM changed)
$$;
CREATE FUNCTION release_ai_outbox(_id uuid,_token uuid,_delay_ms integer) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH changed AS (UPDATE outbox_events SET claim_token=NULL,claimed_at=NULL,
    next_attempt_at=now()+least(greatest(_delay_ms,0),60000)*interval '1 millisecond'
    WHERE id=_id AND claim_token=_token AND published_at IS NULL RETURNING id)
  SELECT EXISTS(SELECT 1 FROM changed)
$$;
REVOKE ALL ON FUNCTION claim_ai_outbox(uuid,integer,integer),complete_ai_outbox(uuid,uuid),release_ai_outbox(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_ai_outbox(uuid,integer,integer),complete_ai_outbox(uuid,uuid),release_ai_outbox(uuid,uuid,integer) TO agendia_whatsapp_runtime;
