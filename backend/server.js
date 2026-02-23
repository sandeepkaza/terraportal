'use strict';

const express = require('express');
const cors = require('cors');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────
// CONFIG — driven by env vars (set in GitHub Secrets / .env)
// ─────────────────────────────────────────────────────────────
const AZURE_REGIONS = ['East US','East US 2','West US','West US 2','West Europe','North Europe','Southeast Asia','Australia East','UK South','Canada Central','Japan East'];

const CONFIG = {
  PORT: process.env.PORT || 3001,
  // Azure state backend
  ARM_TENANT_ID:       process.env.ARM_TENANT_ID       || '',
  ARM_CLIENT_ID:       process.env.ARM_CLIENT_ID       || '',
  ARM_CLIENT_SECRET:   process.env.ARM_CLIENT_SECRET   || '',
  ARM_SUBSCRIPTION_ID: process.env.ARM_SUBSCRIPTION_ID || '',
  // Blob Storage for Terraform state + inventory
  TF_STATE_RG:              process.env.TF_STATE_RG              || 'rg-terraportal-state',
  TF_STATE_STORAGE_ACCOUNT: process.env.TF_STATE_STORAGE_ACCOUNT || 'terraportalstate',
  TF_STATE_CONTAINER:       process.env.TF_STATE_CONTAINER       || 'tfstate',
  INVENTORY_CONTAINER:      process.env.INVENTORY_CONTAINER      || 'inventory',
  DEPLOYMENTS_DIR: path.join(__dirname, '../terraform/deployments'),
  DEMO_MODE: process.env.DEMO_MODE !== 'false', // true unless explicitly disabled
};

