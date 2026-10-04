ALTER TABLE operational_controls
  ADD COLUMN additional_instructions text NOT NULL DEFAULT '';

-- Workers retain their existing read-only table grant; WhatsApp reads only operational metadata.
REVOKE SELECT ON operational_controls FROM agendia_whatsapp_runtime;
GRANT SELECT (singleton, automation_disabled, incident_reference, updated_at)
  ON operational_controls TO agendia_whatsapp_runtime;
GRANT SELECT (singleton, additional_instructions), UPDATE (additional_instructions)
  ON operational_controls TO agendia_admin_runtime;
