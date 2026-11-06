#!/usr/bin/env bash
# Deploys the judge VM lab next to the hosted viewer (run deploy.sh first). Safe to rerun.
#
#   deploy-lab.sh infra   only the VM resource group, network and firewall
#   deploy-lab.sh         everything: plus the lab app, the reaper job and a budget alert
#
# GitHub sign-in stays off until lab-github.sh connects the OAuth app.
#
# Judge VMs live in their own resource group, which holds nothing else. The lab's identity can
# manage VMs and networking in that group only. Inbound traffic is SSH only; outbound is TCP 80
# and 443 only, and VMs cannot reach each other.
set -euo pipefail

STAGE_ONLY="${1:-all}"
RG="${FRAMELAB_AZ_RG:-rg-framelab}"
VMS_RG="${FRAMELAB_AZ_VMS_RG:-rg-framelab-vms}"
LOCATION="${FRAMELAB_AZ_LOCATION:-centralindia}"
DOMAIN="${FRAMELAB_LAB_DOMAIN-lab.batcorps.batmnnn.live}"
APP=framelab-lab
JOB=framelab-lab-reaper
ENV_NAME=cae-framelab
ID_NAME=id-framelab-lab
VNET=vnet-judges
SUBNET=judges
NSG=nsg-judges
IMAGE_REPO=framelab-lab
BUDGET_USD="${FRAMELAB_LAB_BUDGET_USD:-30}"

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TOP="$(git -C "$ROOT" rev-parse --show-toplevel)"
PREFIX="$(git -C "$ROOT" rev-parse --show-prefix)"
COMMIT="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
SHIPPED=(LICENSE NOTICE src/lab deploy/azure/Dockerfile.lab)

export AZURE_CORE_ONLY_SHOW_ERRORS=true
step() { printf '\n== %s\n' "$*"; }

SUB="$(az account show --query id -o tsv)"
SUFFIX="$(printf %s "$SUB" | shasum | cut -c1-8)"
ACR="framelab$SUFFIX"
STORAGE="framelab$SUFFIX"

step "VM resource group $VMS_RG"
az group create -n "$VMS_RG" -l "$LOCATION" --tags app=framelab purpose=judge-vms -o none
VMS_RG_ID="$(az group show -n "$VMS_RG" --query id -o tsv)"

step "firewall $NSG"
az network nsg show -g "$VMS_RG" -n "$NSG" -o none 2>/dev/null || az network nsg create -g "$VMS_RG" -n "$NSG" -l "$LOCATION" -o none
rule() {
  local name="$1"; shift
  if az network nsg rule show -g "$VMS_RG" --nsg-name "$NSG" -n "$name" -o none 2>/dev/null; then
    az network nsg rule update -g "$VMS_RG" --nsg-name "$NSG" -n "$name" "$@" -o none
  else
    az network nsg rule create -g "$VMS_RG" --nsg-name "$NSG" -n "$name" "$@" -o none
  fi
}
rule in-ssh --priority 100 --direction Inbound --access Allow --protocol Tcp --source-address-prefixes Internet --destination-port-ranges 22
rule in-no-vm-to-vm --priority 200 --direction Inbound --access Deny --protocol '*' --source-address-prefixes VirtualNetwork --destination-port-ranges '*'
rule out-web --priority 110 --direction Outbound --access Allow --protocol Tcp --destination-address-prefixes Internet --destination-port-ranges 80 443
rule out-no-vm-to-vm --priority 200 --direction Outbound --access Deny --protocol '*' --destination-address-prefixes VirtualNetwork --destination-port-ranges '*'
rule out-nothing-else --priority 4000 --direction Outbound --access Deny --protocol '*' --destination-address-prefixes '*' --destination-port-ranges '*'

step "network $VNET/$SUBNET"
az network vnet show -g "$VMS_RG" -n "$VNET" -o none 2>/dev/null || az network vnet create -g "$VMS_RG" -n "$VNET" -l "$LOCATION" \
  --address-prefixes 10.42.0.0/16 --subnet-name "$SUBNET" --subnet-prefixes 10.42.1.0/24 -o none
az network vnet subnet update -g "$VMS_RG" --vnet-name "$VNET" -n "$SUBNET" --network-security-group "$NSG" -o none
SUBNET_ID="$(az network vnet subnet show -g "$VMS_RG" --vnet-name "$VNET" -n "$SUBNET" --query id -o tsv)"
echo "subnet $SUBNET_ID"
[ "$STAGE_ONLY" = infra ] && exit 0

# The image is built from the commit, so refuse when the files it ships differ from that commit.
if [ -n "$(git -C "$ROOT" status --porcelain -- "${SHIPPED[@]}")" ]; then
  echo "deploy-lab: uncommitted changes in files the image ships; commit them first:" >&2
  git -C "$ROOT" status --short -- "${SHIPPED[@]}" >&2
  exit 2
