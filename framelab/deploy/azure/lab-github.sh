#!/usr/bin/env bash
# Connects the judge lab to its GitHub OAuth app (run deploy-lab.sh first). Asks for the client ID,
# then the client secret without echoing it; the secret goes only to the app's secret store.
#
# Create the OAuth app at https://github.com/settings/applications/new with
#   Homepage URL:               https://batcorps.batmnnn.live/
#   Authorization callback URL: https://lab.batcorps.batmnnn.live/auth/callback
set -euo pipefail

RG="${FRAMELAB_AZ_RG:-rg-framelab}"
APP=framelab-lab
export AZURE_CORE_ONLY_SHOW_ERRORS=true

az containerapp show -n "$APP" -g "$RG" -o none 2>/dev/null || { echo "lab-github: run deploy-lab.sh first" >&2; exit 2; }

printf 'GitHub OAuth app client ID: '
read -r CLIENT_ID
printf 'Client secret (not shown): '
read -rs CLIENT_SECRET
echo
if ! printf %s "$CLIENT_ID" | grep -Eq '^[A-Za-z0-9._-]{10,64}$'; then echo "lab-github: that does not look like a client ID" >&2; exit 2; fi
if ! printf %s "$CLIENT_SECRET" | grep -Eq '^[A-Za-z0-9_-]{20,128}$'; then echo "lab-github: that does not look like a client secret" >&2; exit 2; fi

az containerapp secret set -n "$APP" -g "$RG" --secrets "github-client-secret=$CLIENT_SECRET" -o none
unset CLIENT_SECRET
az containerapp update -n "$APP" -g "$RG" --set-env-vars "GITHUB_CLIENT_ID=$CLIENT_ID" -o none
# Secret changes reach a running replica only on restart.
REV="$(az containerapp show -n "$APP" -g "$RG" --query properties.latestRevisionName -o tsv)"
az containerapp revision restart -n "$APP" -g "$RG" --revision "$REV" -o none

HOST="$(az containerapp show -n "$APP" -g "$RG" --query "properties.template.containers[0].env[?name=='LAB_PUBLIC_HOSTS'].value | [0]" -o tsv | cut -d, -f1)"
for attempt in $(seq 1 24); do
  TO="$(curl -s -o /dev/null -w '%{redirect_url}' "https://$HOST/auth/login" || true)"
  case "$TO" in
    https://github.com/login/oauth/authorize*"client_id=$CLIENT_ID"*) echo "GitHub sign-in is on: https://$HOST/"; exit 0 ;;
  esac
  sleep 5
done
echo "lab-github: https://$HOST/auth/login does not send people to GitHub yet; check the app's logs" >&2
exit 1