// Local inventory fallback (used in demo mode or when Azure not configured)
const LOCAL_INVENTORY = path.join(__dirname, 'inventory.json');
if (!fs.existsSync(LOCAL_INVENTORY)) fs.writeFileSync(LOCAL_INVENTORY, JSON.stringify({ resources: [], history: [] }, null, 2));
if (!fs.existsSync(CONFIG.DEPLOYMENTS_DIR)) fs.mkdirSync(CONFIG.DEPLOYMENTS_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────
// AZURE BLOB STORAGE — inventory + state persistence
// ─────────────────────────────────────────────────────────────
async function azureBlobUpload(container, blobName, content) {
  if (CONFIG.DEMO_MODE || !CONFIG.ARM_CLIENT_ID) return null;
  try {
    const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');
    const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const client = BlobServiceClient.fromConnectionString(connStr);
    const cc = client.getContainerClient(container);
    await cc.createIfNotExists();
    const bc = cc.getBlockBlobClient(blobName);
    await bc.upload(content, Buffer.byteLength(content), { blobHTTPHeaders: { blobContentType: 'application/json' } });
    return true;
  } catch (e) {
    console.error('Blob upload error:', e.message);
    return null;
  }
}

async function azureBlobDownload(container, blobName) {
  if (CONFIG.DEMO_MODE || !CONFIG.ARM_CLIENT_ID) return null;
  try {
    const { BlobServiceClient } = require('@azure/storage-blob');
    const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const client = BlobServiceClient.fromConnectionString(connStr);
    const cc = client.getContainerClient(container);
    const bc = cc.getBlockBlobClient(blobName);
    const dl = await bc.download(0);
    const chunks = [];
    for await (const chunk of dl.readableStreamBody) chunks.push(chunk);
    return Buffer.concat(chunks).toString();
  } catch (e) {
    return null; // blob doesn't exist yet
  }
}

// ─────────────────────────────────────────────────────────────
// INVENTORY — read/write with Azure Blob + local fallback
// ─────────────────────────────────────────────────────────────
async function readInventory() {
  const blob = await azureBlobDownload(CONFIG.INVENTORY_CONTAINER, 'inventory.json');
  if (blob) return JSON.parse(blob);
  return JSON.parse(fs.readFileSync(LOCAL_INVENTORY, 'utf8'));
}

async function writeInventory(data) {
  const str = JSON.stringify(data, null, 2);
  fs.writeFileSync(LOCAL_INVENTORY, str);
  await azureBlobUpload(CONFIG.INVENTORY_CONTAINER, 'inventory.json', str);
}

async function appendAuditHistory(deploymentId, action, actor, changes, result) {
  const inv = await readInventory();
  if (!inv.history) inv.history = [];
  inv.history.unshift({
    id: uuidv4(),
    deploymentId,
    action,   // provision | update | decommission
    actor: actor || 'system',
    changes,
    result,   // success | failure
    timestamp: new Date().toISOString()
  });
  await writeInventory(inv);
}

// ─────────────────────────────────────────────────────────────
// TERRAFORM EXECUTION
// ─────────────────────────────────────────────────────────────
function getTfBackendConfig(deploymentId) {
  return {
    resource_group_name:  CONFIG.TF_STATE_RG,
    storage_account_name: CONFIG.TF_STATE_STORAGE_ACCOUNT,
    container_name:       CONFIG.TF_STATE_CONTAINER,
    key:                  `${deploymentId}/terraform.tfstate`,
  };
}

async function runTerraform(deploymentId, workspaceDir, action, onLog) {
  // DEMO MODE: simulate Terraform steps
  if (CONFIG.DEMO_MODE) {
    return simulateTerraform(deploymentId, action, onLog);
  }

  const githubToken = process.env.GITHUB_TOKEN;
  const githubRepo  = process.env.GITHUB_REPO;

  if (!githubToken || !githubRepo) {
    throw new Error('GITHUB_TOKEN and GITHUB_REPO env vars are required');
  }

  // Upload terraform files to Azure Blob so GitHub Actions can download them
  onLog('→ Uploading Terraform workspace to Azure Blob...');
  const files = ['main.tf', 'variables.tf', 'outputs.tf'];
  for (const file of files) {
    const filePath = path.join(workspaceDir, file);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      await azureBlobUpload('deployments', `${deploymentId}/${file}`, content);
      onLog(`✓ Uploaded ${file}`);
    }
  }

  // Trigger GitHub Actions via repository_dispatch
  onLog('→ Triggering GitHub Actions workflow...');
  const https = require('https');
  const [owner, repo] = githubRepo.split('/');
  const body = JSON.stringify({
    event_type: `terraform-${action}`,
    client_payload: {
      action,
      deployment_id: deploymentId,
      resource_type: 'unknown',
      environment:   'prod',
      ticket_number: 'PORTAL',
    }
  });

  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/dispatches`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'TerraPortal/2.0',
        'Content-Length': Buffer.byteLength(body),
      }
    }, (res) => {
      if (res.statusCode === 204) {
        resolve();
      } else {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => reject(new Error(`GitHub API ${res.statusCode}: ${data}`)));
      }
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  onLog('✓ GitHub Actions triggered — Terraform running in CI');
  onLog('ℹ️  Check GitHub Actions tab for live progress');
  return {}
}

async function simulateTerraform(deploymentId, action, onLog) {
  const steps = action === 'provision'
    ? ['Initializing provider plugins...', 'Terraform initialized', 'Configuration valid', `Plan: 1 to add, 0 to change, 0 to destroy`, `Apply complete! Resources: 1 added, 0 changed, 0 destroyed.`]
    : action === 'update'
    ? ['Initializing provider plugins...', 'Terraform initialized', 'Configuration valid', `Plan: 0 to add, 2 to change, 0 to destroy`, `Apply complete! Resources: 0 added, 2 changed, 0 destroyed.`]
    : ['Initializing provider plugins...', 'Terraform initialized', `Plan: 0 to add, 0 to change, 1 to destroy`, `Destroy complete! Resources: 1 destroyed.`];

  for (const step of steps) {
    await delay(1200 + Math.random() * 1000);
    onLog(step);
  }
  return {};
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────
// TERRAFORM TEMPLATE GENERATION
// ─────────────────────────────────────────────────────────────
function buildBackendBlock(deploymentId) {
  if (CONFIG.DEMO_MODE) return '  # backend configured via -backend-config flags at init time';
  return `  backend "azurerm" {
    resource_group_name  = "${CONFIG.TF_STATE_RG}"
    storage_account_name = "${CONFIG.TF_STATE_STORAGE_ACCOUNT}"
    container_name       = "${CONFIG.TF_STATE_CONTAINER}"
    key                  = "${deploymentId}/terraform.tfstate"
  }`;
}

function buildProviderBlock() {
  return `terraform {
  required_version = ">= 1.6.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.80"
    }
  }