fi
az containerapp env show -n "$ENV_NAME" -g "$RG" -o none 2>/dev/null || { echo "deploy-lab: run deploy.sh first" >&2; exit 2; }
ACR_ID="$(az acr show -n "$ACR" -g "$RG" --query id -o tsv)"
STORAGE_ID="$(az storage account show -n "$STORAGE" -g "$RG" --query id -o tsv)"
IMAGE="$ACR.azurecr.io/$IMAGE_REPO:$COMMIT"
FQDN="$APP.$(az containerapp env show -n "$ENV_NAME" -g "$RG" --query properties.defaultDomain -o tsv)"

step "session log table labsessions"
az rest --method put --url "https://management.azure.com$STORAGE_ID/tableServices/default/tables/labsessions?api-version=2023-05-01" --body '{}' -o none

step "lab identity $ID_NAME"
az identity show -n "$ID_NAME" -g "$RG" -o none 2>/dev/null || az identity create -n "$ID_NAME" -g "$RG" -l "$LOCATION" -o none
ID_RES="$(az identity show -n "$ID_NAME" -g "$RG" --query id -o tsv)"
ID_PRINCIPAL="$(az identity show -n "$ID_NAME" -g "$RG" --query principalId -o tsv)"
ID_CLIENT="$(az identity show -n "$ID_NAME" -g "$RG" --query clientId -o tsv)"
grant() {
  local role="$1" scope="$2"
  [ -n "$(az role assignment list --assignee "$ID_PRINCIPAL" --scope "$scope" --role "$role" --query '[0].id' -o tsv)" ] && return 0
  for attempt in 1 2 3 4 5 6; do
    az role assignment create --assignee-object-id "$ID_PRINCIPAL" --assignee-principal-type ServicePrincipal --scope "$scope" --role "$role" -o none && return 0
    [ "$attempt" = 6 ] && return 1
    sleep 10
  done
}
# Everything it can change is in the VM group; elsewhere it can pull its image and write the session log.
grant "Virtual Machine Contributor" "$VMS_RG_ID"
grant "Network Contributor" "$VMS_RG_ID"
grant Reader "$VMS_RG_ID"
grant AcrPull "$ACR_ID"
grant "Storage Table Data Contributor" "$STORAGE_ID/tableServices/default/tables/labsessions"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
step "image $IMAGE"
if [ -n "$(az acr repository show -n "$ACR" --image "$IMAGE_REPO:$COMMIT" --query digest -o tsv 2>/dev/null)" ]; then
  echo "already built"
else
  git -C "$TOP" archive --format=tar "HEAD:$PREFIX" | tar -x -C "$STAGE"
  if ! az acr build -r "$ACR" -t "$IMAGE_REPO:$COMMIT" -f deploy/azure/Dockerfile.lab --platform linux/amd64 "$STAGE"; then
    echo "az acr build failed; building locally with docker instead" >&2
    az acr login -n "$ACR"
    docker buildx build --platform linux/amd64 -f "$STAGE/deploy/azure/Dockerfile.lab" -t "$IMAGE" --push "$STAGE"
  fi
fi

COMMON_ENV=(
  "AZURE_CLIENT_ID=$ID_CLIENT"
  "AZURE_SUBSCRIPTION_ID=$SUB"
  "LAB_RESOURCE_GROUP=$VMS_RG"
  "LAB_LOCATION=$LOCATION"
  "LAB_SUBNET_ID=$SUBNET_ID"
)

step "app $APP"
if ! az containerapp show -n "$APP" -g "$RG" -o none 2>/dev/null; then
  # First run only: a random session key, and placeholders until lab-github.sh connects the OAuth app.
  ( umask 077
    cat >"$STAGE/app.yaml" <<YAML
location: $LOCATION
identity:
  type: UserAssigned
  userAssignedIdentities:
    $ID_RES: {}
properties:
  managedEnvironmentId: $(az containerapp env show -n "$ENV_NAME" -g "$RG" --query id -o tsv)
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
    secrets:
      - name: session-key
        value: $(openssl rand -base64 48 | tr -d '\n')
      - name: github-client-secret
        value: not-configured
  template:
    containers:
      - name: lab
        image: $IMAGE
        resources:
          cpu: 0.25
          memory: 0.5Gi
        env:
          - name: SESSION_KEY
            secretRef: session-key
          - name: GITHUB_CLIENT_SECRET
            secretRef: github-client-secret
          - name: GITHUB_CLIENT_ID
            value: not-configured
          - name: LAB_PUBLIC_HOSTS
            value: $FQDN
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
      maxReplicas: 1
YAML
  )
  az containerapp create -n "$APP" -g "$RG" --yaml "$STAGE/app.yaml" -o none
  rm -f "$STAGE/app.yaml"
fi

