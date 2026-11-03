-- Registration has its own budget so unauthenticated signups cannot exhaust login admission.
CREATE TABLE registration_throttle (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), attempts integer NOT NULL, resets_at timestamptz NOT NULL);
INSERT INTO registration_throttle VALUES (true, 0, clock_timestamp());
CREATE TABLE pending_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL CHECK (length(trim(name)) > 0),
  email text NOT NULL UNIQUE CHECK (length(email) <= 254 AND email = lower(trim(email))),
  password_phc text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON registration_throttle, pending_registrations FROM PUBLIC, agendia_runtime, agendia_admin_runtime;
GRANT SELECT (id, name, email, created_at) ON pending_registrations TO agendia_admin_runtime;

CREATE FUNCTION admit_registration() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b registration_throttle%ROWTYPE; instant timestamptz;
BEGIN
  SELECT * INTO STRICT b FROM registration_throttle WHERE singleton FOR UPDATE;
  instant := clock_timestamp();
  IF b.resets_at <= instant THEN b.attempts := 0; b.resets_at := instant + interval '1 minute'; END IF;
  IF b.attempts >= 30 THEN RETURN false; END IF;
  UPDATE registration_throttle SET attempts=b.attempts+1, resets_at=b.resets_at WHERE singleton;
  RETURN true;
END $$;
CREATE FUNCTION submit_registration(_name text, _email text, _phc text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF _name IS NULL OR length(trim(_name)) NOT BETWEEN 1 AND 160 OR _email IS NULL OR length(_email) NOT BETWEEN 3 AND 254 OR _email <> lower(trim(_email)) OR _phc IS NULL OR length(_phc) > 512 OR _phc NOT LIKE '$argon2id$%' THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('registration:'||_email,0));
  IF EXISTS (SELECT 1 FROM auth_identities WHERE normalized_email=_email) THEN RETURN false; END IF;
  INSERT INTO pending_registrations(name,email,password_phc) VALUES (_name,_email,_phc) ON CONFLICT (email) DO NOTHING;
  RETURN FOUND;
END $$;
CREATE FUNCTION decide_registration(_id uuid, _approve boolean) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p pending_registrations%ROWTYPE; registration_email text;
BEGIN
  SELECT email INTO registration_email FROM pending_registrations WHERE id=_id;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('registration:'||registration_email,0));
  SELECT * INTO p FROM pending_registrations WHERE id=_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF _approve THEN
    INSERT INTO businesses(id,name) VALUES(p.id,p.name);
    INSERT INTO auth_identities(normalized_email,password_phc,role,business_id) VALUES(p.email,p.password_phc,'business_user',p.id);
  END IF;
  DELETE FROM pending_registrations WHERE id=p.id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION admit_registration(),submit_registration(text,text,text),decide_registration(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admit_registration(),submit_registration(text,text,text) TO agendia_runtime;
GRANT EXECUTE ON FUNCTION decide_registration(uuid,boolean) TO agendia_admin_runtime;

-- Extend the established platform audit stream without granting direct platform writes.
CREATE OR REPLACE FUNCTION append_runtime_audit(_business uuid,_event text,_outcome text,_source text,_actor text,_request text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE previous audit_events%ROWTYPE; next_sequence bigint; next_hash text;
  caller_role text:=current_setting('role',true); context_tenant uuid:=nullif(current_setting('app.tenant_id',true),'')::uuid;
BEGIN
  IF _event <> ALL(ARRAY['auth.login','auth.login_failed','auth.logout','auth.registration_submitted','auth.registration_approved','auth.registration_rejected','whatsapp.manager.started','whatsapp.link_qr_available','whatsapp.connected','whatsapp.disconnected','whatsapp.link_required','whatsapp.connection_failed','whatsapp.send_failed','whatsapp.delivery_unknown'])
    OR _outcome <> ALL(ARRAY['success','failure','denied'])
    OR (_source='api' AND caller_role<>'agendia_runtime' AND NOT (caller_role='agendia_admin_runtime' AND _event IN ('auth.registration_approved','auth.registration_rejected')))
    OR (_event IN ('auth.registration_approved','auth.registration_rejected') AND caller_role<>'agendia_admin_runtime')
    OR (_event LIKE 'auth.registration_%' AND _business IS NOT NULL)
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
GRANT EXECUTE ON FUNCTION append_runtime_audit(uuid,text,text,text,text,text) TO agendia_admin_runtime;
