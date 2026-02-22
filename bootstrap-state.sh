#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# bootstrap-state.sh
# Run ONCE to create the Azure Storage Account that will hold all Terraform
# state files and the TerraPortal inventory blob.
#
# Usage:
#   export AZURE_SUBSCRIPTION_ID="<your-subscription-id>"
#   export AZURE_LOCATION="East US"          # optional, default: eastus
#   export TF_STATE_RG="rg-terraportal-state"         # optional
#   export TF_STATE_STORAGE_ACCOUNT="terraportalstate" # optional (must be globally unique!)
#   ./scripts/bootstrap-state.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

LOCATION="${AZURE_LOCATION:-eastus}"
RG="${TF_STATE_RG:-rg-terraportal-state}"
SA="${TF_STATE_STORAGE_ACCOUNT:-terraportalstate}"
SUBSCRIPTION="${AZURE_SUBSCRIPTION_ID:?AZURE_SUBSCRIPTION_ID must be set}"

echo "═══════════════════════════════════════════════════════════"
echo "  TerraPortal — Terraform State Bootstrap"
echo "═══════════════════════════════════════════════════════════"
echo "  Subscription : $SUBSCRIPTION"
echo "  Location     : $LOCATION"
echo "  Resource Group: $RG"
echo "  Storage Acct : $SA"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Set subscription
az account set --subscription "$SUBSCRIPTION"

# ── Resource Group ────────────────────────────────────────────────────────
echo "▶ Creating resource group '$RG'..."
az group create \
  --name "$RG" \
  --location "$LOCATION" \
  --tags managed_by=terraform-portal purpose=tfstate \
  --output none
echo "  ✓ Resource group ready"

# ── Storage Account ───────────────────────────────────────────────────────
echo "▶ Creating storage account '$SA'..."
az storage account create \
  --name "$SA" \
  --resource-group "$RG" \
  --location "$LOCATION" \
  --sku Standard_LRS \
  --kind StorageV2 \
  --allow-blob-public-access false \
  --min-tls-version TLS1_2 \
  --tags managed_by=terraform-portal purpose=tfstate \
  --output none
echo "  ✓ Storage account ready"

# ── Containers ────────────────────────────────────────────────────────────
for CONTAINER in tfstate inventory deployments; do
  echo "▶ Creating container '$CONTAINER'..."
  az storage container create \
    --name "$CONTAINER" \
    --account-name "$SA" \
    --auth-mode login \
    --output none
  echo "  ✓ Container '$CONTAINER' ready"
done

# ── Blob versioning (protects state files) ────────────────────────────────
echo "▶ Enabling blob versioning and soft-delete..."
az storage account blob-service-properties update \
  --account-name "$SA" \
  --resource-group "$RG" \
  --enable-versioning true \
  --enable-delete-retention true \
  --delete-retention-days 30 \
  --output none
echo "  ✓ Versioning and soft-delete enabled"

# ── Get connection string ─────────────────────────────────────────────────
CONN_STR=$(az storage account show-connection-string \
  --name "$SA" \
  --resource-group "$RG" \
  --query connectionString \
  --output tsv)

# ── Create Service Principal ──────────────────────────────────────────────
echo ""
echo "▶ Creating Service Principal for Terraform..."
SP_JSON=$(az ad sp create-for-rbac \
  --name "terraportal-tf-sp" \
  --role Contributor \
  --scopes "/subscriptions/$SUBSCRIPTION" \
  --sdk-auth \
  --output json)

CLIENT_ID=$(echo "$SP_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['clientId'])")
CLIENT_SECRET=$(echo "$SP_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['clientSecret'])")
TENANT_ID=$(echo "$SP_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['tenantId'])")

# Also grant Storage Blob Data Contributor so SP can read/write state
az role assignment create \
  --assignee "$CLIENT_ID" \
  --role "Storage Blob Data Contributor" \
  --scope "/subscriptions/$SUBSCRIPTION/resourceGroups/$RG/providers/Microsoft.Storage/storageAccounts/$SA" \
  --output none
echo "  ✓ Service Principal created and roles assigned"

# ── Output ────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✅ Bootstrap complete! Add these to GitHub Secrets:"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  AZURE_CREDENTIALS (for azure/login action):"
echo "$SP_JSON" | python3 -m json.tool
echo ""
echo "  ARM_CLIENT_ID:             $CLIENT_ID"
echo "  ARM_CLIENT_SECRET:         $CLIENT_SECRET"
echo "  ARM_TENANT_ID:             $TENANT_ID"
echo "  ARM_SUBSCRIPTION_ID:       $SUBSCRIPTION"
echo "  TF_STATE_RG:               $RG"
echo "  TF_STATE_STORAGE_ACCOUNT:  $SA"
echo "  TF_STATE_CONTAINER:        tfstate"
echo "  AZURE_STORAGE_CONNECTION_STRING: $CONN_STR"
echo ""
echo "  .env file for local dev:"
cat <<EOF
ARM_TENANT_ID=$TENANT_ID
ARM_CLIENT_ID=$CLIENT_ID
ARM_CLIENT_SECRET=$CLIENT_SECRET
ARM_SUBSCRIPTION_ID=$SUBSCRIPTION
TF_STATE_RG=$RG
TF_STATE_STORAGE_ACCOUNT=$SA
TF_STATE_CONTAINER=tfstate
INVENTORY_CONTAINER=inventory
AZURE_STORAGE_CONNECTION_STRING=$CONN_STR
DEMO_MODE=false
EOF
echo "═══════════════════════════════════════════════════════════"
