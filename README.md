# ⚡ TerraPortal v2 — Azure Infrastructure Lifecycle Manager

Full-stack portal for the complete Azure resource lifecycle:
**Provision → Update → Decommission** — all via Terraform, with state stored in Azure Blob Storage.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          TerraPortal v2                              │
│                                                                       │
│  ┌─────────────┐    ┌────────────────┐    ┌──────────────────────┐  │
│  │  React UI   │───▶│  Express API   │───▶│   Terraform Engine   │  │
│  │  Port 3000  │    │  Port 3001     │    │  (per deployment)    │  │
│  └─────────────┘    └───────┬────────┘    └──────────────────────┘  │
│                             │                                         │
│                    ┌────────▼────────────────────────────┐          │
│                    │        Azure Blob Storage            │          │
│                    │  ┌──────────────┐  ┌─────────────┐  │          │
│                    │  │   tfstate/   │  │ inventory/  │  │          │
│                    │  │ <id>.tfstate │  │inventory.json│  │          │
│                    │  └──────────────┘  └─────────────┘  │          │
│                    └─────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │   GitHub Actions     │
                    │  ci-cd.yml           │  ← Portal CI/CD
                    │  terraform-lifecycle │  ← Resource ops
                    └─────────────────────┘
```

---

## ✨ Features

### Resource Lifecycle Operations
| Operation | Description |
|---|---|
| 🚀 **Provision** | Fill form → generate Terraform → `terraform apply` → inventory entry created |
| ✏️ **Update** | Shows diff preview → `terraform apply` with updated config → change history appended |
| 🗑️ **Decommission** | Confirmation dialog → `terraform destroy` → resource marked decommissioned in inventory |

### State Management
- **Isolated state per resource**: `<deployment_id>/terraform.tfstate` in Azure Blob
- **Blob versioning enabled**: protects against state corruption
- **Soft-delete**: 30-day recovery window for state files
- **Inventory blob**: `inventory/inventory.json` in Azure Blob (always in sync)

### Tagging
Every resource gets these tags automatically:
```hcl
ticket        = "JIRA-1234"         # Required ticket number
environment   = "prod"              # dev / staging / prod / dr
managed_by    = "terraform-portal"  # Always set
deployment_id = "<uuid>"            # Unique per deployment
created_at    = "<ISO timestamp>"   # Provisioning time
# + any custom tags you add in the UI
```

### Audit Trail
Every action (provision, update, decommission) logged with: actor, ticket, timestamp, changes/diff, result.

---

## 🚀 Quick Start

### 1. Bootstrap Azure State Storage (run once)
```bash
export AZURE_SUBSCRIPTION_ID="<your-subscription-id>"
chmod +x scripts/bootstrap-state.sh
./scripts/bootstrap-state.sh
```
This creates the storage account, containers, enables versioning, creates a service principal, and prints all secrets you need.

### 2. Local Development
```bash
# Copy .env from bootstrap output
cp .env.example .env
# edit .env with values from bootstrap script

# Option A: Docker Compose
docker-compose up

# Option B: Manual
cd backend  && npm install && npm run dev   # API on :3001
cd frontend && npm install && npm run dev   # UI on :3000
```

### 3. Deploy to Azure via GitHub Actions
1. Add all secrets to GitHub (Settings → Secrets → Actions)
2. Push to `main` → GitHub Actions runs automatically
3. Portal deployed to Azure Container Apps

---

## 📋 Required GitHub Secrets

| Secret | How to get it |
|---|---|
| `AZURE_CREDENTIALS` | JSON from `bootstrap-state.sh` output |
| `ARM_CLIENT_ID` | From bootstrap output |
| `ARM_CLIENT_SECRET` | From bootstrap output |
| `ARM_TENANT_ID` | From bootstrap output |
| `ARM_SUBSCRIPTION_ID` | Your Azure subscription ID |
| `TF_STATE_RG` | `rg-terraportal-state` (from bootstrap) |
| `TF_STATE_STORAGE_ACCOUNT` | Storage account name (from bootstrap) |
| `TF_STATE_CONTAINER` | `tfstate` |
| `AZURE_STORAGE_CONNECTION_STRING` | Connection string from bootstrap |
| `PORTAL_API_URL` | Deployed backend URL (after first deploy) |
| `PORTAL_API_TOKEN` | Any secret string for API auth |
| `SLACK_WEBHOOK_URL` | (Optional) Slack notifications |

---

## 🔧 API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/inventory` | All resources |
| `GET` | `/api/inventory/:id` | Single resource |
| `GET` | `/api/history` | Full audit trail |
| `GET` | `/api/resource-types` | Available resource types |
| `POST` | `/api/provision` | Provision new resource |
| `PATCH` | `/api/resources/:id` | Update existing resource |
| `DELETE` | `/api/resources/:id` | Decommission resource |
| `POST` | `/api/resources/:id/plan` | Preview update diff |
| `POST` | `/api/preview` | Preview Terraform for config |
| `GET` | `/api/resources/:id/status` | Status + logs (for polling) |

---

## 🗂️ Project Structure

```
terraportal-v2/
├── frontend/
│   ├── src/App.jsx          # Full React app (Provision/Update/Decommission UI)
│   ├── Dockerfile
│   ├── nginx.conf
│   └── vite.config.js
├── backend/
│   ├── server.js            # Express API + Terraform execution
│   ├── Dockerfile           # Includes Terraform + Azure CLI
│   └── package.json
├── terraform/
│   └── infrastructure/
│       └── main.tf          # Portal hosting on Azure Container Apps
├── scripts/
│   └── bootstrap-state.sh  # One-time Azure state storage setup
├── .github/workflows/
│   ├── ci-cd.yml            # Portal build + deploy pipeline
│   └── terraform-lifecycle.yml  # Resource provision/update/decommission
├── docker-compose.yml
└── .env.example
```

---

## 🌐 Supported Azure Resources

| Resource | Type | Updatable Fields |
|---|---|---|
| Virtual Machine | `vm` | vmSize, diskType, osDiskSizeGb |
| Storage Account | `storage` | tier, replication, versioning, retentionDays |
| AKS Cluster | `aks` | nodeCount, vmSize, k8sVersion, minNodes, maxNodes |
| SQL Database | `sql` | sku, maxSizeGb |
| Key Vault | `keyvault` | softDeleteRetention, networkDefaultAction |
| Virtual Network | `vnet` | dnsServers |

### Adding a New Resource Type
1. Add fields definition to `RESOURCE_TYPES` in `frontend/src/App.jsx`
2. Add Terraform template to `generateMainTf()` in `backend/server.js`
3. Add outputs to `generateOutputsTf()` in `backend/server.js`

---

## 🔒 Security Notes

- Immutable fields (name, region, etc.) are locked after provisioning — changing them requires re-provisioning
- Decommission requires typing the exact resource name to confirm
- All secrets via environment variables / GitHub Secrets — never in code
- State encrypted at rest in Azure Blob Storage with TLS 1.2 enforced
- Soft-delete + versioning on state storage for recovery
