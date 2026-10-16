-- Shared pre-Argon2 budgets: 120 attempts/minute globally, 20/account/15 minutes.
-- Count failures AND successes. No peer quota: Next can aggregate the entire site's peers.
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
REVOKE ALL ON login_throttle_global, login_throttle_accounts FROM PUBLIC;

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
REVOKE ALL ON FUNCTION admit_login(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admit_login(text) TO agendia_runtime;
