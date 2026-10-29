ALTER TABLE whatsapp_agenda_receipts ALTER COLUMN outbound_id DROP NOT NULL;
ALTER TABLE whatsapp_agenda_receipts ADD CONSTRAINT whatsapp_agenda_receipts_silent_output_check
  CHECK ((operation = 'silent' AND outbound_id IS NULL) OR (operation <> 'silent' AND outbound_id IS NOT NULL));
