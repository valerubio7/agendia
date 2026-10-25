-- Fresh-install schema. The migration owner owns DDL; capability roles never own tenant tables.
DO $$ BEGIN
  CREATE ROLE agendia_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE agendia_admin_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE agendia_whatsapp_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE agendia_worker_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Installer needs database CREATE for this trusted extension, or an administrator must preinstall it.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS pgboss;
REVOKE ALL ON SCHEMA pgboss FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA pgboss TO agendia_worker_runtime;
GRANT USAGE ON SCHEMA public TO agendia_runtime, agendia_admin_runtime, agendia_whatsapp_runtime, agendia_worker_runtime;

-- Identity and tenant ownership.
CREATE TABLE businesses (
  id uuid PRIMARY KEY,
  name varchar(160) NOT NULL CHECK (length(trim(name)) > 0),
  status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_technical_activity_at timestamptz
);
CREATE TABLE tenant_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  value text NOT NULL,
  UNIQUE (business_id, id)
);
CREATE TABLE auth_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_email text NOT NULL UNIQUE,
  password_phc text NOT NULL,
  role text NOT NULL CHECK (role IN ('platform_admin', 'business_user')),
  business_id uuid REFERENCES businesses(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'platform_admin' AND business_id IS NULL) OR (role = 'business_user' AND business_id IS NOT NULL))
);
CREATE UNIQUE INDEX auth_one_business_user ON auth_identities(business_id) WHERE role = 'business_user';
CREATE TABLE web_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id uuid NOT NULL REFERENCES auth_identities(id),
  token_sha256 char(64) NOT NULL UNIQUE,
  csrf_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE business_profiles (
  business_id uuid PRIMARY KEY REFERENCES businesses(id),
  display_name varchar(160) NOT NULL,
  description varchar(4000) NOT NULL DEFAULT '',
  address varchar(500) NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE assistant_configs (
  business_id uuid PRIMARY KEY REFERENCES businesses(id),
  active boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  style text NOT NULL DEFAULT '',
  business_instructions text NOT NULL DEFAULT ''
);

-- Durable event streams and dispatch envelopes.
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES businesses(id),
  actor_id text,
  event_type text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  request_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  stream_sequence bigint NOT NULL CHECK (stream_sequence > 0),
  previous_hash varchar(64) NOT NULL CHECK (previous_hash ~ '^[0-9a-f]{64}$' OR previous_hash = 'GENESIS'),
  event_hash char(64) NOT NULL CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  hmac_key_version text NOT NULL CHECK (length(hmac_key_version) > 0),
  source text NOT NULL DEFAULT 'runtime',
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX audit_events_stream_sequence_idx
  ON audit_events ((coalesce(business_id::text, 'platform')), stream_sequence);
CREATE INDEX audit_events_verify_idx ON audit_events (business_id, stream_sequence, previous_hash, event_hash);
CREATE TABLE technical_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  component text NOT NULL,
  code text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  safe_details jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  topic text NOT NULL,
  stable_key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  claim_token uuid,
  claimed_at timestamptz,
  publish_attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  link_admitted_at timestamptz,
  UNIQUE (business_id, stable_key),
  UNIQUE (business_id, id)
);
CREATE INDEX outbox_events_ai_dispatch_idx ON outbox_events(next_attempt_at,created_at)
  WHERE topic='ai.generate' AND published_at IS NULL;
CREATE TABLE inbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  source text NOT NULL,
  stable_key text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, source, stable_key),
  UNIQUE (business_id, id)
);
CREATE TABLE operational_controls (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  automation_disabled boolean NOT NULL DEFAULT false,
  incident_reference text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  additional_instructions text NOT NULL DEFAULT '',
  initial_delay_seconds integer NOT NULL DEFAULT 600 CHECK (initial_delay_seconds BETWEEN 0 AND 86400),
  active_delay_seconds integer NOT NULL DEFAULT 90 CHECK (active_delay_seconds BETWEEN 0 AND 86400),
  inactivity_reset_seconds integer NOT NULL DEFAULT 3600 CHECK (inactivity_reset_seconds BETWEEN 1 AND 604800),
  CHECK (NOT automation_disabled OR length(trim(incident_reference)) > 0)
);
INSERT INTO operational_controls (singleton) VALUES (true);