BACKEND_BLOCK
}

provider "azurerm" {
  features {
    resource_group { prevent_deletion_if_contains_resources = false }
    key_vault      { purge_soft_delete_on_destroy = true }
  }
}`;
}

function tagsBlock(tags, indent = '  ') {
  return Object.entries(tags).map(([k, v]) => `${indent}  ${k} = "${v}"`).join('\n');
}

function generateMainTf(resourceType, config, allTags, deploymentId, environment) {
  const backend  = buildBackendBlock(deploymentId);
  const provider = buildProviderBlock().replace('BACKEND_BLOCK', backend);
  const tags     = tagsBlock(allTags);
  const rg       = `rg-${config.name}-${environment}`;
  const loc      = config.location || 'East US';

  const resourceBlocks = {
    vm: `
resource "azurerm_resource_group" "rg" {
  name     = "${rg}"
  location = "${loc}"
  tags = {
${tags}
  }
}

resource "azurerm_virtual_network" "vnet" {
  name                = "vnet-${config.name}"
  address_space       = ["10.0.0.0/16"]
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  tags = {
${tags}
  }
}

resource "azurerm_subnet" "subnet" {
  name                 = "snet-${config.name}"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = ["10.0.1.0/24"]
}

resource "azurerm_network_interface" "nic" {
  name                = "nic-${config.name}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.subnet.id
    private_ip_address_allocation = "Dynamic"
  }
  tags = {
${tags}
  }
}

resource "azurerm_linux_virtual_machine" "vm" {
  name                = "${config.name}"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  size                = "${config.vmSize || 'Standard_B2s'}"
  admin_username      = "${config.adminUsername || 'azureuser'}"
  network_interface_ids = [azurerm_network_interface.nic.id]
  disable_password_authentication = true

  admin_ssh_key {
    username   = "${config.adminUsername || 'azureuser'}"
    public_key = var.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "${config.diskType || 'Standard_LRS'}"
    disk_size_gb         = ${config.osDiskSizeGb || 30}
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-focal"
    sku       = "20_04-lts"
    version   = "latest"
  }

  tags = {
${tags}
  }
}`,

    storage: `
resource "azurerm_resource_group" "rg" {
  name     = "${rg}"
  location = "${loc}"
  tags = {
${tags}
  }
}

resource "azurerm_storage_account" "storage" {
  name                     = "${config.name.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,24)}"
  resource_group_name      = azurerm_resource_group.rg.name
  location                 = azurerm_resource_group.rg.location
  account_tier             = "${config.tier || 'Standard'}"
  account_replication_type = "${config.replication || 'LRS'}"
  enable_https_traffic_only = true
  min_tls_version          = "TLS1_2"

  blob_properties {
    versioning_enabled  = ${config.versioning === 'true' ? 'true' : 'false'}
    delete_retention_policy {
      days = ${config.retentionDays || 7}
    }
  }

  tags = {
${tags}
  }
}`,

    aks: `
resource "azurerm_resource_group" "rg" {
  name     = "${rg}"
  location = "${loc}"
  tags = {
${tags}
  }
}

resource "azurerm_kubernetes_cluster" "aks" {
  name                = "${config.name}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  dns_prefix          = "${config.name}"
  kubernetes_version  = "${config.k8sVersion || '1.28'}"

  default_node_pool {
    name                = "default"
    node_count          = ${config.nodeCount || 2}
    vm_size             = "${config.vmSize || 'Standard_D2_v2'}"
    os_disk_size_gb     = 50
    enable_auto_scaling = ${config.autoScaling === 'true' ? 'true' : 'false'}
    min_count           = ${config.autoScaling === 'true' ? (config.minNodes || 1) : 'null'}
    max_count           = ${config.autoScaling === 'true' ? (config.maxNodes || 5) : 'null'}
  }

  identity { type = "SystemAssigned" }

  network_profile {
    network_plugin = "azure"
    load_balancer_sku = "standard"
  }

  tags = {
${tags}
  }
}`,

    sql: `
resource "azurerm_resource_group" "rg" {
  name     = "${rg}"
  location = "${loc}"
  tags = {
${tags}
  }
}

