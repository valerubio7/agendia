-- SET LOCAL ROLE must retain marker reads without granting mutation privileges.
grant select on table public.agendia_environment to
  agendia_runtime,
  agendia_admin_runtime,
  agendia_whatsapp_runtime,
  agendia_worker_runtime;

-- Queue initialization uses the actual schema owner without a shared capability.
do $$
declare
  queue_owner text;
begin
  select owner.rolname into queue_owner
  from pg_namespace namespace
  join pg_roles owner on owner.oid = namespace.nspowner
  where namespace.nspname = 'pgboss';

  if queue_owner in ('agendia_stg_queue_owner', 'agendia_prod_queue_owner') then
    execute format('grant select on table public.agendia_environment to %I', queue_owner);
  end if;
end
$$;
