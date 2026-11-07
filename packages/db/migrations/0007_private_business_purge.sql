-- Retain the business solely as an audit identity and permanent write fence.
ALTER TABLE businesses ADD COLUMN deleted_at timestamptz;
CREATE ROLE agendia_business_purge NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
DO $$ BEGIN EXECUTE format('GRANT agendia_business_purge TO %I', current_user); END $$;
GRANT USAGE, CREATE ON SCHEMA public TO agendia_business_purge;
GRANT SELECT, UPDATE ON businesses, auth_identities, web_sessions TO agendia_business_purge;
GRANT DELETE ON auth_identities, web_sessions TO agendia_business_purge;
GRANT SELECT, INSERT ON audit_events TO agendia_business_purge;

-- The lock is held to transaction end. A writer arriving after deletion waits
-- for the purge and then sees the tombstone, including on old app versions.
CREATE FUNCTION guard_live_business_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE tenant uuid; removed timestamptz;
BEGIN
  tenant := NEW.business_id;
  IF TG_OP = 'UPDATE' AND OLD.business_id IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'business ownership cannot change';
  END IF;
  IF tenant IS NULL THEN RETURN NEW; END IF;
  SELECT deleted_at INTO removed FROM public.businesses WHERE id=tenant FOR SHARE;
  IF NOT FOUND OR removed IS NOT NULL THEN RAISE EXCEPTION 'business is deleted'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION guard_live_business_session() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE tenant uuid; removed timestamptz;
BEGIN
  SELECT business_id INTO tenant FROM public.auth_identities WHERE id=NEW.identity_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'identity not found'; END IF;
  IF tenant IS NULL THEN RETURN NEW; END IF;
  SELECT deleted_at INTO removed FROM public.businesses WHERE id=tenant FOR SHARE;
  IF NOT FOUND OR removed IS NOT NULL THEN RAISE EXCEPTION 'business is deleted'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_live_session BEFORE INSERT OR UPDATE ON web_sessions
  FOR EACH ROW EXECUTE FUNCTION guard_live_business_session();

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['tenant_records','business_profiles','agent_configs','technical_events',
    'outbox_events','inbox_events','whatsapp_connections','whatsapp_auth_records','whatsapp_link_codes',
    'conversations','messages','conversation_summaries','outbound_commands','services','service_categories',
    'clients','business_calendars','business_calendar_closures','resources','resource_services',
    'appointments','appointment_operation_receipts','whatsapp_sender_bindings','whatsapp_received_senders',
    'whatsapp_agenda_dialogues','whatsapp_agenda_receipts','audit_events','auth_identities'] LOOP
    EXECUTE format('CREATE TRIGGER business_live_write BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION guard_live_business_write()',tab);
  END LOOP;
  FOREACH tab IN ARRAY ARRAY['tenant_records','business_profiles','agent_configs','technical_events',
    'outbox_events','inbox_events','whatsapp_connections','whatsapp_auth_records','whatsapp_link_codes',
    'conversations','messages','conversation_summaries','outbound_commands','services','service_categories',
    'clients','business_calendars','business_calendar_closures','resources','resource_services',
    'appointments','appointment_operation_receipts','whatsapp_sender_bindings','whatsapp_received_senders',
    'whatsapp_agenda_dialogues','whatsapp_agenda_receipts'] LOOP
    EXECUTE format('GRANT SELECT, DELETE ON %I TO agendia_business_purge',tab);
    EXECUTE format('CREATE POLICY business_purge_scope ON %I FOR ALL TO agendia_business_purge USING (business_id = nullif(current_setting(''app.purge_business'',true),'''')::uuid) WITH CHECK (business_id = nullif(current_setting(''app.purge_business'',true),'''')::uuid)',tab);
  END LOOP;
