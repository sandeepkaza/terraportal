terraform {
  required_version = ">= 1.7.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.90"
    }
  }
  backend "azurerm" {}
}

provider "azurerm" {
  features {
    resource_group { prevent_deletion_if_contains_resources = false }
  }
}

variable "environment"  { default = "prod" }
variable "location"     { default = "East US" }
variable "frontend_image"   { description = "Frontend container image URI" }
variable "backend_image"    { description = "Backend container image URI" }
variable "tf_state_rg"      { description = "Resource group holding Terraform state storage" }
variable "tf_state_storage" { description = "Storage account name for Terraform state" }
variable "storage_connection_string" {
  description = "Azure Storage connection string for inventory + state"
  sensitive   = true
}

locals {
  name_prefix = "terraportal-${var.environment}"
  tags = {
    managed_by  = "terraform-portal"
    environment = var.environment
    project     = "terraportal"
    repo        = "terraportal"
  }
}

resource "azurerm_resource_group" "portal" {
  name     = "rg-${local.name_prefix}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_log_analytics_workspace" "portal" {
  name                = "law-${local.name_prefix}"
  location            = azurerm_resource_group.portal.location
  resource_group_name = azurerm_resource_group.portal.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.tags
}

resource "azurerm_container_app_environment" "portal" {
  name                       = "cae-${local.name_prefix}"
  location                   = azurerm_resource_group.portal.location
  resource_group_name        = azurerm_resource_group.portal.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.portal.id
  tags                       = local.tags
}

resource "azurerm_container_app" "backend" {
  name                         = "ca-${local.name_prefix}-backend"
  container_app_environment_id = azurerm_container_app_environment.portal.id
  resource_group_name          = azurerm_resource_group.portal.name
  revision_mode                = "Single"
  tags                         = local.tags

  secret {
    name  = "storage-conn"
    value = var.storage_connection_string
  }

  template {
    min_replicas = 1
    max_replicas = 3

    container {
      name   = "backend"
      image  = var.backend_image
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "PORT"
        value = "3001"
      }
      env {
        name  = "NODE_ENV"
        value = var.environment
      }
      env {
        name  = "DEMO_MODE"
        value = "false"
      }
      env {
        name  = "TF_STATE_STORAGE_ACCOUNT"
        value = var.tf_state_storage
      }
      env {
        name  = "TF_STATE_RG"
        value = var.tf_state_rg
      }
      env {
        name  = "TF_STATE_CONTAINER"
        value = "tfstate"
      }
      env {
        name  = "INVENTORY_CONTAINER"
        value = "inventory"
      }
      env {
        name        = "AZURE_STORAGE_CONNECTION_STRING"
        secret_name = "storage-conn"
      }
    }

    http_scale_rule {
      name                = "http-scaling"
      concurrent_requests = "50"
    }
  }

  ingress {
    allow_insecure_connections = false
    external_enabled           = true
    target_port                = 3001
    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }
}

resource "azurerm_container_app" "frontend" {
  name                         = "ca-${local.name_prefix}-frontend"
  container_app_environment_id = azurerm_container_app_environment.portal.id
  resource_group_name          = azurerm_resource_group.portal.name
  revision_mode                = "Single"
  tags                         = local.tags

  template {
    min_replicas = 1
    max_replicas = 5

    container {
      name   = "frontend"
      image  = var.frontend_image
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "VITE_API_URL"
        value = "https://${azurerm_container_app.backend.latest_revision_fqdn}"
      }
    }
  }

  ingress {
    allow_insecure_connections = false
    external_enabled           = true
    target_port                = 80
    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }
}

output "frontend_url" {
  value       = "https://${azurerm_container_app.frontend.latest_revision_fqdn}"
  description = "TerraPortal UI URL"
}

output "backend_url" {
  value       = "https://${azurerm_container_app.backend.latest_revision_fqdn}"
  description = "TerraPortal API URL"
}
