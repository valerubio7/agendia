-- Preserve the insufficient-privilege contract while retaining the deletion fence.
CREATE OR REPLACE FUNCTION guard_live_business_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE tenant uuid; removed timestamptz;
BEGIN
  tenant := NEW.business_id;
  IF TG_OP = 'UPDATE' AND OLD.business_id IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'new row violates row-level security policy for table "%"', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  IF tenant IS NULL THEN RETURN NEW; END IF;
  SELECT deleted_at INTO removed FROM public.businesses WHERE id=tenant FOR SHARE;
  IF NOT FOUND OR removed IS NOT NULL THEN RAISE EXCEPTION 'business is deleted'; END IF;
  RETURN NEW;
END $$;