resource "azurerm_mssql_server" "sql" {
  name                         = "${config.name}-server"
  resource_group_name          = azurerm_resource_group.rg.name
  location                     = azurerm_resource_group.rg.location
  version                      = "12.0"
  administrator_login          = "${config.adminLogin || 'sqladmin'}"
  administrator_login_password = var.sql_admin_password
  minimum_tls_version          = "1.2"
  tags = {
${tags}
  }
}

resource "azurerm_mssql_database" "db" {
  name         = "${config.name}"
  server_id    = azurerm_mssql_server.sql.id
  collation    = "SQL_Latin1_General_CP1_CI_AS"
  sku_name     = "${config.sku || 'Basic'}"
  max_size_gb  = ${config.maxSizeGb || 2}
  tags = {
${tags}
  }
}

resource "azurerm_mssql_firewall_rule" "allow_azure" {
  name             = "AllowAzureServices"
  server_id        = azurerm_mssql_server.sql.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}`,

    keyvault: `
data "azurerm_client_config" "current" {}

resource "azurerm_resource_group" "rg" {
  name     = "${rg}"
  location = "${loc}"
  tags = {
${tags}
  }
}

resource "azurerm_key_vault" "kv" {
  name                        = "${config.name}"
  location                    = azurerm_resource_group.rg.location
  resource_group_name         = azurerm_resource_group.rg.name
  tenant_id                   = data.azurerm_client_config.current.tenant_id
  sku_name                    = "${config.sku || 'standard'}"
  soft_delete_retention_days  = ${config.softDeleteRetention || 7}
  purge_protection_enabled    = ${config.purgeProtection === 'true' ? 'true' : 'false'}
  enable_rbac_authorization   = true

  network_acls {
    default_action = "${config.networkDefaultAction || 'Allow'}"
    bypass         = "AzureServices"
  }

  tags = {
${tags}
  }
}`,

    vnet: `
resource "azurerm_resource_group" "rg" {
  name     = "${rg}"
  location = "${loc}"
  tags = {
${tags}
  }
}

resource "azurerm_virtual_network" "vnet" {
  name                = "${config.name}"
  address_space       = ["${config.addressSpace || '10.0.0.0/16'}"]
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  dns_servers         = ${config.dnsServers ? JSON.stringify(config.dnsServers.split(',').map(s=>s.trim())) : '[]'}
  tags = {
${tags}
  }
}

resource "azurerm_subnet" "subnets" {
  for_each             = { for s in var.subnets : s.name => s }
  name                 = each.value.name
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = [each.value.prefix]
}

resource "azurerm_network_security_group" "nsg" {
  name                = "nsg-${config.name}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  tags = {
${tags}
  }
}`,
  };

  const resourceBlock = resourceBlocks[resourceType] || resourceBlocks.vm;
  return `${provider}\n${resourceBlock}`;
}

function generateVariablesTf(resourceType) {
  const vars = {
    vm: `variable "ssh_public_key" {
  description = "SSH public key for VM admin access"
  type        = string
  sensitive   = true
  default     = "ssh-rsa PLACEHOLDER"
}`,
    sql: `variable "sql_admin_password" {
  description = "SQL Server administrator password"
  type        = string
  sensitive   = true
  default     = "P@ssw0rd123!ChangeMe"
}`,
    vnet: `variable "subnets" {
  type = list(object({ name = string, prefix = string }))
  default = [
    { name = "snet-app",  prefix = "10.0.1.0/24" },
    { name = "snet-data", prefix = "10.0.2.0/24" },
  ]
}`,
    default: `# No extra variables required`,
  };
  return vars[resourceType] || vars.default;
}

