ALTER TABLE audit_events ADD COLUMN source text NOT NULL DEFAULT 'runtime';

CREATE FUNCTION append_runtime_audit(_business uuid,_event text,_outcome text,_source text,_actor text,_request text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE previous audit_events%ROWTYPE; next_sequence bigint; next_hash text;
  caller_role text:=current_setting('role',true); context_tenant uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
BEGIN
  IF _event <> ALL(ARRAY['auth.login','auth.login_failed','auth.logout','whatsapp.manager.started','whatsapp.link_qr_available','whatsapp.connected','whatsapp.disconnected','whatsapp.link_required','whatsapp.connection_failed','whatsapp.send_failed','whatsapp.delivery_unknown'])
    OR _outcome <> ALL(ARRAY['success','failure','denied'])
    OR (_source='api' AND caller_role<>'agendia_runtime')
    OR (_source='whatsapp-manager' AND caller_role<>'agendia_whatsapp_runtime')
    OR _source <> ALL(ARRAY['api','whatsapp-manager'])
    OR (_business IS NULL AND (_source<>'api' OR context_tenant IS NOT NULL OR _event NOT LIKE 'auth.%'))
    OR (_business IS NOT NULL AND context_tenant IS DISTINCT FROM _business) THEN
    RAISE EXCEPTION 'unsupported safe runtime event';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('audit:'||coalesce(_business::text,'platform')));
  SELECT * INTO previous FROM audit_events WHERE business_id IS NOT DISTINCT FROM _business ORDER BY stream_sequence DESC LIMIT 1;
  next_sequence := coalesce(previous.stream_sequence,0)+1;
  next_hash := encode(sha256(convert_to(coalesce(previous.event_hash,'GENESIS')||_event||_outcome||_source||coalesce(_actor,'')||_request,'UTF8')),'hex');
  INSERT INTO audit_events(business_id,actor_id,event_type,outcome,request_id,metadata,stream_sequence,previous_hash,event_hash,hmac_key_version,source)
  VALUES(_business,_actor,_event,_outcome,_request,'{}',next_sequence,coalesce(previous.event_hash,'GENESIS'),next_hash,'runtime-v1',_source);
END $$;
REVOKE ALL ON FUNCTION append_runtime_audit(uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION append_runtime_audit(uuid,text,text,text,text,text) TO agendia_runtime,agendia_whatsapp_runtime;
