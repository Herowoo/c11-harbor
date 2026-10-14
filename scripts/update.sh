#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

if ! docker compose version >/dev/null 2>&1; then
  echo 'Docker Compose v2 is required.' >&2
  exit 1
fi

echo 'Pulling the configured C11 Harbor image...'
docker compose pull harbor
echo 'Updating the service with its existing data volume...'
docker compose up -d --no-build --no-deps harbor

attempt=0
while [ "$attempt" -lt 12 ]; do
  if docker compose exec -T harbor node -e "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1);return r.json()}).then(v=>console.log('C11 Harbor v'+v.version+' is running')).catch(()=>process.exit(1))"; then
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 5
done
echo 'The image was updated, but service health is not confirmed. Inspect docker compose logs harbor.' >&2
exit 1
