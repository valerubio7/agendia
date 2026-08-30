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
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), identity_id uuid NOT NULL REFERENCES auth_identities(id),
  token_sha256 char(64) NOT NULL UNIQUE, csrf_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL, idle_expires_at timestamptz NOT NULL, revoked_at timestamptz
);
REVOKE ALL ON auth_identities, web_sessions FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON auth_identities, web_sessions TO agendia_admin_runtime;
GRANT SELECT, INSERT, UPDATE ON web_sessions TO agendia_runtime;
