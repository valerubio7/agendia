CREATE TABLE platform_ai_instructions (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  additional_instructions text NOT NULL DEFAULT ''
);

INSERT INTO platform_ai_instructions (singleton) VALUES (true);

REVOKE ALL ON platform_ai_instructions FROM PUBLIC, agendia_runtime,
  agendia_admin_runtime, agendia_worker_runtime, agendia_whatsapp_runtime;
GRANT SELECT, UPDATE ON platform_ai_instructions TO agendia_admin_runtime;
GRANT SELECT ON platform_ai_instructions TO agendia_worker_runtime;
