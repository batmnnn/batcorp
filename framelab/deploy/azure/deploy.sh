#!/usr/bin/env bash
# Deploys the public, read-only FrameLab viewer to Azure Container Apps, in its own resource group.
# Safe to rerun: it creates whatever is missing and rolls the app to an image of the current commit.
# Nothing is published by this script; bundles go up with scripts/publish-bundle.ts.
# Tear everything down with: az group delete -n "${FRAMELAB_AZ_RG:-rg-framelab}"
set -euo pipefail

RG="${FRAMELAB_AZ_RG:-rg-framelab}"
LOCATION="${FRAMELAB_AZ_LOCATION:-centralindia}"
APP="${FRAMELAB_AZ_APP:-framelab}"
ENV_NAME=cae-framelab
ID_NAME=id-framelab
SHARE=bundles
IMAGE_REPO=framelab-viewer

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TOP="$(git -C "$ROOT" rev-parse --show-toplevel)"
PREFIX="$(git -C "$ROOT" rev-parse --show-prefix)"
COMMIT="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
SHIPPED=(LICENSE NOTICE viewer/index.html rulepacks src/ui/server.ts src/ui/hosted.ts deploy/azure/Dockerfile)

# The image is built from the commit, so refuse when the files it ships differ from that commit.
if [ -n "$(git -C "$ROOT" status --porcelain -- "${SHIPPED[@]}")" ]; then
  echo "deploy: uncommitted changes in files the image ships; commit them first:" >&2
  git -C "$ROOT" status --short -- "${SHIPPED[@]}" >&2
  exit 2
fi

export AZURE_CORE_ONLY_SHOW_ERRORS=true
step() { printf '\n== %s\n' "$*"; }

SUB="$(az account show --query id -o tsv)"
SUFFIX="$(printf %s "$SUB" | shasum | cut -c1-8)"
ACR="framelab$SUFFIX"
STORAGE="framelab$SUFFIX"
IMAGE="$ACR.azurecr.io/$IMAGE_REPO:$COMMIT"

step "resource group $RG ($LOCATION)"
az group create -n "$RG" -l "$LOCATION" --tags app=framelab -o none

step "registry $ACR"
az acr show -n "$ACR" -g "$RG" -o none 2>/dev/null || az acr create -n "$ACR" -g "$RG" -l "$LOCATION" --sku Basic --admin-enabled false -o none
ACR_ID="$(az acr show -n "$ACR" -g "$RG" --query id -o tsv)"

step "pull identity $ID_NAME"
az identity show -n "$ID_NAME" -g "$RG" -o none 2>/dev/null || az identity create -n "$ID_NAME" -g "$RG" -l "$LOCATION" -o none
ID_RES="$(az identity show -n "$ID_NAME" -g "$RG" --query id -o tsv)"
ID_PRINCIPAL="$(az identity show -n "$ID_NAME" -g "$RG" --query principalId -o tsv)"
if [ -z "$(az role assignment list --assignee "$ID_PRINCIPAL" --scope "$ACR_ID" --role AcrPull --query '[0].id' -o tsv)" ]; then
  for attempt in 1 2 3 4 5 6; do
    az role assignment create --assignee-object-id "$ID_PRINCIPAL" --assignee-principal-type ServicePrincipal --scope "$ACR_ID" --role AcrPull -o none && break
    [ "$attempt" = 6 ] && exit 1
    sleep 10
  done
fi

step "bundle storage $STORAGE/$SHARE (mounted read-only)"
az storage account show -n "$STORAGE" -g "$RG" -o none 2>/dev/null || az storage account create -n "$STORAGE" -g "$RG" -l "$LOCATION" \
  --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 --https-only true --allow-blob-public-access false -o none
az storage share-rm show -g "$RG" --storage-account "$STORAGE" -n "$SHARE" -o none 2>/dev/null || az storage share-rm create -g "$RG" --storage-account "$STORAGE" -n "$SHARE" --quota 1 -o none

step "environment $ENV_NAME"
az containerapp env show -n "$ENV_NAME" -g "$RG" -o none 2>/dev/null || az containerapp env create -n "$ENV_NAME" -g "$RG" -l "$LOCATION" --logs-destination none -o none
STORAGE_KEY="$(az storage account keys list -g "$RG" -n "$STORAGE" --query '[0].value' -o tsv)"
az containerapp env storage set -n "$ENV_NAME" -g "$RG" --storage-name "$SHARE" --access-mode ReadOnly \
  --azure-file-account-name "$STORAGE" --azure-file-account-key "$STORAGE_KEY" --azure-file-share-name "$SHARE" -o none
unset STORAGE_KEY
ENV_ID="$(az containerapp env show -n "$ENV_NAME" -g "$RG" --query id -o tsv)"
FQDN="$APP.$(az containerapp env show -n "$ENV_NAME" -g "$RG" --query properties.defaultDomain -o tsv)"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
step "image $IMAGE"
if [ -n "$(az acr repository show -n "$ACR" --image "$IMAGE_REPO:$COMMIT" --query digest -o tsv 2>/dev/null)" ]; then
  echo "already built"
else
  git -C "$TOP" archive --format=tar "HEAD:$PREFIX" | tar -x -C "$STAGE"
  if ! az acr build -r "$ACR" -t "$IMAGE_REPO:$COMMIT" -f deploy/azure/Dockerfile --platform linux/amd64 "$STAGE"; then
    echo "az acr build failed; building locally with docker instead" >&2
    az acr login -n "$ACR"
    docker buildx build --platform linux/amd64 -f "$STAGE/deploy/azure/Dockerfile" -t "$IMAGE" --push "$STAGE"
  fi
fi

step "app $APP"
cat >"$STAGE/app.yaml" <<YAML
location: $LOCATION
identity:
  type: UserAssigned
  userAssignedIdentities:
    $ID_RES: {}
properties:
  managedEnvironmentId: $ENV_ID
  configuration:
    activeRevisionsMode: Single
    ingress:
      external: true
      targetPort: 8080
      transport: http
      allowInsecure: false
    registries:
      - server: $ACR.azurecr.io
        identity: $ID_RES
  template:
    containers:
      - name: viewer
        image: $IMAGE
        resources:
          cpu: 0.25
          memory: 0.5Gi
        env:
          - name: FRAMELAB_PUBLIC_HOSTS
            value: $FQDN
        volumeMounts:
          - volumeName: bundles
            mountPath: /app/bundles
        probes:
          - type: Liveness
            httpGet:
              path: /healthz
              port: 8080
          - type: Readiness
            httpGet:
              path: /healthz
              port: 8080
    scale:
      minReplicas: 0
      maxReplicas: 2
    volumes:
      - name: bundles
        storageType: AzureFile
        storageName: $SHARE
YAML
if az containerapp show -n "$APP" -g "$RG" -o none 2>/dev/null; then
  az containerapp update -n "$APP" -g "$RG" --yaml "$STAGE/app.yaml" -o none
else
  az containerapp create -n "$APP" -g "$RG" --yaml "$STAGE/app.yaml" -o none
fi

step "live"
for attempt in $(seq 1 30); do
  if curl -fsS -o /dev/null "https://$FQDN/healthz"; then
    echo "https://$FQDN/"
    exit 0
  fi
  sleep 5
done
echo "deploy: https://$FQDN/healthz did not answer within 150 s" >&2
exit 1