-- WhatsApp connection material is manager-exclusive; message history remains tenant-scoped.
CREATE TABLE whatsapp_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL UNIQUE REFERENCES businesses(id),
  session_public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  state varchar(24) NOT NULL DEFAULT 'LINK_REQUIRED' CHECK (state IN ('LINK_REQUIRED','LINKING','CONNECTED','RECONNECTING','DISCONNECTED','ERROR')),
  linked_number varchar(40),
  linked_at timestamptz,
  last_connected_at timestamptz,
  owner_id text,
  heartbeat_at timestamptz,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  wrapped_dek bytea,
  wrapped_dek_nonce bytea,
  wrapped_dek_tag bytea,
  kek_version text,
  ownership_token uuid,
  link_command_id uuid,
  link_pending boolean NOT NULL DEFAULT false,
  UNIQUE (business_id, id)
);
CREATE TABLE whatsapp_auth_records (
  business_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  record_name text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  PRIMARY KEY (business_id, connection_id, record_name),
  FOREIGN KEY (business_id, connection_id) REFERENCES whatsapp_connections(business_id, id)
);
CREATE TABLE whatsapp_link_codes (
  connection_id uuid PRIMARY KEY,
  business_id uuid NOT NULL,
  token uuid NOT NULL UNIQUE,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL CHECK (octet_length(nonce)=12),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag)=16),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id,connection_id) REFERENCES whatsapp_connections(business_id,id) ON DELETE CASCADE
);
CREATE INDEX whatsapp_link_codes_expiry ON whatsapp_link_codes(expires_at);
CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  remote_jid text NOT NULL,
  next_sequence bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  reply_due_at timestamptz,
  latest_inbound_id uuid,
  last_exchange_at timestamptz,
  last_reply_at timestamptz,
  UNIQUE (business_id, connection_id, remote_jid),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, connection_id) REFERENCES whatsapp_connections(business_id, id)
);
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider_message_id text NOT NULL,
  sequence bigint NOT NULL,
  direction varchar(16) NOT NULL CHECK (direction IN ('inbound','outbound')),
  raw_text text NOT NULL,
  received_at timestamptz NOT NULL,
  processing_state varchar(24) NOT NULL DEFAULT 'pending',
  UNIQUE (business_id, connection_id, provider_message_id),
  UNIQUE (business_id, conversation_id, sequence),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, conversation_id) REFERENCES conversations(business_id, id),
  FOREIGN KEY (business_id, connection_id) REFERENCES whatsapp_connections(business_id, id)
);
CREATE INDEX messages_conversation_order_idx ON messages (business_id, conversation_id, sequence);
CREATE INDEX messages_context_order_idx ON messages (business_id, conversation_id, sequence DESC);
CREATE INDEX messages_context_search_idx ON messages USING gin (to_tsvector('simple', raw_text));
CREATE TABLE conversation_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  covered_through bigint NOT NULL CHECK (covered_through >= 0),
  structured_summary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, conversation_id, version),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, conversation_id) REFERENCES conversations(business_id, id)
);
CREATE TABLE outbound_commands (
  outbound_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  text text NOT NULL CHECK (length(text) > 0),
  state varchar(24) NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','processing','generated','sending','sent','failed','delivery_unknown')),
  claimed_by text,
  claimed_at timestamptz,
  send_started_at timestamptz,
  provider_message_id text,
  acknowledged_at timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  source_message_id uuid,
  ownership_token uuid,
  UNIQUE (business_id, outbound_id),
  FOREIGN KEY (business_id, conversation_id) REFERENCES conversations(business_id, id),
  FOREIGN KEY (business_id, connection_id) REFERENCES whatsapp_connections(business_id, id)
);
CREATE INDEX outbound_commands_claim_idx ON outbound_commands (connection_id, state, created_at) WHERE state = 'generated';
CREATE UNIQUE INDEX outbound_commands_provider_message_idx
  ON outbound_commands (business_id, connection_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX outbound_commands_source_message_idx ON outbound_commands(source_message_id) WHERE source_message_id IS NOT NULL;

-- Unicode catalog normalization and structured calendars.
CREATE COLLATION service_name_case (provider = icu, locale = 'und', deterministic = true);
CREATE FUNCTION service_name_sha256(text) RETURNS bytea
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT pg_catalog.sha256(pg_catalog.convert_to($1, 'UTF8')) $$;
CREATE FUNCTION valid_business_weekly_schedule(schedule jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE day record; span jsonb; start_min numeric; end_min numeric;
BEGIN
  IF jsonb_typeof(schedule) <> 'object' THEN RETURN false; END IF;
  FOR day IN SELECT * FROM jsonb_each(schedule) LOOP
    IF day.key !~ '^[0-6]$' OR jsonb_typeof(day.value) <> 'array' THEN RETURN false; END IF;
    FOR span IN SELECT * FROM jsonb_array_elements(day.value) LOOP
      IF jsonb_typeof(span) <> 'object'
        OR NOT (span ? 'startMinute' AND span ? 'endMinute')
        OR (span - 'startMinute' - 'endMinute') <> '{}'::jsonb
        OR jsonb_typeof(span->'startMinute') <> 'number'
        OR jsonb_typeof(span->'endMinute') <> 'number' THEN RETURN false; END IF;
      start_min := (span->>'startMinute')::numeric;
      end_min := (span->>'endMinute')::numeric;
      IF start_min <> trunc(start_min) OR end_min <> trunc(end_min)
        OR start_min < 0 OR start_min > 1439 OR end_min < 0 OR end_min > 1440
        OR start_min = end_min THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  RETURN true;
END $$;
CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  name text NOT NULL,
  description text,
  -- ECMAScript TrimString whitespace, ICU case folding, and an unbounded full digest.
  normalized_name text COLLATE "C" GENERATED ALWAYS AS (
    lower(btrim(name, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') COLLATE service_name_case)
  ) STORED,
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0 AND duration_minutes % 15 = 0),
  price_ars numeric NOT NULL CHECK (price_ars >= 0 AND price_ars < 'Infinity'::numeric),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  deleted_at timestamptz,
  CHECK (normalized_name <> ''),
  CONSTRAINT services_business_id_id_key UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX services_business_name_key
  ON services (business_id, service_name_sha256(normalized_name)) WHERE deleted_at IS NULL;
CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  first_name text NOT NULL,
  last_name text NOT NULL,
  phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{1,14}$'),
  CHECK (btrim(first_name, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> ''),
  CHECK (btrim(last_name, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> ''),
  CONSTRAINT clients_business_phone_key UNIQUE (business_id, phone),
  CONSTRAINT clients_business_id_key UNIQUE (business_id, id)
);
CREATE TABLE business_calendars (
  business_id uuid PRIMARY KEY REFERENCES businesses(id),
  weekly_schedule jsonb NOT NULL CHECK (valid_business_weekly_schedule(weekly_schedule))
);
-- Exact interval input is retained; repositories derive epoch milliseconds without SQL timestamp parsing.
CREATE TABLE business_calendar_closures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  kind text NOT NULL CHECK (kind IN ('date', 'interval')),
  closed_date date,
  start_raw text,
  end_raw text,
  start_ms bigint,
  end_ms bigint,
  CHECK (
    (kind = 'date' AND closed_date IS NOT NULL
      AND closed_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND start_raw IS NULL AND end_raw IS NULL AND start_ms IS NULL AND end_ms IS NULL)
    OR (kind = 'interval' AND closed_date IS NULL
      AND start_raw IS NOT NULL AND end_raw IS NOT NULL
      AND start_ms IS NOT NULL AND end_ms IS NOT NULL AND end_ms > start_ms
      AND start_ms BETWEEN -62135683140000 AND 253402387139999
      AND end_ms BETWEEN -62135683140000 AND 253402387139999)
  )
);
CREATE INDEX business_calendar_closures_business_id ON business_calendar_closures(business_id, id);
CREATE TABLE resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  name text NOT NULL,
  description text,
  normalized_name text COLLATE "C" GENERATED ALWAYS AS (
    lower(btrim(name, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') COLLATE service_name_case)
  ) STORED,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  weekly_schedule jsonb NOT NULL CHECK (valid_business_weekly_schedule(weekly_schedule)),
  deleted_at timestamptz,
  CHECK (normalized_name <> ''),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX resources_business_name_key
  ON resources (business_id, service_name_sha256(normalized_name)) WHERE deleted_at IS NULL;
CREATE TABLE resource_services (
  business_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  service_id uuid NOT NULL,
  PRIMARY KEY (business_id, resource_id, service_id),
  FOREIGN KEY (business_id, resource_id) REFERENCES resources(business_id, id),
  FOREIGN KEY (business_id, service_id) REFERENCES services(business_id, id)
);
-- Frozen terms keep catalog identity and tenant-composite FKs; deletion never erases history.
CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  client_id uuid NOT NULL,
  service_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  customer_resource_preference_id uuid,
  service_label text NOT NULL CHECK (
    btrim(service_label, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> ''
  ),
  resource_label text NOT NULL CHECK (
    btrim(resource_label, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> ''
  ),
  price_ars numeric NOT NULL CHECK (price_ars >= 0 AND price_ars < 'Infinity'::numeric),
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0 AND duration_minutes % 15 = 0),
  start_raw text NOT NULL,
  start_ms bigint NOT NULL CHECK (start_ms BETWEEN -62135683140000 AND 253402387139999),
  end_ms bigint NOT NULL CHECK (end_ms BETWEEN -62135683140000 AND 253402387139999),
  CHECK (end_ms > start_ms AND end_ms::numeric = start_ms::numeric + duration_minutes::numeric * 60000),
  state text NOT NULL CHECK (state IN ('confirmed', 'done', 'cancelled', 'no_show')),
  origin text NOT NULL CHECK (origin IN ('manual', 'ai')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, client_id) REFERENCES clients(business_id, id),
  FOREIGN KEY (business_id, service_id) REFERENCES services(business_id, id),
  FOREIGN KEY (business_id, resource_id) REFERENCES resources(business_id, id),
  FOREIGN KEY (business_id, customer_resource_preference_id) REFERENCES resources(business_id, id),
  CONSTRAINT appointments_confirmed_capacity EXCLUDE USING gist (
    business_id WITH =,
    resource_id WITH =,
    int8range(start_ms, end_ms, '[)') WITH &&
  ) WHERE (state = 'confirmed')
);
CREATE TABLE appointment_operation_receipts (
  business_id uuid NOT NULL REFERENCES businesses(id),
  actor_id uuid NOT NULL REFERENCES auth_identities(id),
  operation_key uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('create','change','notes','state')),
  target_id uuid,
  fingerprint text,
  state text NOT NULL CHECK (state IN ('completed','failed','cancelled')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, actor_id, operation_key),
  CHECK ((kind = 'create') = (target_id IS NULL)),
  CHECK ((state = 'cancelled' AND fingerprint IS NULL AND result IS NULL)
    OR (state IN ('completed','failed') AND fingerprint IS NOT NULL AND result IS NOT NULL))
);
CREATE TABLE whatsapp_sender_bindings (
  business_id uuid NOT NULL REFERENCES businesses(id),
  connection_id uuid NOT NULL,
  FOREIGN KEY (business_id, connection_id) REFERENCES whatsapp_connections(business_id, id),
  phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  pn_jid text NOT NULL,
  lid_jid text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, connection_id, phone),
  UNIQUE (business_id, connection_id, pn_jid),
  UNIQUE (business_id, connection_id, lid_jid)
);
CREATE TABLE whatsapp_received_senders (
  business_id uuid NOT NULL REFERENCES businesses(id),
  message_id uuid PRIMARY KEY,
  connection_id uuid NOT NULL,
  FOREIGN KEY (business_id, message_id) REFERENCES messages(business_id, id),
  FOREIGN KEY (business_id, connection_id) REFERENCES whatsapp_connections(business_id, id),
  phone text NOT NULL,
  FOREIGN KEY (business_id, connection_id, phone)
    REFERENCES whatsapp_sender_bindings(business_id, connection_id, phone)
);
CREATE TABLE whatsapp_agenda_dialogues (
  business_id uuid NOT NULL REFERENCES businesses(id),
  connection_id uuid NOT NULL,
  FOREIGN KEY (business_id, connection_id) REFERENCES whatsapp_connections(business_id, id),
  phone text NOT NULL,
  dialogue jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, connection_id, phone),
  FOREIGN KEY (business_id, connection_id, phone)
    REFERENCES whatsapp_sender_bindings(business_id, connection_id, phone)
);
CREATE TABLE whatsapp_agenda_receipts (
  business_id uuid NOT NULL REFERENCES businesses(id),
  message_id uuid PRIMARY KEY,
  outbound_id uuid NOT NULL,
  FOREIGN KEY (business_id, message_id) REFERENCES messages(business_id, id),
  FOREIGN KEY (business_id, outbound_id) REFERENCES outbound_commands(business_id, outbound_id),
  operation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Owner-only shared pre-Argon2 budgets: 120/minute globally and 20/account/15 minutes.
CREATE TABLE login_throttle_global (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  attempts integer NOT NULL CHECK (attempts BETWEEN 0 AND 120),
  resets_at timestamptz NOT NULL
);
INSERT INTO login_throttle_global VALUES (true, 0, clock_timestamp());
CREATE TABLE login_throttle_accounts (
  account_hash text PRIMARY KEY CHECK (account_hash ~ '^[a-f0-9]{64}$'),
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 20),
  resets_at timestamptz NOT NULL
);
CREATE INDEX login_throttle_accounts_expiry ON login_throttle_accounts(resets_at);

-- Forced row security: policies and ACLs are independent capability boundaries.
ALTER TABLE tenant_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_records_business_user ON tenant_records FOR ALL TO agendia_runtime
  USING (current_setting('app.actor_role', true) = 'business_user'
    AND business_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (current_setting('app.actor_role', true) = 'business_user'
    AND business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_records_admin_deny ON tenant_records FOR SELECT TO agendia_admin_runtime USING (false);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['audit_events','technical_events','outbox_events','inbox_events',
    'business_profiles','assistant_configs','services','clients','business_calendars',
    'business_calendar_closures','resources','resource_services','appointments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO agendia_runtime USING (business_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (business_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t || '_tenant', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['audit_events','technical_events','outbox_events','inbox_events'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO agendia_whatsapp_runtime USING (business_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (business_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', t || '_manager_runtime', t);
  END LOOP;
END $$;
ALTER TABLE whatsapp_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_connections_tenant ON whatsapp_connections FOR SELECT TO agendia_runtime
  USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY whatsapp_connections_manager ON whatsapp_connections FOR ALL TO agendia_whatsapp_runtime
  USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE whatsapp_auth_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_auth_records FORCE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_auth_manager_only ON whatsapp_auth_records FOR ALL TO agendia_whatsapp_runtime
  USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE whatsapp_link_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_link_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_link_codes_tenant ON whatsapp_link_codes FOR SELECT TO agendia_runtime
  USING (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY whatsapp_link_codes_tenant_expiry ON whatsapp_link_codes FOR DELETE TO agendia_runtime
  USING (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY whatsapp_link_codes_manager ON whatsapp_link_codes FOR ALL TO agendia_whatsapp_runtime
  USING (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['conversations','messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO agendia_whatsapp_runtime, agendia_worker_runtime USING (business_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (business_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t || '_internal', t);
  END LOOP;
END $$;
ALTER TABLE conversation_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_summaries FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_summaries_worker ON conversation_summaries FOR ALL TO agendia_worker_runtime
  USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE outbound_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY outbound_commands_worker ON outbound_commands FOR ALL TO agendia_worker_runtime
  USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY outbound_commands_manager ON outbound_commands FOR ALL TO agendia_whatsapp_runtime
  USING (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY outbox_events_worker_runtime ON outbox_events FOR SELECT TO agendia_worker_runtime
  USING (business_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY outbox_events_worker_publish ON outbox_events FOR UPDATE TO agendia_worker_runtime
  USING (business_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY audit_events_admin_http ON audit_events FOR SELECT TO agendia_admin_runtime USING (business_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY audit_events_admin_http_insert ON audit_events FOR INSERT TO agendia_admin_runtime WITH CHECK (business_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY outbox_events_admin_http ON outbox_events FOR INSERT TO agendia_admin_runtime WITH CHECK (business_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY business_profiles_worker ON business_profiles FOR SELECT TO agendia_worker_runtime USING (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY assistant_configs_worker ON assistant_configs FOR SELECT TO agendia_worker_runtime USING (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY whatsapp_connections_worker ON whatsapp_connections FOR SELECT TO agendia_worker_runtime USING (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY audit_events_worker_select ON audit_events FOR SELECT TO agendia_worker_runtime USING (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY audit_events_worker_insert ON audit_events FOR INSERT TO agendia_worker_runtime WITH CHECK (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY technical_events_worker ON technical_events FOR INSERT TO agendia_worker_runtime WITH CHECK (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE appointment_operation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_operation_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY appointment_operation_owner ON appointment_operation_receipts FOR ALL TO agendia_runtime
  USING (business_id = nullif(current_setting('app.tenant_id',true),'')::uuid
    AND actor_id = nullif(current_setting('app.actor_id',true),'')::uuid
    AND current_setting('app.actor_role',true) = 'business_user')
  WITH CHECK (business_id = nullif(current_setting('app.tenant_id',true),'')::uuid
    AND actor_id = nullif(current_setting('app.actor_id',true),'')::uuid
    AND current_setting('app.actor_role',true) = 'business_user');
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['whatsapp_sender_bindings','whatsapp_received_senders',
    'whatsapp_agenda_dialogues','whatsapp_agenda_receipts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY tenant_manager ON %I FOR ALL TO agendia_whatsapp_runtime
      USING (business_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)
      WITH CHECK (business_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
    EXECUTE format('CREATE POLICY tenant_worker ON %I FOR ALL TO agendia_worker_runtime
      USING (business_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)
      WITH CHECK (business_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
  END LOOP;
  FOREACH tab IN ARRAY ARRAY['services','resources','resource_services','business_calendars',
    'business_calendar_closures','clients','appointments'] LOOP
    EXECUTE format('CREATE POLICY agenda_worker_read ON %I FOR SELECT TO agendia_worker_runtime
      USING (business_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
  END LOOP;
END $$;
CREATE POLICY agenda_worker_client_create ON clients FOR INSERT TO agendia_worker_runtime
  WITH CHECK (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY agenda_worker_appointment_create ON appointments FOR INSERT TO agendia_worker_runtime
  WITH CHECK (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY agenda_worker_appointment_change ON appointments FOR UPDATE TO agendia_worker_runtime
  USING (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY agenda_worker_outbox ON outbox_events FOR INSERT TO agendia_worker_runtime
  WITH CHECK (business_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

-- Final grants, not a union of historical capabilities.
REVOKE ALL ON auth_identities, web_sessions, operational_controls,
  login_throttle_global, login_throttle_accounts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON tenant_records TO agendia_runtime;
GRANT SELECT ON businesses TO agendia_runtime, agendia_admin_runtime, agendia_whatsapp_runtime, agendia_worker_runtime;
GRANT INSERT, UPDATE ON businesses TO agendia_admin_runtime;
GRANT SELECT, INSERT, UPDATE ON auth_identities, web_sessions TO agendia_admin_runtime;
GRANT SELECT ON auth_identities TO agendia_runtime;
GRANT SELECT, INSERT, UPDATE ON web_sessions TO agendia_runtime;
GRANT SELECT, INSERT, UPDATE ON business_profiles, assistant_configs, services, clients,
  business_calendars, resources, appointments TO agendia_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON business_calendar_closures TO agendia_runtime;
GRANT SELECT, INSERT, DELETE ON resource_services TO agendia_runtime;
GRANT SELECT, INSERT ON appointment_operation_receipts TO agendia_runtime;
GRANT SELECT, INSERT ON audit_events, technical_events, outbox_events, inbox_events TO agendia_runtime, agendia_whatsapp_runtime;
GRANT SELECT, INSERT ON audit_events TO agendia_admin_runtime, agendia_worker_runtime;
GRANT INSERT ON outbox_events TO agendia_admin_runtime;
GRANT SELECT ON outbox_events TO agendia_worker_runtime;
GRANT INSERT ON outbox_events, technical_events TO agendia_worker_runtime;
GRANT UPDATE (published_at) ON outbox_events TO agendia_worker_runtime;
GRANT UPDATE (published_at, link_admitted_at) ON outbox_events TO agendia_whatsapp_runtime;
GRANT SELECT ON operational_controls TO agendia_worker_runtime;
GRANT SELECT (singleton, automation_disabled, incident_reference, updated_at,
  initial_delay_seconds, active_delay_seconds, inactivity_reset_seconds)
  ON operational_controls TO agendia_whatsapp_runtime;
GRANT SELECT (singleton, additional_instructions, initial_delay_seconds, active_delay_seconds, inactivity_reset_seconds),
  UPDATE (additional_instructions, initial_delay_seconds, active_delay_seconds, inactivity_reset_seconds)
  ON operational_controls TO agendia_admin_runtime;
GRANT SELECT ON whatsapp_connections TO agendia_runtime;
GRANT SELECT, INSERT, UPDATE ON whatsapp_connections TO agendia_whatsapp_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_auth_records TO agendia_whatsapp_runtime;
GRANT SELECT, DELETE ON whatsapp_link_codes TO agendia_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_link_codes TO agendia_whatsapp_runtime;
GRANT SELECT, INSERT, UPDATE ON conversations, messages TO agendia_whatsapp_runtime;
GRANT SELECT, UPDATE ON outbound_commands TO agendia_whatsapp_runtime;
GRANT SELECT ON business_profiles, assistant_configs, whatsapp_connections, conversations, messages,
  conversation_summaries, outbound_commands TO agendia_worker_runtime;
GRANT INSERT, UPDATE ON messages, outbound_commands TO agendia_worker_runtime;
GRANT UPDATE (reply_due_at) ON conversations TO agendia_worker_runtime;
GRANT INSERT ON conversation_summaries TO agendia_worker_runtime;
GRANT SELECT, INSERT, UPDATE ON whatsapp_sender_bindings TO agendia_whatsapp_runtime;
GRANT INSERT ON whatsapp_received_senders TO agendia_whatsapp_runtime;
GRANT SELECT ON whatsapp_sender_bindings, whatsapp_received_senders TO agendia_worker_runtime;
GRANT SELECT, INSERT, UPDATE ON whatsapp_agenda_dialogues TO agendia_worker_runtime;
GRANT SELECT, INSERT ON whatsapp_agenda_receipts TO agendia_worker_runtime;
GRANT SELECT ON services, resources, resource_services, business_calendars, business_calendar_closures, clients, appointments TO agendia_worker_runtime;
GRANT INSERT ON clients TO agendia_worker_runtime;
GRANT INSERT, UPDATE ON appointments TO agendia_worker_runtime;

CREATE VIEW admin_business_status AS
  SELECT b.id,b.name,b.status,b.created_at,b.last_technical_activity_at,
    CASE WHEN a.active THEN 'active' ELSE 'inactive' END assistant_status,
    coalesce(lower(w.state),'link_required') whatsapp_status
  FROM businesses b LEFT JOIN assistant_configs a ON a.business_id=b.id
  LEFT JOIN whatsapp_connections w ON w.business_id=b.id;
GRANT SELECT ON admin_business_status TO agendia_admin_runtime;

-- Trigger and capability-function bodies retain the established locking and security contracts.
CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit events are append-only'; END $$;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE FUNCTION project_last_technical_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE businesses
  SET last_technical_activity_at = greatest(
    coalesce(last_technical_activity_at, NEW.occurred_at),
    NEW.occurred_at
  )
  WHERE id = NEW.business_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER technical_events_project_activity
AFTER INSERT ON technical_events
FOR EACH ROW EXECUTE FUNCTION project_last_technical_activity();

CREATE FUNCTION route_whatsapp_session(_session uuid) RETURNS TABLE(business_id uuid,connection_id uuid,business_status text,assistant_active boolean)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT w.business_id,w.id,b.status,coalesce(a.active,false) FROM whatsapp_connections w JOIN businesses b ON b.id=w.business_id LEFT JOIN assistant_configs a ON a.business_id=b.id WHERE w.session_public_id=_session AND w.state='CONNECTED'
$$;
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
CREATE FUNCTION restorable_whatsapp_connections()
RETURNS TABLE(id uuid,business_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT w.id,w.business_id FROM whatsapp_connections w
  JOIN businesses b ON b.id=w.business_id
  WHERE b.status='active' AND (w.state IN ('CONNECTED','RECONNECTING','DISCONNECTED') OR w.link_pending)
$$;
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
CREATE FUNCTION admit_login(account_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  budget login_throttle_global%ROWTYPE;
  instant timestamptz;
  used integer;
BEGIN
  IF account_key IS NULL OR account_key !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  -- One short database critical section serializes admission across all API instances.
  SELECT * INTO STRICT budget FROM login_throttle_global WHERE singleton FOR UPDATE;
  instant := clock_timestamp();
  DELETE FROM login_throttle_accounts WHERE account_hash IN (
    SELECT account_hash FROM login_throttle_accounts WHERE resets_at <= instant
    ORDER BY resets_at LIMIT 128
  );
  IF budget.resets_at <= instant THEN
    budget.attempts := 0;
    budget.resets_at := instant + interval '1 minute';
  END IF;
  IF budget.attempts >= 120 THEN RETURN false; END IF;
  UPDATE login_throttle_global SET attempts=budget.attempts+1, resets_at=budget.resets_at WHERE singleton;
  -- Allocate only AFTER charging the global budget: arbitrary email churn cannot grow
  -- this table beyond 120 admissions/minute over a 15-minute retention horizon.
  INSERT INTO login_throttle_accounts VALUES (account_key, 1, instant + interval '15 minutes')
  ON CONFLICT (account_hash) DO UPDATE SET
    attempts=CASE WHEN login_throttle_accounts.resets_at <= instant THEN 1 ELSE login_throttle_accounts.attempts+1 END,
    resets_at=CASE WHEN login_throttle_accounts.resets_at <= instant THEN instant + interval '15 minutes' ELSE login_throttle_accounts.resets_at END
  WHERE login_throttle_accounts.resets_at <= instant OR login_throttle_accounts.attempts < 20
  RETURNING attempts INTO used;
  RETURN used IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION route_whatsapp_session(uuid),claim_ai_outbox(uuid,integer,integer),
  complete_ai_outbox(uuid,uuid),release_ai_outbox(uuid,uuid,integer),
  claim_whatsapp_link_command(uuid),complete_whatsapp_link_command(uuid,uuid,uuid),
  restorable_whatsapp_connections(),claim_owned_outbound(text,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION route_whatsapp_session(uuid),claim_ai_outbox(uuid,integer,integer),
  complete_ai_outbox(uuid,uuid),release_ai_outbox(uuid,uuid,integer),
  claim_whatsapp_link_command(uuid),complete_whatsapp_link_command(uuid,uuid,uuid),
  restorable_whatsapp_connections(),claim_owned_outbound(text,uuid[]) TO agendia_whatsapp_runtime;
REVOKE ALL ON FUNCTION append_runtime_audit(uuid,text,text,text,text,text),admit_login(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION append_runtime_audit(uuid,text,text,text,text,text) TO agendia_runtime,agendia_whatsapp_runtime;
GRANT EXECUTE ON FUNCTION admit_login(text) TO agendia_runtime;