BOUND=""
if [ -n "$DOMAIN" ]; then
  if [ -n "$(az containerapp hostname list -n "$APP" -g "$RG" --query "[?name=='$DOMAIN' && bindingType=='SniEnabled'].name" -o tsv)" ]; then
    BOUND=1
  else
    step "custom domain $DOMAIN"
    VERIFY="$(az containerapp show -n "$APP" -g "$RG" --query properties.customDomainVerificationId -o tsv)"
    CNAME="$(dig +short CNAME "$DOMAIN" @1.1.1.1 | sed 's/\.$//')"
    TXT="$(dig +short TXT "asuid.$DOMAIN" @1.1.1.1 | tr -d '"')"
    if [ "$CNAME" = "$FQDN" ] && [ "$TXT" = "$VERIFY" ]; then
      if [ -z "$(az containerapp hostname list -n "$APP" -g "$RG" --query "[?name=='$DOMAIN'].name" -o tsv)" ]; then
        az containerapp hostname add -n "$APP" -g "$RG" --hostname "$DOMAIN" -o none
      fi
      az containerapp hostname bind -n "$APP" -g "$RG" --hostname "$DOMAIN" --environment "$ENV_NAME" --validation-method CNAME -o none && BOUND=1
    else
      echo "DNS for $DOMAIN is not in place yet. Add these two records, then rerun this script:"
      echo "  CNAME  $DOMAIN  ->  $FQDN"
      echo "  TXT    asuid.$DOMAIN  =  $VERIFY"
    fi
  fi
fi
# The first host is where GitHub sends judges back, so it is the custom domain once that is served.
HOSTS="$FQDN"
[ -n "$BOUND" ] && HOSTS="$DOMAIN,$FQDN"

az containerapp update -n "$APP" -g "$RG" --image "$IMAGE" --set-env-vars "${COMMON_ENV[@]}" \
  "LAB_PUBLIC_HOSTS=$HOSTS" "LAB_TABLE_ACCOUNT=$STORAGE" \
  "LAB_REPO=${FRAMELAB_LAB_REPO:-https://github.com/batmnnn/batcorp.git}" "LAB_REF=${FRAMELAB_LAB_REF:-main}" \
  "VIEWER_URL=${FRAMELAB_VIEWER_URL:-https://batcorps.batmnnn.live/}" -o none

step "reaper $JOB (every 5 minutes)"
if az containerapp job show -n "$JOB" -g "$RG" -o none 2>/dev/null; then
  az containerapp job update -n "$JOB" -g "$RG" --image "$IMAGE" --set-env-vars "${COMMON_ENV[@]}" -o none
else
  az containerapp job create -n "$JOB" -g "$RG" --environment "$ENV_NAME" \
    --trigger-type Schedule --cron-expression "*/5 * * * *" \
    --replica-timeout 600 --replica-retry-limit 0 --parallelism 1 --replica-completion-count 1 \
    --image "$IMAGE" --registry-server "$ACR.azurecr.io" --registry-identity "$ID_RES" --mi-user-assigned "$ID_RES" \
    --cpu 0.25 --memory 0.5Gi --command bun --args src/lab/reap.ts \
    --env-vars "${COMMON_ENV[@]}" -o none
fi

step "budget alert (\$$BUDGET_USD a month on $VMS_RG)"
EMAIL="${FRAMELAB_BUDGET_EMAIL:-$(az account show --query user.name -o tsv)}"
cat >"$STAGE/budget.json" <<JSON
{"properties": {"category": "Cost", "amount": $BUDGET_USD, "timeGrain": "Monthly",
  "timePeriod": {"startDate": "$(date -u +%Y-%m-01)T00:00:00Z"},
  "notifications": {
    "actual-50": {"enabled": true, "operator": "GreaterThan", "threshold": 50, "thresholdType": "Actual", "contactEmails": ["$EMAIL"]},
    "actual-100": {"enabled": true, "operator": "GreaterThan", "threshold": 100, "thresholdType": "Actual", "contactEmails": ["$EMAIL"]},
    "forecast-100": {"enabled": true, "operator": "GreaterThan", "threshold": 100, "thresholdType": "Forecasted", "contactEmails": ["$EMAIL"]}}}}
JSON
if az rest --method put --url "https://management.azure.com$VMS_RG_ID/providers/Microsoft.Consumption/budgets/framelab-judge-vms?api-version=2023-05-01" --body "@$STAGE/budget.json" -o none; then
  echo "emails $EMAIL at 50% and 100%"
else
  echo "deploy-lab: the budget alert could not be set; the VM limits still apply" >&2
fi

step "live"
for attempt in $(seq 1 30); do
  if curl -fsS -o /dev/null "https://$FQDN/healthz"; then
    echo "https://${HOSTS%%,*}/"
    if [ "$(az containerapp show -n "$APP" -g "$RG" --query "properties.template.containers[0].env[?name=='GITHUB_CLIENT_ID'].value | [0]" -o tsv)" = not-configured ]; then
      echo "GitHub sign-in is off until you run deploy/azure/lab-github.sh"
    fi
    exit 0
  fi
  sleep 5
done
echo "deploy-lab: https://$FQDN/healthz did not answer within 150 s" >&2
exit 1
