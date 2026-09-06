create table agendia_service_heartbeats (
  service text not null check (service in ('whatsapp-manager', 'message-worker')),
  instance_id text not null,
  release_digest text not null,
  state text not null check (state in ('ready', 'draining')),
  started_at timestamptz not null,
  last_seen_at timestamptz not null,
  primary key (service, instance_id)
);

create index agendia_service_heartbeats_freshness_idx
  on agendia_service_heartbeats (service, instance_id, last_seen_at desc);