function generateOutputsTf(resourceType) {
  const outs = {
    vm:       `output "vm_id"         { value = azurerm_linux_virtual_machine.vm.id }\noutput "private_ip"   { value = azurerm_network_interface.nic.private_ip_address }`,
    storage:  `output "storage_id"   { value = azurerm_storage_account.storage.id }\noutput "blob_endpoint" { value = azurerm_storage_account.storage.primary_blob_endpoint }`,
    aks:      `output "cluster_id"   { value = azurerm_kubernetes_cluster.aks.id }\noutput "kube_config"  { value = azurerm_kubernetes_cluster.aks.kube_config_raw\n  sensitive = true }`,
    sql:      `output "server_fqdn"  { value = azurerm_mssql_server.sql.fully_qualified_domain_name }\noutput "db_id"        { value = azurerm_mssql_database.db.id }`,
    keyvault: `output "vault_uri"    { value = azurerm_key_vault.kv.vault_uri }\noutput "vault_id"     { value = azurerm_key_vault.kv.id }`,
    vnet:     `output "vnet_id"      { value = azurerm_virtual_network.vnet.id }\noutput "address_space" { value = azurerm_virtual_network.vnet.address_space }`,
  };
  return outs[resourceType] || '# No outputs defined';
}

// ─────────────────────────────────────────────────────────────
// BACKGROUND JOB RUNNER
// ─────────────────────────────────────────────────────────────
async function runDeploymentJob(deploymentId, workspaceDir, action, changes) {
  const logs = [];
  const onLog = (line) => {
    const entry = `[${new Date().toISOString()}] ${line}`;
    logs.push(entry);
    // Flush to inventory every few lines
    if (logs.length % 3 === 0) flushLogs(deploymentId, logs);
  };

  try {
    onLog(`→ Action: ${action.toUpperCase()}`);
    const outputs = await runTerraform(deploymentId, workspaceDir, action, onLog);

    const inv = await readInventory();
    const resource = inv.resources.find(r => r.id === deploymentId);
    if (resource) {
      if (action === 'provision') {
        resource.status = 'deployed';
        resource.outputs = outputs;
      } else if (action === 'update') {
        resource.status = 'deployed';
        resource.outputs = outputs;
        resource.lastUpdatedAt = new Date().toISOString();
      } else if (action === 'decommission') {
        resource.status = 'decommissioned';
        resource.decommissionedAt = new Date().toISOString();
      }
      resource.logs = [...(resource.logs || []), ...logs];
      resource.updatedAt = new Date().toISOString();
      await writeInventory(inv);
    }
    await appendAuditHistory(deploymentId, action, 'system', changes, 'success');
    onLog(`✓ ${action} complete`);
  } catch (err) {
    const inv = await readInventory();
    const resource = inv.resources.find(r => r.id === deploymentId);
    if (resource) {
      resource.status = action === 'provision' ? 'failed' : 'update-failed';
      resource.logs = [...(resource.logs || []), ...logs, `[${new Date().toISOString()}] ✗ Error: ${err.message}`];
      resource.updatedAt = new Date().toISOString();
      await writeInventory(inv);
    }
    await appendAuditHistory(deploymentId, action, 'system', changes, 'failure');
  }
}

