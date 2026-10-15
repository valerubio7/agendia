-- Operation keys are not credentials. Both tenant and authenticated actor own a receipt.
-- Terminal rows are retained indefinitely; no DELETE grant or expiry makes a key reusable.
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
ALTER TABLE appointment_operation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_operation_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY appointment_operation_owner ON appointment_operation_receipts FOR ALL TO agendia_runtime
  USING (business_id = nullif(current_setting('app.tenant_id',true),'')::uuid
    AND actor_id = nullif(current_setting('app.actor_id',true),'')::uuid
    AND current_setting('app.actor_role',true) = 'business_user')
  WITH CHECK (business_id = nullif(current_setting('app.tenant_id',true),'')::uuid
    AND actor_id = nullif(current_setting('app.actor_id',true),'')::uuid
    AND current_setting('app.actor_role',true) = 'business_user');
GRANT SELECT, INSERT ON appointment_operation_receipts TO agendia_runtime;
