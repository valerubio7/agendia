#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $# == 4 ]] || { echo 'Usage: deploy-release.sh SHA namespace app-dir compose-project' >&2; exit 1; }
release=$1 namespace=$2 app_dir=$3 project=$4
[[ "$release" =~ ^[0-9a-f]{40}$ && "$namespace" =~ ^[a-z0-9_.-]+/[a-z0-9_.-]+$ ]]
[[ "$app_dir" =~ ^/[a-zA-Z0-9_/-]+$ && "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]]
env_file="$app_dir/deploy/.env.production"
[[ -d "$app_dir" && -s "$env_file" && -s "$app_dir/compose.production.yml" ]]
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$app_dir"
exec 9> .deploy.lock
flock -n 9 || { echo 'Another deployment holds the host lock' >&2; exit 1; }
mkdir -p releases backups
work=$(mktemp -d "$app_dir/releases/$release.XXXXXXXX")
cp "$source_dir/compose.production.yml" "$work/compose.production.yml"
compose() { docker compose --project-name "$project" --env-file "$env_file" -f "$work/compose.production.yml" "$@"; }
old_compose() { docker compose --project-name "$project" --env-file "$env_file" -f "$app_dir/compose.production.yml" "$@"; }
# Capture actual running image identities, not local defaults or mutable tags.
for service in api web worker manager; do
  id=$(old_compose ps -q "$service")
  [[ -n "$id" ]] || { echo "Missing existing $service; this is an update, not bootstrap" >&2; exit 1; }
  image=$(docker inspect --format '{{.Image}}' "$id")
  printf '%s=%s\n' "$service" "$image" >> "$work/previous-images"
done
previous_compose="$app_dir/compose.production.yml"
if [[ -s .release-state ]]; then
  IFS= read -r current < .release-state
  [[ "$current" == "$app_dir/releases/"* && -s "$current/compose.production.yml" ]]
  previous_compose="$current/compose.production.yml"
fi
cp "$previous_compose" "$work/previous-compose.yml"
for target in runtime web; do
  tag="ghcr.io/$namespace-$target:$release"
  docker pull "$tag"
  revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$tag")
  [[ "$revision" == "$release" ]] || { echo 'Image revision mismatch' >&2; exit 1; }
  digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$tag")
  [[ "$digest" == "ghcr.io/$namespace-$target@sha256:"* && "$digest" =~ @sha256:[0-9a-f]{64}$ ]]
  if [[ "$target" == runtime ]]; then export AGENDIA_RUNTIME_IMAGE="$digest"; else export AGENDIA_WEB_IMAGE="$digest"; fi
done
printf 'AGENDIA_RUNTIME_IMAGE=%s\nAGENDIA_WEB_IMAGE=%s\n' "$AGENDIA_RUNTIME_IMAGE" "$AGENDIA_WEB_IMAGE" > "$work/images.env"
compose config --quiet
compose pull db api web worker manager migrate provision
backup="$app_dir/backups/$(basename "$work").sql"
# pg_dump failure or empty output never reaches the downtime boundary.
old_compose exec -T db pg_dump -U agendia_migrator -d agendia > "$backup"
[[ -s "$backup" ]] || { echo 'Empty database backup; refusing downtime' >&2; exit 1; }
trap 'echo "Deployment failed after stopping apps. Leave services stopped or inspect their state; no automatic schema rollback. Recovery files: $work; backup: $backup" >&2' ERR
compose stop web api worker manager
compose run --rm --no-deps migrate
compose run --rm --no-deps provision
compose up -d --no-build db api worker manager web
healthy=false
for ((attempt=0; attempt<60; attempt++)); do
  ready=true
  for service in api web worker manager; do
    id=$(compose ps -q "$service")
    if [[ -z "$id" ]]; then ready=false; continue; fi
    state=$(docker inspect --format '{{.State.Status}}' "$id")
    [[ "$state" == running ]] || ready=false
    if [[ "$service" == api || "$service" == web ]]; then
      health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")
      [[ "$health" == healthy ]] || ready=false
    fi
  done
  if $ready; then healthy=true; break; fi
  sleep 5
done
$healthy || { echo 'Health deadline exceeded (300 seconds)' >&2; false; }
# One atomic state record changes only after all checks pass; failed attempts remain retained.
previous=none
if [[ -s .release-state ]]; then
  IFS= read -r previous < .release-state
fi
printf '%s\n%s\n' "$work" "$previous" > "$work/state"
mv "$work/state" "$app_dir/.release-state"
trap - ERR
echo "Deployed $release; current/previous release directories recorded in .release-state"