async function flushLogs(deploymentId, logs) {
  try {
    const inv = await readInventory();
    const resource = inv.resources.find(r => r.id === deploymentId);
    if (resource) {
      resource.logs = logs;
      await writeInventory(inv);
    }
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────────────────────

// GET all inventory
app.get('/api/inventory', async (req, res) => {
  try { res.json(await readInventory()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET single resource
app.get('/api/inventory/:id', async (req, res) => {
  try {
    const inv = await readInventory();
    const resource = inv.resources.find(r => r.id === req.params.id);
    if (!resource) return res.status(404).json({ error: 'Not found' });
    res.json(resource);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET audit history
app.get('/api/history', async (req, res) => {
  try {
    const inv = await readInventory();
    res.json({ history: inv.history || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET resource types
app.get('/api/resource-types', (req, res) => res.json(RESOURCE_TYPES));

// GET terraform preview for a config
app.post('/api/preview', async (req, res) => {
  const { resourceType, config, ticketNumber, environment, tags, deploymentId } = req.body;
  const allTags = buildTags(ticketNumber, environment, deploymentId || 'preview', tags);
  const tf = generateMainTf(resourceType, config || {}, allTags, deploymentId || 'preview', environment || 'dev');
  res.json({ terraform: tf });
});

// ─────────────────────────────────────────────────────────────
// PROVISION — create new resource
// ─────────────────────────────────────────────────────────────
app.post('/api/provision', async (req, res) => {
  const { resourceType, config, ticketNumber, environment, tags, requestedBy } = req.body;
  if (!resourceType || !config || !ticketNumber)
    return res.status(400).json({ error: 'resourceType, config, and ticketNumber are required' });

  const deploymentId = uuidv4();
  const timestamp = new Date().toISOString();
  const allTags = buildTags(ticketNumber, environment, deploymentId, tags);

  // Write Terraform files
  const workspaceDir = path.join(CONFIG.DEPLOYMENTS_DIR, deploymentId);
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'main.tf'),      generateMainTf(resourceType, config, allTags, deploymentId, environment || 'dev'));
  fs.writeFileSync(path.join(workspaceDir, 'variables.tf'), generateVariablesTf(resourceType));
  fs.writeFileSync(path.join(workspaceDir, 'outputs.tf'),   generateOutputsTf(resourceType));

  const inventoryEntry = {
    id: deploymentId,
    ticketNumber,
    resourceType,
    resourceName: config.name,
    environment:  environment || 'dev',
    config,
    tags: allTags,
    status: 'provisioning',
    requestedBy: requestedBy || 'unknown',
    createdAt: timestamp,
    updatedAt: timestamp,
    lastUpdatedAt: null,
    decommissionedAt: null,
    workspaceDir,
    outputs: {},
    logs: [],
    changeHistory: [{
      action: 'provision',
      timestamp,
      actor: requestedBy || 'unknown',
      ticket: ticketNumber,
      changes: config,
    }],
  };

  const inv = await readInventory();
  inv.resources.push(inventoryEntry);
  await writeInventory(inv);

  res.json({ deploymentId, status: 'provisioning', message: 'Provisioning started' });

  // Run async
  runDeploymentJob(deploymentId, workspaceDir, 'provision', config);
});

// ─────────────────────────────────────────────────────────────
// UPDATE — modify existing resource (terraform apply with new config)
// ─────────────────────────────────────────────────────────────
app.patch('/api/resources/:id', async (req, res) => {
  const { config, ticketNumber, tags, requestedBy } = req.body;
  const inv = await readInventory();
  const resource = inv.resources.find(r => r.id === req.params.id);
  if (!resource) return res.status(404).json({ error: 'Resource not found' });
  if (!['deployed'].includes(resource.status))
    return res.status(400).json({ error: `Cannot update resource in status: ${resource.status}` });

  // Compute diff
  const oldConfig = resource.config;
  const newConfig = { ...oldConfig, ...config };
  const diff = {};
  for (const [k, v] of Object.entries(newConfig)) {
    if (oldConfig[k] !== v) diff[k] = { from: oldConfig[k], to: v };
  }

  if (Object.keys(diff).length === 0)
    return res.status(400).json({ error: 'No changes detected' });

  // Update inventory entry
  resource.config = newConfig;
  resource.tags = buildTags(ticketNumber || resource.ticketNumber, resource.environment, resource.id, { ...(resource.tags || {}), ...tags });
  resource.status = 'updating';
  resource.updatedAt = new Date().toISOString();
  if (!resource.changeHistory) resource.changeHistory = [];
  resource.changeHistory.push({
    action: 'update',
    timestamp: new Date().toISOString(),
    actor: requestedBy || 'unknown',
    ticket: ticketNumber || resource.ticketNumber,
    diff,
  });
  await writeInventory(inv);

  // Regenerate Terraform files
  const allTags = resource.tags;
  const workspaceDir = resource.workspaceDir || path.join(CONFIG.DEPLOYMENTS_DIR, resource.id);
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'main.tf'),      generateMainTf(resource.resourceType, newConfig, allTags, resource.id, resource.environment));
  fs.writeFileSync(path.join(workspaceDir, 'variables.tf'), generateVariablesTf(resource.resourceType));
  fs.writeFileSync(path.join(workspaceDir, 'outputs.tf'),   generateOutputsTf(resource.resourceType));

  res.json({ id: resource.id, status: 'updating', diff, message: 'Update started' });

  runDeploymentJob(resource.id, workspaceDir, 'update', diff);
});

// ─────────────────────────────────────────────────────────────
// DECOMMISSION — terraform destroy + mark in inventory
// ─────────────────────────────────────────────────────────────
app.delete('/api/resources/:id', async (req, res) => {
  const { ticketNumber, requestedBy, reason } = req.body;
  const inv = await readInventory();
  const resource = inv.resources.find(r => r.id === req.params.id);
  if (!resource) return res.status(404).json({ error: 'Resource not found' });
  if (['decommissioning', 'decommissioned'].includes(resource.status))
    return res.status(400).json({ error: `Already ${resource.status}` });

  resource.status = 'decommissioning';
  resource.updatedAt = new Date().toISOString();
  if (!resource.changeHistory) resource.changeHistory = [];
  resource.changeHistory.push({
    action: 'decommission',
    timestamp: new Date().toISOString(),
    actor: requestedBy || 'unknown',
    ticket: ticketNumber || resource.ticketNumber,
    reason: reason || 'Manual decommission',
  });
  await writeInventory(inv);

  res.json({ id: resource.id, status: 'decommissioning', message: 'Decommission started' });

  runDeploymentJob(resource.id, resource.workspaceDir || path.join(CONFIG.DEPLOYMENTS_DIR, resource.id), 'decommission', { reason });
});

// GET status + logs for polling
app.get('/api/resources/:id/status', async (req, res) => {
  try {
    const inv = await readInventory();
    const resource = inv.resources.find(r => r.id === req.params.id);
    if (!resource) return res.status(404).json({ error: 'Not found' });
    res.json({ status: resource.status, logs: resource.logs || [], updatedAt: resource.updatedAt, outputs: resource.outputs || {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET diff preview before update (plan only)
app.post('/api/resources/:id/plan', async (req, res) => {
  const { config } = req.body;
  const inv = await readInventory();
  const resource = inv.resources.find(r => r.id === req.params.id);
  if (!resource) return res.status(404).json({ error: 'Not found' });

  const oldConfig = resource.config;
  const newConfig = { ...oldConfig, ...config };
  const diff = {};
  for (const [k, v] of Object.entries(newConfig)) {
    if (oldConfig[k] !== v) diff[k] = { from: oldConfig[k] ?? '(not set)', to: v };
  }
  res.json({ diff, oldConfig, newConfig });
});

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function buildTags(ticketNumber, environment, deploymentId, extraTags) {
  return {
    ticket:        ticketNumber,
    environment:   environment || 'dev',
    managed_by:    'terraform-portal',
    deployment_id: deploymentId,
    created_at:    new Date().toISOString(),
    ...(extraTags || {}),
  };
}

// ─────────────────────────────────────────────────────────────
// RESOURCE TYPE DEFINITIONS
// ─────────────────────────────────────────────────────────────
const RESOURCE_TYPES = {
  vm: {
    label: 'Virtual Machine', icon: '🖥️',
    updatableFields: ['vmSize', 'diskType', 'osDiskSizeGb'],
    fields: [
      { name: 'name',          label: 'VM Name',        type: 'text',   required: true,  placeholder: 'my-vm-prod-01', immutable: true },
      { name: 'location',      label: 'Azure Region',   type: 'select', required: true,  options: AZURE_REGIONS, immutable: true },
      { name: 'vmSize',        label: 'VM Size',        type: 'select', options: ['Standard_B1s','Standard_B2s','Standard_D2s_v3','Standard_D4s_v3','Standard_E4s_v3','Standard_F4s_v2'] },
      { name: 'adminUsername', label: 'Admin Username', type: 'text',   placeholder: 'azureuser', immutable: true },
      { name: 'diskType',      label: 'OS Disk Type',   type: 'select', options: ['Standard_LRS','Premium_LRS','StandardSSD_LRS'] },
      { name: 'osDiskSizeGb',  label: 'OS Disk Size GB',type: 'number', placeholder: '30' },
    ],
  },
  storage: {
    label: 'Storage Account', icon: '🗄️',
    updatableFields: ['tier', 'replication', 'versioning', 'retentionDays'],
    fields: [
      { name: 'name',          label: 'Account Name',  type: 'text',   required: true, placeholder: 'mystorageaccount', immutable: true },
      { name: 'location',      label: 'Azure Region',  type: 'select', required: true, options: AZURE_REGIONS, immutable: true },
      { name: 'tier',          label: 'Tier',          type: 'select', options: ['Standard','Premium'] },
      { name: 'replication',   label: 'Replication',   type: 'select', options: ['LRS','GRS','ZRS','RAGRS','GZRS'] },
      { name: 'versioning',    label: 'Versioning',    type: 'select', options: ['true','false'] },
      { name: 'retentionDays', label: 'Retention Days',type: 'number', placeholder: '7' },
    ],
  },
  aks: {
    label: 'AKS Cluster', icon: '☸️',
    updatableFields: ['nodeCount', 'vmSize', 'k8sVersion', 'minNodes', 'maxNodes'],
    fields: [
      { name: 'name',        label: 'Cluster Name', type: 'text',   required: true, placeholder: 'my-aks-cluster', immutable: true },
      { name: 'location',    label: 'Azure Region', type: 'select', required: true, options: AZURE_REGIONS, immutable: true },
      { name: 'nodeCount',   label: 'Node Count',   type: 'number', placeholder: '2' },
      { name: 'vmSize',      label: 'Node VM Size', type: 'select', options: ['Standard_D2_v2','Standard_D4_v2','Standard_D8_v2','Standard_DS3_v2'] },
      { name: 'k8sVersion',  label: 'K8s Version',  type: 'select', options: ['1.28','1.27','1.26'] },
      { name: 'autoScaling', label: 'Auto Scaling', type: 'select', options: ['false','true'] },
      { name: 'minNodes',    label: 'Min Nodes',    type: 'number', placeholder: '1' },
      { name: 'maxNodes',    label: 'Max Nodes',    type: 'number', placeholder: '5' },
    ],
  },
  sql: {
    label: 'SQL Database', icon: '🗃️',
    updatableFields: ['sku', 'maxSizeGb'],
    fields: [
      { name: 'name',       label: 'DB Name',     type: 'text',   required: true, placeholder: 'mydb', immutable: true },
      { name: 'location',   label: 'Region',      type: 'select', required: true, options: AZURE_REGIONS, immutable: true },
      { name: 'adminLogin', label: 'Admin Login', type: 'text',   placeholder: 'sqladmin', immutable: true },
      { name: 'sku',        label: 'SKU',         type: 'select', options: ['Basic','S0','S1','S2','P1','P2'] },
      { name: 'maxSizeGb',  label: 'Max Size GB', type: 'number', placeholder: '2' },
    ],
  },
  keyvault: {
    label: 'Key Vault', icon: '🔐',
    updatableFields: ['softDeleteRetention', 'purgeProtection', 'networkDefaultAction'],
    fields: [
      { name: 'name',                 label: 'Vault Name',       type: 'text',   required: true, placeholder: 'my-keyvault', immutable: true },
      { name: 'location',             label: 'Region',           type: 'select', required: true, options: AZURE_REGIONS, immutable: true },
      { name: 'sku',                  label: 'SKU',              type: 'select', options: ['standard','premium'] },
      { name: 'softDeleteRetention',  label: 'Soft Delete Days', type: 'number', placeholder: '7' },
      { name: 'purgeProtection',      label: 'Purge Protection', type: 'select', options: ['false','true'] },
      { name: 'networkDefaultAction', label: 'Network Default',  type: 'select', options: ['Allow','Deny'] },
    ],
  },
  vnet: {
    label: 'Virtual Network', icon: '🌐',
    updatableFields: ['dnsServers'],
    fields: [
      { name: 'name',         label: 'VNet Name',     type: 'text',   required: true, placeholder: 'my-vnet', immutable: true },
      { name: 'location',     label: 'Region',        type: 'select', required: true, options: AZURE_REGIONS, immutable: true },
      { name: 'addressSpace', label: 'Address Space', type: 'text',   placeholder: '10.0.0.0/16', immutable: true },
      { name: 'dnsServers',   label: 'DNS Servers',   type: 'text',   placeholder: '168.63.129.16, 8.8.8.8' },
    ],
  },
};


app.listen(CONFIG.PORT, () => {
  console.log(`TerraPortal API running on port ${CONFIG.PORT}`);
  console.log(`Demo mode: ${CONFIG.DEMO_MODE}`);
  console.log(`State backend: Azure Blob (${CONFIG.TF_STATE_STORAGE_ACCOUNT}/${CONFIG.TF_STATE_CONTAINER})`);
});