END $$;
-- A receipt in another tenant may retain an FK to the deleted identity.
CREATE POLICY business_purge_receipt_reference ON appointment_operation_receipts FOR SELECT TO agendia_business_purge USING (true);
CREATE POLICY business_purge_audit ON audit_events FOR ALL TO agendia_business_purge
  USING (business_id = nullif(current_setting('app.purge_business',true),'')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.purge_business',true),'')::uuid);

CREATE FUNCTION admit_business_send(_business uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE live boolean;
BEGIN
  IF current_setting('role',true) <> 'agendia_whatsapp_runtime' OR
    nullif(current_setting('app.tenant_id',true),'')::uuid IS DISTINCT FROM _business THEN
    RAISE EXCEPTION 'manager tenant required';
  END IF;
  SELECT status='active' AND deleted_at IS NULL INTO live FROM public.businesses WHERE id=_business FOR SHARE;
  RETURN coalesce(live,false);
END $$;
REVOKE ALL ON FUNCTION admit_business_send(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admit_business_send(uuid) TO agendia_whatsapp_runtime;

CREATE FUNCTION prevent_deleted_business_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL OR (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND current_user <> 'agendia_business_purge') THEN
    RAISE EXCEPTION 'business is deleted';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_deleted_immutable BEFORE UPDATE ON businesses FOR EACH ROW EXECUTE FUNCTION prevent_deleted_business_update();

-- Non-public primitive: only the migration owner or narrow purge capability may call it.
CREATE FUNCTION purge_business_data_private(_business uuid) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  -- FORCE RLS must not silently turn an incomplete purge into success.
  IF current_user <> 'agendia_business_purge' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'purge requires a role that bypasses row security';
  END IF;
  IF _business IS NULL THEN RAISE EXCEPTION 'business is required'; END IF;
  PERFORM id FROM public.businesses WHERE id = _business FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'business not found'; END IF;

  UPDATE public.businesses SET status = 'suspended', last_technical_activity_at = NULL WHERE id = _business;
  DELETE FROM public.whatsapp_agenda_receipts WHERE business_id = _business;
  DELETE FROM public.whatsapp_received_senders WHERE business_id = _business;
  DELETE FROM public.whatsapp_agenda_dialogues WHERE business_id = _business;
  DELETE FROM public.whatsapp_sender_bindings WHERE business_id = _business;
  DELETE FROM public.conversation_summaries WHERE business_id = _business;
  DELETE FROM public.outbound_commands WHERE business_id = _business;
  DELETE FROM public.messages WHERE business_id = _business;
  DELETE FROM public.conversations WHERE business_id = _business;
  DELETE FROM public.whatsapp_auth_records WHERE business_id = _business;
  DELETE FROM public.whatsapp_link_codes WHERE business_id = _business;
  DELETE FROM public.whatsapp_connections WHERE business_id = _business;
  DELETE FROM public.appointment_operation_receipts WHERE business_id = _business;
  DELETE FROM public.appointments WHERE business_id = _business;
  DELETE FROM public.resource_services WHERE business_id = _business;
  DELETE FROM public.services WHERE business_id = _business;
  DELETE FROM public.service_categories WHERE business_id = _business;
  DELETE FROM public.resources WHERE business_id = _business;
  DELETE FROM public.clients WHERE business_id = _business;
  DELETE FROM public.business_calendar_closures WHERE business_id = _business;
  DELETE FROM public.business_calendars WHERE business_id = _business;
  DELETE FROM public.business_profiles WHERE business_id = _business;
  DELETE FROM public.agent_configs WHERE business_id = _business;
  DELETE FROM public.tenant_records WHERE business_id = _business;
  DELETE FROM public.technical_events WHERE business_id = _business;
  DELETE FROM public.outbox_events WHERE business_id = _business;
  DELETE FROM public.inbox_events WHERE business_id = _business;
  DELETE FROM public.web_sessions WHERE identity_id IN (SELECT id FROM public.auth_identities WHERE business_id = _business);
  -- Receipts belonging to another tenant can reference this identity by actor_id.
  UPDATE public.auth_identities i
    SET normalized_email = 'deleted+' || gen_random_uuid()::text || '@invalid.invalid',
        password_phc = '!', active = false
    WHERE i.business_id = _business
      AND EXISTS (SELECT 1 FROM public.appointment_operation_receipts r WHERE r.actor_id = i.id);
  DELETE FROM public.auth_identities i WHERE i.business_id = _business
    AND NOT EXISTS (SELECT 1 FROM public.appointment_operation_receipts r WHERE r.actor_id = i.id);
END $$;
REVOKE ALL ON FUNCTION purge_business_data_private(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_business_data_private(uuid) TO agendia_business_purge;

CREATE FUNCTION delete_business(_business uuid, _session uuid, _actor uuid, _request text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE previous public.audit_events%ROWTYPE; hash text;
BEGIN
  IF current_setting('role',true) <> 'agendia_admin_runtime' OR _request IS NULL OR length(_request)=0 OR
    NOT EXISTS (SELECT 1 FROM public.web_sessions s JOIN public.auth_identities i ON i.id=s.identity_id
      WHERE s.id=_session AND i.id=_actor AND i.role='platform_admin' AND i.active
        AND s.revoked_at IS NULL AND s.absolute_expires_at>now() AND s.idle_expires_at>now()) THEN
    RAISE EXCEPTION 'administrator session required';
  END IF;
  PERFORM id FROM public.businesses WHERE id=_business AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM set_config('app.purge_business',_business::text,true);
  PERFORM public.purge_business_data_private(_business);
  PERFORM pg_advisory_xact_lock(hashtext('audit:'||_business::text));
  SELECT * INTO previous FROM public.audit_events WHERE business_id=_business ORDER BY stream_sequence DESC LIMIT 1;
  hash := encode(sha256(convert_to('business.deleted:'||_request,'UTF8')),'hex');
  INSERT INTO public.audit_events(business_id,actor_id,event_type,outcome,request_id,stream_sequence,previous_hash,event_hash,hmac_key_version)
    VALUES(_business,_actor::text,'business.deleted','success',_request,coalesce(previous.stream_sequence,0)+1,coalesce(previous.event_hash,'GENESIS'),hash,'runtime-v1');
  UPDATE public.businesses SET deleted_at=clock_timestamp() WHERE id=_business;
  RETURN true;
END $$;
ALTER FUNCTION delete_business(uuid,uuid,uuid,text) OWNER TO agendia_business_purge;
REVOKE CREATE ON SCHEMA public FROM agendia_business_purge;
REVOKE ALL ON FUNCTION delete_business(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_business(uuid,uuid,uuid,text) TO agendia_admin_runtime;

CREATE OR REPLACE VIEW admin_business_status AS
  SELECT b.id,b.name,b.status,b.created_at,b.last_technical_activity_at,
    CASE WHEN a.active THEN 'active' ELSE 'inactive' END agent_status,
    coalesce(lower(w.state),'link_required') whatsapp_status
  FROM businesses b LEFT JOIN agent_configs a ON a.business_id=b.id
  LEFT JOIN whatsapp_connections w ON w.business_id=b.id WHERE b.deleted_at IS NULL;
