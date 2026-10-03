-- One invoker statement is atomic both in autocommit and in the runner's outer transaction.
DO $$
BEGIN
  -- FORCE RLS can hide rows even from the table owner. session_user is insufficient
  -- when SET ROLE restricts the execution identity. Missing permissions must error.
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'Assistant consolidation requires current_user with BYPASSRLS or superuser';
  END IF;

  -- Prevent concurrent source changes between conversion verification and removal.
  LOCK TABLE assistant_configs IN ACCESS EXCLUSIVE MODE;
  ALTER TABLE assistant_configs
    ADD COLUMN style TEXT NOT NULL DEFAULT '',
    ADD COLUMN business_instructions TEXT NOT NULL DEFAULT '';

  -- Omit only exactly empty values; retain every other byte and all metadata.
  UPDATE assistant_configs SET
    style = concat_ws(E'\n\n',
      CASE WHEN personality <> '' THEN E'Personalidad:\n' || personality END,
      CASE WHEN tone <> '' THEN E'Tono:\n' || tone END),
    business_instructions = concat_ws(E'\n\n',
      CASE WHEN instructions <> '' THEN E'Instrucciones:\n' || instructions END,
      CASE WHEN knowledge <> '' THEN E'Conocimiento:\n' || knowledge END,
      CASE WHEN rules <> '' THEN E'Reglas:\n' || rules END,
      CASE WHEN restrictions <> '' THEN E'Restricciones:\n' || restrictions END);

  IF EXISTS (
    SELECT 1 FROM assistant_configs WHERE
      convert_to(style, 'UTF8') IS DISTINCT FROM convert_to(concat_ws(E'\n\n',
        CASE WHEN personality <> '' THEN E'Personalidad:\n' || personality END,
        CASE WHEN tone <> '' THEN E'Tono:\n' || tone END), 'UTF8')
      OR convert_to(business_instructions, 'UTF8') IS DISTINCT FROM convert_to(concat_ws(E'\n\n',
        CASE WHEN instructions <> '' THEN E'Instrucciones:\n' || instructions END,
        CASE WHEN knowledge <> '' THEN E'Conocimiento:\n' || knowledge END,
        CASE WHEN rules <> '' THEN E'Reglas:\n' || rules END,
        CASE WHEN restrictions <> '' THEN E'Restricciones:\n' || restrictions END), 'UTF8')
  ) THEN
    RAISE EXCEPTION 'Assistant consolidation verification failed';
  END IF;

  ALTER TABLE assistant_configs
    DROP COLUMN personality,
    DROP COLUMN tone,
    DROP COLUMN instructions,
    DROP COLUMN knowledge,
    DROP COLUMN rules,
    DROP COLUMN restrictions;
END
$$;
