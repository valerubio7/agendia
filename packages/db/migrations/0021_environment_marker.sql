create table agendia_environment (
  singleton boolean primary key default true check (singleton),
  environment text not null check (environment in ('staging', 'production')),
  environment_id uuid not null,
  secret_set_id uuid not null
);
