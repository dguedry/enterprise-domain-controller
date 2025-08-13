/*
 * This file is part of Cockpit.
 *
 * Copyright (C) 2024 Red Hat, Inc.
 *
 * Cockpit is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or
 * (at your option) any later version.
 *
 * Cockpit is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Cockpit; If not, see <http://www.gnu.org/licenses/>.
 */

// Import modules
import { UIManager } from './modules/ui-manager.js';
import { NetworkManager } from './modules/network-manager.js';
import { ServiceManager } from './modules/service-manager.js';
import { DomainManager } from './modules/domain-manager.js';
import { FSMOManager } from './modules/fsmo-manager.js';
import { SysvolManager } from './modules/sysvol-manager.js';

const _ = cockpit.gettext;

class DomainController {
    constructor() {
        this.isDomainJoined = false;
        this.domainInfo = null;
        this.container = null;
        this.loadingOverlay = null;
        this.networkInterfaces = [];

        // Track loading states for initial page load
        this.loadingStates = {
            networkInterfaces: false,
            domainStatus: false,
            hostname: false,
            sysvolManager: false
        };

        // Initialize modules
        this.uiManager = new UIManager();
        this.networkManager = new NetworkManager(this.uiManager);
        this.serviceManager = new ServiceManager(this.uiManager);
        this.domainManager = new DomainManager(this.uiManager);
        this.fsmoManager = new FSMOManager(this.uiManager, this.serviceManager);
        this.sysvolManager = new SysvolManager(this.uiManager);
    }

    async init() {
        this.container = document.getElementById('domain-controller');
        this.render();

        // Show loading spinner until all initial data is ready
        this.showInitialLoading();

        // Setup theme listener immediately (doesn't require loading)
        this.setupThemeListener();

        // Load all initial data asynchronously
        try {
            await Promise.all([
                this.loadNetworkInterfacesAsync(),
                this.checkDomainStatusAsync(),
                this.loadCurrentHostnameAsync(),
                this.initializeSysvolManagerAsync()
            ]);
        } catch (error) {
            console.error('Failed to load initial data:', error);
        } finally {
            // Hide loading spinner once all data is loaded
            this.hideInitialLoading();

        }
    }

    render() {
        this.container.innerHTML = `
            <div class="domain-controller-header">
                <h1>${_("Domain Controller Management")}</h1>
            </div>

            <div class="pf-v5-c-card domain-status-card">
                <div class="pf-v5-c-card__header">
                    <div class="pf-v5-c-card__header-main">
                        <h2 class="pf-v5-c-card__title">${_("Domain Status")}</h2>
                    </div>
                    <div class="pf-v5-c-card__actions">
                        <span id="status-badge" class="pf-v5-c-badge pf-m-read domain-status-badge">
                            ${_("Checking...")}
                        </span>
                    </div>
                </div>
                <div class="pf-v5-c-card__body">
                    <div id="status-display">
                        <div id="domain-details" class="domain-details hidden">
                            <div class="pf-v5-l-grid pf-m-all-6-col-on-md pf-m-all-4-col-on-lg pf-m-all-3-col-on-xl">
                                <div class="pf-v5-l-grid__item">
                                    <div class="domain-detail-item">
                                        <div class="domain-detail-label">${_("Domain")}</div>
                                        <div class="domain-detail-value" id="domain-name"></div>
                                    </div>
                                </div>
                                <div class="pf-v5-l-grid__item">
                                    <div class="domain-detail-item">
                                        <div class="domain-detail-label">${_("Role")}</div>
                                        <div class="domain-detail-value" id="domain-role"></div>
                                    </div>
                                </div>
                                <div class="pf-v5-l-grid__item">
                                    <div class="domain-detail-item">
                                        <div class="domain-detail-label">${_("Site")}</div>
                                        <div class="domain-detail-value" id="domain-site"></div>
                                    </div>
                                </div>
                                <div class="pf-v5-l-grid__item">
                                    <div class="domain-detail-item">
                                        <div class="domain-detail-label">${_("Forest")}</div>
                                        <div class="domain-detail-value" id="domain-forest"></div>
                                    </div>
                                </div>

                                <div class="domain-actions-row">
                                    <div class="network-info-section">
                                        <div class="network-header">
                                            <h5>${_("Network Configuration")}</h5>
                                        </div>
                                        <div class="network-details">
                                            <div class="network-item">
                                                <div class="network-label">${_("Interface")}</div>
                                                <div id="network-interface" class="network-value">${_("Loading...")}</div>
                                            </div>
                                            <div class="network-item">
                                                <div class="network-label">${_("IP Address")}</div>
                                                <div id="network-ip" class="network-value">${_("Loading...")}</div>
                                            </div>
                                            <div class="network-item">
                                                <div class="network-label">${_("MAC Address")}</div>
                                                <div id="network-mac" class="network-value">${_("Loading...")}</div>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <div class="service-status-section">
                                    <div class="service-header">
                                        <h5>${_("Service Status")}</h5>
                                    </div>
                                    <div class="services-grid">
                                        <div class="service-item">
                                            <div class="service-info">
                                                <div class="service-name">
                                                    <i class="fas fa-server"></i>
                                                    ${_("Samba AD-DC")}
                                                </div>
                                            </div>
                                            <div class="service-status-container">
                                                <div id="samba-status" class="service-status-text">${_("Checking...")}</div>
                                                <div class="service-actions">
                                                    <button id="restart-samba" class="pf-v5-c-button pf-m-secondary pf-m-small service-restart-btn" type="button" title="${_("Restart samba-ad-dc service")}">
                                                        <i class="fas fa-redo" aria-hidden="true"></i>
                                                        ${_("Restart")}
                                                    </button>
                                                </div>
                                            </div>
                                        </div>

                                        <div class="service-item">
                                            <div class="service-info">
                                                <div class="service-name">
                                                    <i class="fas fa-clock"></i>
                                                    ${_("NTP (Chrony)")}
                                                </div>
                                            </div>
                                            <div class="service-status-container">
                                                <div id="ntp-service-status" class="service-status-text">${_("Checking...")}</div>
                                                <div class="service-actions">
                                                    <button id="restart-ntp" class="pf-v5-c-button pf-m-secondary pf-m-small" type="button" title="${_("Restart chrony service")}">
                                                        <i class="fas fa-redo" aria-hidden="true"></i>
                                                        ${_("Restart")}
                                                    </button>
                                                    <button id="manage-ntp" class="pf-v5-c-button pf-m-primary pf-m-small" type="button" title="${_("Manage NTP hierarchy")}">
                                                        <i class="fas fa-cog" aria-hidden="true"></i>
                                                        ${_("Configure")}
                                                    </button>
                                                </div>
                                            </div>
                                        </div>

                                        <div class="service-item">
                                            <div class="service-info">
                                                <div class="service-name">
                                                    <i class="fas fa-network-wired"></i>
                                                    ${_("DHCP Server")}
                                                    <span id="dhcp-fsmo-indicator" class="fsmo-indicator hidden" title="${_("DHCP active on PDC Emulator")}">
                                                        <i class="fas fa-crown"></i>
                                                    </span>
                                                </div>
                                                <div id="dhcp-fsmo-status" class="dhcp-fsmo-status-text"></div>
                                            </div>
                                            <div class="service-status-container">
                                                <div id="dhcp-status" class="service-status-text">${_("Checking...")}</div>
                                                <div class="service-actions">
                                                    <button id="restart-dhcp" class="pf-v5-c-button pf-m-secondary pf-m-small" type="button" title="${_("Restart isc-dhcp-server service")}">
                                                        <i class="fas fa-redo" aria-hidden="true"></i>
                                                        ${_("Restart")}
                                                    </button>
                                                    <button id="manage-dhcp" class="pf-v5-c-button pf-m-primary pf-m-small" type="button" title="${_("Manage DHCP configuration")}">
                                                        <i class="fas fa-cog" aria-hidden="true"></i>
                                                        ${_("Configure")}
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <div class="ntp-management-section hidden" id="ntp-management">
                                    <div class="ntp-header">
                                        <h5>${_("NTP Configuration")}
                                            <button id="ntp-help-btn" class="pf-v5-c-button pf-m-link pf-m-inline" type="button"
                                                    title="${_("PDC Emulator syncs with external NTP servers (Stratum 10). Other DCs sync with PDC (Stratum 11). Domain clients sync with any DC. Configuration updates automatically when PDC role changes.")}">
                                                <i class="fas fa-question-circle" aria-hidden="true"></i>
                                            </button>
                                        </h5>
                                        <div class="ntp-actions">
                                            <button id="edit-ntp-config" class="pf-v5-c-button pf-m-primary pf-m-small" type="button">
                                                <i class="fas fa-edit" aria-hidden="true"></i>
                                                ${_("Configure")}
                                            </button>
                                            <button id="sync-ntp-config" class="pf-v5-c-button pf-m-secondary pf-m-small" type="button">
                                                <i class="fas fa-sync" aria-hidden="true"></i>
                                                ${_("Sync")}
                                            </button>
                                            <button id="close-ntp-management" class="pf-v5-c-button pf-m-plain pf-m-small" type="button" aria-label="Close">
                                                <i class="pf-v5-pficon pf-v5-pficon-close" aria-hidden="true"></i>
                                            </button>
                                        </div>
                                    </div>

                                    <div class="service-summary-card">
                                        <div class="summary-item">
                                            <span class="summary-label">${_("Role")}</span>
                                            <span class="summary-value" id="ntp-role-status">${_("Checking...")}</span>
                                        </div>
                                        <div class="summary-item">
                                            <span class="summary-label">${_("Stratum")}</span>
                                            <span class="summary-value" id="ntp-stratum">${_("...")}</span>
                                        </div>
                                        <div class="summary-item">
                                            <span class="summary-label">${_("Status")}</span>
                                            <span class="summary-value" id="ntp-sync-status">${_("Checking...")}</span>
                                        </div>
                                    </div>
                                </div>

                                <div class="dhcp-management-section hidden" id="dhcp-management">
                                    <div class="dhcp-header">
                                        <h5>${_("DHCP Configuration")}
                                            <button id="dhcp-help-btn" class="pf-v5-c-button pf-m-link pf-m-inline" type="button"
                                                    title="${_("Only the PDC Emulator runs DHCP service. Configuration is stored in SYSVOL for replication. DHCP automatically fails over if PDC role transfers.")}">
                                                <i class="fas fa-question-circle" aria-hidden="true"></i>
                                            </button>
                                        </h5>
                                        <div class="dhcp-actions">
                                            <button id="edit-dhcp-config" class="pf-v5-c-button pf-m-primary pf-m-small" type="button">
                                                <i class="fas fa-edit" aria-hidden="true"></i>
                                                ${_("Configure")}
                                            </button>
                                            <button id="sync-dhcp-config" class="pf-v5-c-button pf-m-secondary pf-m-small" type="button">
                                                <i class="fas fa-sync" aria-hidden="true"></i>
                                                ${_("Sync")}
                                            </button>
                                            <button id="close-dhcp-management" class="pf-v5-c-button pf-m-plain pf-m-small" type="button" aria-label="Close">
                                                <i class="pf-v5-pficon pf-v5-pficon-close" aria-hidden="true"></i>
                                            </button>
                                        </div>
                                    </div>

                                    <div class="service-summary-card">
                                        <div class="summary-item">
                                            <span class="summary-label">${_("Failover Status")}</span>
                                            <span class="summary-value" id="dhcp-failover-status">${_("Checking...")}</span>
                                        </div>
                                        <div class="summary-item">
                                            <span class="summary-label">${_("Active Server")}</span>
                                            <span class="summary-value" id="dhcp-active-server">${_("...")}</span>
                                        </div>
                                        <div class="summary-item">
                                            <span class="summary-label">${_("Sync Status")}</span>
                                            <span class="summary-value" id="dhcp-sync-status">${_("Checking...")}</span>
                                        </div>
                                    </div>
                                </div>

                                <div class="pf-v5-l-grid__item pf-m-12-col-on-md pf-m-8-col-on-lg pf-m-6-col-on-xl">
                                    <div class="fsmo-roles-section">
                                        <div class="fsmo-header">
                                            <h5>${_("FSMO Roles")}</h5>
                                            <button id="refresh-fsmo" class="pf-v5-c-button pf-m-secondary pf-m-small" type="button" title="${_("Refresh FSMO role information")}">
                                                <i class="fas fa-sync" aria-hidden="true"></i>
                                                ${_("Refresh")}
                                            </button>
                                            <button id="force-replication" class="pf-v5-c-button pf-m-warning pf-m-small" type="button" title="${_("Force domain replication to resolve FSMO inconsistencies")}">
                                                <i class="fas fa-exchange-alt" aria-hidden="true"></i>
                                                ${_("Sync Replication")}
                                            </button>
                                        </div>
                                        <div class="fsmo-explanation">
                                            <p>${_("FSMO (Flexible Single Master Operation) roles are specialized functions assigned to specific domain controllers. These roles ensure certain operations have only one authoritative source to prevent conflicts.")}</p>
                                        </div>
                                        <div id="fsmo-roles-display" class="fsmo-roles-grid">
                                            <div class="fsmo-role-card">
                                                <div class="fsmo-role-header">
                                                    <i class="fas fa-clock"></i>
                                                    <h6>${_("PDC Emulator")}</h6>
                                                </div>
                                                <div class="fsmo-role-holder" id="pdc-holder">${_("Loading...")}</div>
                                                <div class="fsmo-role-description">${_("Handles time synchronization, password changes, and acts as the primary domain controller for legacy systems.")}</div>
                                                <div class="fsmo-role-actions">
                                                    <button id="transfer-pdc" class="pf-v5-c-button pf-m-secondary pf-m-small fsmo-transfer-btn" type="button" title="${_("Transfer PDC Emulator role to this server")}">
                                                        <i class="fas fa-exchange-alt"></i> ${_("Transfer Here")}
                                                    </button>
                                                    <button id="seize-pdc" class="pf-v5-c-button pf-m-danger pf-m-small fsmo-seize-btn" type="button" title="${_("Seize PDC Emulator role (emergency only)")}">
                                                        <i class="fas fa-exclamation-triangle"></i> ${_("Seize")}
                                                    </button>
                                                </div>
                                            </div>

                                            <div class="fsmo-role-card">
                                                <div class="fsmo-role-header">
                                                    <i class="fas fa-key"></i>
                                                    <h6>${_("RID Master")}</h6>
                                                </div>
                                                <div class="fsmo-role-holder" id="rid-holder">${_("Loading...")}</div>
                                                <div class="fsmo-role-description">${_("Allocates unique RID (Relative Identifier) pools to domain controllers for creating security principals.")}</div>
                                                <div class="fsmo-role-actions">
                                                    <button id="transfer-rid" class="pf-v5-c-button pf-m-secondary pf-m-small fsmo-transfer-btn" type="button" title="${_("Transfer RID Master role to this server")}">
                                                        <i class="fas fa-exchange-alt"></i> ${_("Transfer Here")}
                                                    </button>
                                                    <button id="seize-rid" class="pf-v5-c-button pf-m-danger pf-m-small fsmo-seize-btn" type="button" title="${_("Seize RID Master role (emergency only)")}">
                                                        <i class="fas fa-exclamation-triangle"></i> ${_("Seize")}
                                                    </button>
                                                </div>
                                            </div>

                                            <div class="fsmo-role-card">
                                                <div class="fsmo-role-header">
                                                    <i class="fas fa-database"></i>
                                                    <h6>${_("Infrastructure Master")}</h6>
                                                </div>
                                                <div class="fsmo-role-holder" id="infrastructure-holder">${_("Loading...")}</div>
                                                <div class="fsmo-role-description">${_("Maintains references to objects in other domains and updates group-to-user references.")}</div>
                                                <div class="fsmo-role-actions">
                                                    <button id="transfer-infrastructure" class="pf-v5-c-button pf-m-secondary pf-m-small fsmo-transfer-btn" type="button" title="${_("Transfer Infrastructure Master role to this server")}">
                                                        <i class="fas fa-exchange-alt"></i> ${_("Transfer Here")}
                                                    </button>
                                                    <button id="seize-infrastructure" class="pf-v5-c-button pf-m-danger pf-m-small fsmo-seize-btn" type="button" title="${_("Seize Infrastructure Master role (emergency only)")}">
                                                        <i class="fas fa-exclamation-triangle"></i> ${_("Seize")}
                                                    </button>
                                                </div>
                                            </div>

                                            <div class="fsmo-role-card">
                                                <div class="fsmo-role-header">
                                                    <i class="fas fa-sitemap"></i>
                                                    <h6>${_("Schema Master")}</h6>
                                                </div>
                                                <div class="fsmo-role-holder" id="schema-holder">${_("Loading...")}</div>
                                                <div class="fsmo-role-description">${_("Controls modifications to the Active Directory schema (forest-wide role).")}</div>
                                                <div class="fsmo-role-actions">
                                                    <button id="transfer-schema" class="pf-v5-c-button pf-m-secondary pf-m-small fsmo-transfer-btn" type="button" title="${_("Transfer Schema Master role to this server")}">
                                                        <i class="fas fa-exchange-alt"></i> ${_("Transfer Here")}
                                                    </button>
                                                    <button id="seize-schema" class="pf-v5-c-button pf-m-danger pf-m-small fsmo-seize-btn" type="button" title="${_("Seize Schema Master role (emergency only)")}">
                                                        <i class="fas fa-exclamation-triangle"></i> ${_("Seize")}
                                                    </button>
                                                </div>
                                            </div>

                                            <div class="fsmo-role-card">
                                                <div class="fsmo-role-header">
                                                    <i class="fas fa-users"></i>
                                                    <h6>${_("Domain Naming Master")}</h6>
                                                </div>
                                                <div class="fsmo-role-holder" id="domain-naming-holder">${_("Loading...")}</div>
                                                <div class="fsmo-role-description">${_("Controls addition and removal of domains in the forest (forest-wide role).")}</div>
                                                <div class="fsmo-role-actions">
                                                    <button id="transfer-domain-naming" class="pf-v5-c-button pf-m-secondary pf-m-small fsmo-transfer-btn" type="button" title="${_("Transfer Domain Naming Master role to this server")}">
                                                        <i class="fas fa-exchange-alt"></i> ${_("Transfer Here")}
                                                    </button>
                                                    <button id="seize-domain-naming" class="pf-v5-c-button pf-m-danger pf-m-small fsmo-seize-btn" type="button" title="${_("Seize Domain Naming Master role (emergency only)")}">
                                                        <i class="fas fa-exclamation-triangle"></i> ${_("Seize")}
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div id="no-domain-message" class="domain-no-connection">
                            <div class="pf-v5-c-empty-state pf-m-sm">
                                <div class="pf-v5-c-empty-state__content">
                                    <div class="pf-v5-c-empty-state__icon">
                                        <i class="fas fa-server" aria-hidden="true"></i>
                                    </div>
                                    <h2 class="pf-v5-c-title pf-m-lg">${_("No Domain Connection")}</h2>
                                    <div class="pf-v5-c-empty-state__body">
                                        ${_("This server is not currently joined to a domain. Use the options below to provision a new domain or join an existing one.")}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="pf-v5-c-card domain-statistics hidden">
                <div class="pf-v5-c-card__header">
                    <h2 class="pf-v5-c-card__title">${_("Domain Statistics")}</h2>
                </div>
                <div class="pf-v5-c-card__body">
                    <div class="stat-grid">
                        <div class="stat-item">
                            <span class="stat-number" id="user-count">0</span>
                            <p class="stat-label">${_("Total Users")}</p>
                        </div>
                        <div class="stat-item">
                            <span class="stat-number" id="computer-count">0</span>
                            <p class="stat-label">${_("Computers")}</p>
                        </div>
                        <div class="stat-item">
                            <span class="stat-number" id="group-count">0</span>
                            <p class="stat-label">${_("Groups")}</p>
                        </div>
                        <div class="stat-item">
                            <span class="stat-number" id="ou-count">0</span>
                            <p class="stat-label">${_("Organizational Units")}</p>
                        </div>
                    </div>
                </div>
            </div>

            <div class="pf-v5-c-card domain-actions-card">
                <div class="pf-v5-c-card__header">
                    <h2 class="pf-v5-c-card__title">${_("Domain Actions")}</h2>
                </div>
                <div class="pf-v5-c-card__body">
                    <div id="provision-section" class="domain-section">
                        <h4>${_("Provision New Domain")}</h4>

                        <!-- Basic Configuration -->
                        <div class="pf-v5-c-form">
                            <div class="pf-v5-c-form__group">
                                <label class="pf-v5-c-form__label" for="domain-name-input">
                                    <span class="pf-v5-c-form__label-text">${_("Domain Name")} *</span>
                                </label>
                                <input type="text" id="domain-name-input" class="pf-v5-c-form-control"
                                       placeholder="example.com" required>
                                <div class="pf-v5-c-form__helper-text">
                                    <div class="pf-v5-c-helper-text">
                                        <div class="pf-v5-c-helper-text__item">
                                            <span class="pf-v5-c-helper-text__item-text">Full domain name (FQDN)</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div class="pf-v5-c-form__group">
                                <label class="pf-v5-c-form__label" for="provision-hostname">
                                    <span class="pf-v5-c-form__label-text">${_("Server Hostname")} *</span>
                                </label>
                                <input type="text" id="provision-hostname" class="pf-v5-c-form-control"
                                       placeholder="dc1.example.com" required>
                                <div class="pf-v5-c-form__helper-text">
                                    <div class="pf-v5-c-helper-text">
                                        <div class="pf-v5-c-helper-text__item">
                                            <span class="pf-v5-c-helper-text__item-text">Fully qualified hostname for this domain controller</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div class="pf-v5-c-form__group">
                                <label class="pf-v5-c-form__label" for="netbios-name">
                                    <span class="pf-v5-c-form__label-text">${_("NetBIOS Domain Name")}</span>
                                </label>
                                <input type="text" id="netbios-name" class="pf-v5-c-form-control"
                                       placeholder="EXAMPLE" maxlength="15">
                                <div class="pf-v5-c-form__helper-text">
                                    <div class="pf-v5-c-helper-text">
                                        <div class="pf-v5-c-helper-text__item">
                                            <span class="pf-v5-c-helper-text__item-text">Leave empty to auto-generate from domain name</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div class="pf-v5-c-form__group">
                                <label class="pf-v5-c-form__label" for="admin-user">
                                    <span class="pf-v5-c-form__label-text">${_("Administrator Username")}</span>
                                </label>
                                <input type="text" id="admin-user" class="pf-v5-c-form-control"
                                       value="Administrator" placeholder="Administrator">
                                <div class="pf-v5-c-form__helper-text">
                                    <div class="pf-v5-c-helper-text">
                                        <div class="pf-v5-c-helper-text__item">
                                            <span class="pf-v5-c-helper-text__item-text">Name for domain administrator account</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div class="pf-v5-c-form__group">
                                <label class="pf-v5-c-form__label" for="admin-password">
                                    <span class="pf-v5-c-form__label-text">${_("Administrator Password")} *</span>
                                </label>
                                <input type="password" id="admin-password" class="pf-v5-c-form-control" required>
                                <div class="pf-v5-c-form__helper-text">
                                    <div class="pf-v5-c-helper-text">
                                        <div class="pf-v5-c-helper-text__item">
                                            <span class="pf-v5-c-helper-text__item-text">Password for domain administrator account</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div class="pf-v5-c-form__group">
                                <label class="pf-v5-c-form__label" for="provision-interface">
                                    <span class="pf-v5-c-form__label-text">${_("Network Interface")} *</span>
                                </label>
                                <select id="provision-interface" class="pf-v5-c-form-control" required>
                                    <option value="">${_("Loading interfaces...")}</option>
                                </select>
                            </div>

                            <div class="pf-v5-c-form__group">
                                <label class="pf-v5-c-form__label" for="dns-forwarder">
                                    <span class="pf-v5-c-form__label-text">${_("DNS Forwarder")}</span>
                                </label>
                                <input type="text" id="dns-forwarder" class="pf-v5-c-form-control"
                                       placeholder="8.8.8.8">
                                <div class="pf-v5-c-form__helper-text">
                                    <div class="pf-v5-c-helper-text">
                                        <div class="pf-v5-c-helper-text__item">
                                            <span class="pf-v5-c-helper-text__item-text">DNS server for external queries</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div class="pf-v5-c-form__group">
                                <label class="pf-v5-c-form__label" for="site-name">
                                    <span class="pf-v5-c-form__label-text">${_("Site Name")}</span>
                                </label>
                                <input type="text" id="site-name" class="pf-v5-c-form-control"
                                       placeholder="Default-First-Site-Name">
                            </div>
                        </div>

                        <!-- Advanced Options Accordion -->
                        <div class="pf-v5-c-accordion" id="provision-advanced-accordion">
                            <div class="pf-v5-c-accordion__item">
                                <h3 class="pf-v5-c-accordion__toggle">
                                    <button class="pf-v5-c-accordion__toggle-button"
                                            id="provision-advanced-toggle"
                                            aria-expanded="false"
                                            aria-controls="provision-advanced-content">
                                        <span class="pf-v5-c-accordion__toggle-icon">
                                            <i class="fas fa-angle-right" aria-hidden="true"></i>
                                        </span>
                                        <span class="pf-v5-c-accordion__toggle-text">${_("Advanced Options")}</span>
                                    </button>
                                </h3>
                                <div class="pf-v5-c-accordion__expandable-content"
                                     id="provision-advanced-content"
                                     hidden>
                                    <div class="pf-v5-c-accordion__expandable-content-body">
                                        <div class="pf-v5-c-form">
                                            <div class="pf-v5-c-form__group">
                                                <label class="pf-v5-c-form__label" for="dns-backend">
                                                    <span class="pf-v5-c-form__label-text">${_("DNS Backend")}</span>
                                                </label>
                                                <select id="dns-backend" class="pf-v5-c-form-control">
                                                    <option value="SAMBA_INTERNAL">${_("Samba Internal DNS")}</option>
                                                    <option value="BIND9_FLATFILE">${_("BIND9 with flat files")}</option>
                                                    <option value="BIND9_DLZ">${_("BIND9 with DLZ")}</option>
                                                    <option value="NONE">${_("No DNS backend")}</option>
                                                </select>
                                                <div class="pf-v5-c-form__helper-text">
                                                    <div class="pf-v5-c-helper-text">
                                                        <div class="pf-v5-c-helper-text__item">
                                                            <span class="pf-v5-c-helper-text__item-text">DNS implementation for domain controller</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            <div class="pf-v5-c-form__group">
                                                <label class="pf-v5-c-form__label" for="forest-level">
                                                    <span class="pf-v5-c-form__label-text">${_("Forest Functional Level")}</span>
                                                </label>
                                                <select id="forest-level" class="pf-v5-c-form-control">
                                                    <option value="2000">2000</option>
                                                    <option value="2003">2003</option>
                                                    <option value="2008">2008</option>
                                                    <option value="2008_R2" selected>2008 R2</option>
                                                </select>
                                                <div class="pf-v5-c-form__helper-text">
                                                    <div class="pf-v5-c-helper-text">
                                                        <div class="pf-v5-c-helper-text__item">
                                                            <span class="pf-v5-c-helper-text__item-text">Sets minimum Windows version compatibility</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            <div class="pf-v5-c-form__group">
                                                <div class="pf-v5-c-check">
                                                    <input class="pf-v5-c-check__input" type="checkbox" id="use-rfc2307" checked>
                                                    <label class="pf-v5-c-check__label" for="use-rfc2307">
                                                        ${_("Use RFC2307 (Unix attributes)")}
                                                    </label>
                                                </div>
                                                <div class="pf-v5-c-form__helper-text">
                                                    <div class="pf-v5-c-helper-text">
                                                        <div class="pf-v5-c-helper-text__item">
                                                            <span class="pf-v5-c-helper-text__item-text">Enable Unix user and group attributes</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            <div class="pf-v5-c-form__group">
                                                <div class="pf-v5-c-check">
                                                    <input class="pf-v5-c-check__input" type="checkbox" id="use-xattrs">
                                                    <label class="pf-v5-c-check__label" for="use-xattrs">
                                                        ${_("Use extended attributes (xattrs)")}
                                                    </label>
                                                </div>
                                                <div class="pf-v5-c-form__helper-text">
                                                    <div class="pf-v5-c-helper-text">
                                                        <div class="pf-v5-c-helper-text__item">
                                                            <span class="pf-v5-c-helper-text__item-text">Store AD metadata in filesystem extended attributes</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            <div class="pf-v5-c-form__group">
                                                <label class="pf-v5-c-form__label" for="ntp-servers">
                                                    <span class="pf-v5-c-form__label-text">${_("NTP Servers")}</span>
                                                </label>
                                                <input type="text" id="ntp-servers" class="pf-v5-c-form-control"
                                                       value="time.cloudflare.com,time.google.com,pool.ntp.org,time.nist.gov"
                                                       placeholder="server1,server2,server3">
                                                <div class="pf-v5-c-form__helper-text">
                                                    <div class="pf-v5-c-helper-text">
                                                        <div class="pf-v5-c-helper-text__item">
                                                            <span class="pf-v5-c-helper-text__item-text">Comma-separated list of NTP servers for time synchronization</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            <hr class="pf-v5-c-divider">

                                            <h6 class="advanced-section-header">${_("DHCP Configuration")}</h6>

                                            <div class="pf-v5-c-form__group">
                                                <div class="pf-v5-c-check">
                                                    <input class="pf-v5-c-check__input" type="checkbox" id="enable-dhcp" checked>
                                                    <label class="pf-v5-c-check__label" for="enable-dhcp">
                                                        ${_("Enable DHCP Server")}
                                                    </label>
                                                </div>
                                                <div class="pf-v5-c-form__helper-text">
                                                    <div class="pf-v5-c-helper-text">
                                                        <div class="pf-v5-c-helper-text__item">
                                                            <span class="pf-v5-c-helper-text__item-text">Configure DHCP service on PDC Emulator with automatic failover</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            <div class="dhcp-config-options" id="dhcp-provision-options">
                                                <div class="pf-v5-c-form__group">
                                                    <label class="pf-v5-c-form__label" for="dhcp-range-start">
                                                        <span class="pf-v5-c-form__label-text">${_("DHCP Range Start")}</span>
                                                    </label>
                                                    <input type="text" id="dhcp-provision-range-start" class="pf-v5-c-form-control"
                                                           placeholder="192.168.1.100">
                                                    <div class="pf-v5-c-form__helper-text">
                                                        <div class="pf-v5-c-helper-text">
                                                            <div class="pf-v5-c-helper-text__item">
                                                                <span class="pf-v5-c-helper-text__item-text">Starting IP address for DHCP range (auto-detected if empty)</span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>

                                                <div class="pf-v5-c-form__group">
                                                    <label class="pf-v5-c-form__label" for="dhcp-provision-range-end">
                                                        <span class="pf-v5-c-form__label-text">${_("DHCP Range End")}</span>
                                                    </label>
                                                    <input type="text" id="dhcp-provision-range-end" class="pf-v5-c-form-control"
                                                           placeholder="192.168.1.200">
                                                    <div class="pf-v5-c-form__helper-text">
                                                        <div class="pf-v5-c-helper-text">
                                                            <div class="pf-v5-c-helper-text__item">
                                                                <span class="pf-v5-c-helper-text__item-text">Ending IP address for DHCP range (auto-detected if empty)</span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>

                                                <div class="pf-v5-c-form__group">
                                                    <label class="pf-v5-c-form__label" for="dhcp-provision-lease-time">
                                                        <span class="pf-v5-c-form__label-text">${_("Lease Time (seconds)")}</span>
                                                    </label>
                                                    <input type="number" id="dhcp-provision-lease-time" class="pf-v5-c-form-control"
                                                           value="600" min="60" max="86400">
                                                    <div class="pf-v5-c-form__helper-text">
                                                        <div class="pf-v5-c-helper-text">
                                                            <div class="pf-v5-c-helper-text__item">
                                                                <span class="pf-v5-c-helper-text__item-text">Default lease time for DHCP clients (600 seconds = 10 minutes)</span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="pf-v5-c-form__group pf-m-action">
                            <button id="provision-btn" class="pf-v5-c-button pf-m-primary" type="button">
                                ${_("Provision Domain")}
                            </button>
                        </div>
                    </div>

                    <div id="join-section" class="domain-section">
                        <h4>${_("Join Existing Domain")}</h4>

                        <!-- Basic Configuration -->
                        <div class="pf-v5-c-form">
                            <div class="pf-v5-c-form__group">
                                <label class="pf-v5-c-form__label" for="existing-domain">
                                    <span class="pf-v5-c-form__label-text">${_("Domain to Join")} *</span>
                                </label>
                                <input type="text" id="existing-domain" class="pf-v5-c-form-control"
                                       placeholder="example.com" required>
                                <div class="pf-v5-c-form__helper-text">
                                    <div class="pf-v5-c-helper-text">
                                        <div class="pf-v5-c-helper-text__item">
                                            <span class="pf-v5-c-helper-text__item-text">Full domain name to join</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div class="pf-v5-c-form__group">
                                <label class="pf-v5-c-form__label" for="join-hostname">
                                    <span class="pf-v5-c-form__label-text">${_("Server Hostname")} *</span>
                                </label>
                                <input type="text" id="join-hostname" class="pf-v5-c-form-control"
                                       placeholder="dc2.example.com" required>
                                <div class="pf-v5-c-form__helper-text">
                                    <div class="pf-v5-c-helper-text">
                                        <div class="pf-v5-c-helper-text__item">
                                            <span class="pf-v5-c-helper-text__item-text">Fully qualified hostname for this domain controller</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div class="pf-v5-c-form__group">
                                <label class="pf-v5-c-form__label" for="domain-controller-ip">
                                    <span class="pf-v5-c-form__label-text">${_("Domain Controller IP")} *</span>
                                </label>
                                <input type="text" id="domain-controller-ip" class="pf-v5-c-form-control"
                                       placeholder="192.168.1.100" required>
                                <div class="pf-v5-c-form__helper-text">
                                    <div class="pf-v5-c-helper-text">
                                        <div class="pf-v5-c-helper-text__item">
                                            <span class="pf-v5-c-helper-text__item-text">IP address of existing domain controller</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div class="pf-v5-c-form__group">
                                <label class="pf-v5-c-form__label" for="domain-user">
                                    <span class="pf-v5-c-form__label-text">${_("Domain Administrator")} *</span>
                                </label>
                                <input type="text" id="domain-user" class="pf-v5-c-form-control"
                                       placeholder="administrator" required>
                                <div class="pf-v5-c-form__helper-text">
                                    <div class="pf-v5-c-helper-text">
                                        <div class="pf-v5-c-helper-text__item">
                                            <span class="pf-v5-c-helper-text__item-text">Username with domain admin privileges</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div class="pf-v5-c-form__group">
                                <label class="pf-v5-c-form__label" for="domain-password">
                                    <span class="pf-v5-c-form__label-text">${_("Password")} *</span>
                                </label>
                                <input type="password" id="domain-password" class="pf-v5-c-form-control" required>
                            </div>

                            <div class="pf-v5-c-form__group">
                                <label class="pf-v5-c-form__label" for="join-interface">
                                    <span class="pf-v5-c-form__label-text">${_("Network Interface")} *</span>
                                </label>
                                <select id="join-interface" class="pf-v5-c-form-control" required>
                                    <option value="">${_("Loading interfaces...")}</option>
                                </select>
                            </div>

                            <div class="pf-v5-c-form__group">
                                <label class="pf-v5-c-form__label" for="join-site-name">
                                    <span class="pf-v5-c-form__label-text">${_("Site Name")}</span>
                                </label>
                                <input type="text" id="join-site-name" class="pf-v5-c-form-control"
                                       placeholder="Default-First-Site-Name">
                                <div class="pf-v5-c-form__helper-text">
                                    <div class="pf-v5-c-helper-text">
                                        <div class="pf-v5-c-helper-text__item">
                                            <span class="pf-v5-c-helper-text__item-text">Active Directory site name</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Advanced Options Accordion -->
                        <div class="pf-v5-c-accordion" id="join-advanced-accordion">
                            <div class="pf-v5-c-accordion__item">
                                <h3 class="pf-v5-c-accordion__toggle">
                                    <button class="pf-v5-c-accordion__toggle-button"
                                            id="join-advanced-toggle"
                                            aria-expanded="false"
                                            aria-controls="join-advanced-content">
                                        <span class="pf-v5-c-accordion__toggle-icon">
                                            <i class="fas fa-angle-right" aria-hidden="true"></i>
                                        </span>
                                        <span class="pf-v5-c-accordion__toggle-text">${_("Advanced Options")}</span>
                                    </button>
                                </h3>
                                <div class="pf-v5-c-accordion__expandable-content"
                                     id="join-advanced-content"
                                     hidden>
                                    <div class="pf-v5-c-accordion__expandable-content-body">
                                        <div class="pf-v5-c-form">
                                            <div class="pf-v5-c-form__group">
                                                <label class="pf-v5-c-form__label" for="join-dns-backend">
                                                    <span class="pf-v5-c-form__label-text">${_("DNS Backend")}</span>
                                                </label>
                                                <select id="join-dns-backend" class="pf-v5-c-form-control">
                                                    <option value="SAMBA_INTERNAL">${_("Samba Internal DNS")}</option>
                                                    <option value="BIND9_FLATFILE">${_("BIND9 with flat files")}</option>
                                                    <option value="BIND9_DLZ">${_("BIND9 with DLZ")}</option>
                                                    <option value="NONE">${_("No DNS backend")}</option>
                                                </select>
                                                <div class="pf-v5-c-form__helper-text">
                                                    <div class="pf-v5-c-helper-text">
                                                        <div class="pf-v5-c-helper-text__item">
                                                            <span class="pf-v5-c-helper-text__item-text">DNS implementation for additional domain controller</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            <div class="pf-v5-c-form__group">
                                                <label class="pf-v5-c-form__label" for="join-dns-forwarder">
                                                    <span class="pf-v5-c-form__label-text">${_("DNS Forwarder")}</span>
                                                </label>
                                                <input type="text" id="join-dns-forwarder" class="pf-v5-c-form-control"
                                                       placeholder="8.8.8.8">
                                                <div class="pf-v5-c-form__helper-text">
                                                    <div class="pf-v5-c-helper-text">
                                                        <div class="pf-v5-c-helper-text__item">
                                                            <span class="pf-v5-c-helper-text__item-text">DNS server for external queries</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>


                                            <div class="pf-v5-c-form__group">
                                                <div class="pf-v5-c-check">
                                                    <input class="pf-v5-c-check__input" type="checkbox" id="join-critical-only">
                                                    <label class="pf-v5-c-check__label" for="join-critical-only">
                                                        ${_("Replicate critical objects only")}
                                                    </label>
                                                </div>
                                                <div class="pf-v5-c-form__helper-text">
                                                    <div class="pf-v5-c-helper-text">
                                                        <div class="pf-v5-c-helper-text__item">
                                                            <span class="pf-v5-c-helper-text__item-text">Limit initial replication to essential objects</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="pf-v5-c-form__group pf-m-action">
                            <button id="join-btn" class="pf-v5-c-button pf-m-secondary" type="button">
                                ${_("Join Domain")}
                            </button>
                        </div>
                    </div>

                    <div id="leave-section" class="domain-section hidden">
                        <h4>${_("Leave Domain")}</h4>
                        <div class="pf-v5-c-alert pf-m-warning domain-warning">
                            <div class="pf-v5-c-alert__icon">
                                <i class="fas fa-exclamation-triangle" aria-hidden="true"></i>
                            </div>
                            <div class="pf-v5-c-alert__title">
                                ${_("This will remove the server from the domain and reset all domain configurations.")}
                            </div>
                        </div>
                        <div class="domain-button-group">
                            <button id="leave-btn" class="pf-v5-c-button pf-m-danger" type="button">
                                ${_("Leave Domain")}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <div id="loading-overlay" class="domain-loading-overlay hidden">
                <div class="domain-loading-content">
                    <div class="pf-v5-c-spinner pf-m-lg" role="progressbar" aria-valuetext="Loading...">
                        <span class="pf-v5-c-spinner__clipper"></span>
                        <span class="pf-v5-c-spinner__lead-ball"></span>
                        <span class="pf-v5-c-spinner__tail-ball"></span>
                    </div>
                    <p id="loading-message">${_("Loading domain controller data...")}</p>
                </div>
            </div>

            <!-- NTP Configuration Modal -->
            <div class="pf-v5-c-backdrop" id="ntp-config-modal" hidden>
                <div class="pf-v5-l-bullseye">
                    <div class="pf-v5-c-modal-box pf-m-md">
                        <header class="pf-v5-c-modal-box__header">
                            <h1 class="pf-v5-c-modal-box__title" id="ntp-modal-title">
                                ${_("NTP Configuration")}
                            </h1>
                        </header>
                        <div class="pf-v5-c-modal-box__body" id="ntp-modal-body">
                            <div class="pf-v5-c-form">
                                <div class="pf-v5-c-form__group">
                                    <label class="pf-v5-c-form__label" for="ntp-external-servers">
                                        <span class="pf-v5-c-form__label-text">${_("External NTP Servers (PDC Emulator)")}</span>
                                    </label>
                                    <textarea class="pf-v5-c-form-control" id="ntp-external-servers" rows="4" placeholder="pool.ntp.org
time.nist.gov
time.google.com
time.cloudflare.com"></textarea>
                                    <div class="pf-v5-c-form__helper-text">
                                        <div class="pf-v5-c-helper-text">
                                            <div class="pf-v5-c-helper-text__item">
                                                <span class="pf-v5-c-helper-text__item-text">${_("One server per line. Used by PDC Emulator only.")}</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                <div class="pf-v5-c-form__group">
                                    <label class="pf-v5-c-form__label" for="ntp-pdc-stratum">
                                        <span class="pf-v5-c-form__label-text">${_("PDC Emulator Stratum Level")}</span>
                                    </label>
                                    <input class="pf-v5-c-form-control" type="number" id="ntp-pdc-stratum" min="1" max="15" placeholder="10">
                                    <div class="pf-v5-c-form__helper-text">
                                        <div class="pf-v5-c-helper-text">
                                            <div class="pf-v5-c-helper-text__item">
                                                <span class="pf-v5-c-helper-text__item-text">${_("Stratum level for PDC Emulator (typically 10)")}</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                <div class="pf-v5-c-form__group">
                                    <label class="pf-v5-c-form__label" for="ntp-allow-clients">
                                        <span class="pf-v5-c-form__label-text">${_("Allow Client Access")}</span>
                                    </label>
                                    <input class="pf-v5-c-form-control" type="text" id="ntp-allow-clients" placeholder="192.168.1.0/24">
                                    <div class="pf-v5-c-form__helper-text">
                                        <div class="pf-v5-c-helper-text">
                                            <div class="pf-v5-c-helper-text__item">
                                                <span class="pf-v5-c-helper-text__item-text">${_("Network range allowed to query NTP (CIDR notation)")}</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <footer class="pf-v5-c-modal-box__footer">
                            <button id="save-ntp-config" class="pf-v5-c-button pf-m-primary" type="button">
                                <i class="fas fa-save" aria-hidden="true"></i>
                                ${_("Save & Deploy")}
                            </button>
                            <button id="cancel-ntp-edit" class="pf-v5-c-button pf-m-link" type="button">
                                ${_("Cancel")}
                            </button>
                        </footer>
                    </div>
                </div>
            </div>

            <!-- DHCP Configuration Modal -->
            <div class="pf-v5-c-backdrop" id="dhcp-config-modal" hidden>
                <div class="pf-v5-l-bullseye">
                    <div class="pf-v5-c-modal-box pf-m-lg">
                        <header class="pf-v5-c-modal-box__header">
                            <h1 class="pf-v5-c-modal-box__title" id="dhcp-modal-title">
                                ${_("DHCP Configuration")}
                            </h1>
                        </header>
                        <div class="pf-v5-c-modal-box__body" id="dhcp-modal-body">
                            <div class="pf-v5-c-form">
                                <div class="pf-v5-c-form__group">
                                    <label class="pf-v5-c-form__label" for="dhcp-domain-name">
                                        <span class="pf-v5-c-form__label-text">${_("Domain Name")}</span>
                                    </label>
                                    <input class="pf-v5-c-form-control" type="text" id="dhcp-domain-name" placeholder="example.com">
                                </div>
                                <div class="pf-v5-c-form__group">
                                    <label class="pf-v5-c-form__label" for="dhcp-dns-servers">
                                        <span class="pf-v5-c-form__label-text">${_("DNS Servers")}</span>
                                    </label>
                                    <input class="pf-v5-c-form-control" type="text" id="dhcp-dns-servers" placeholder="192.168.1.1, 8.8.8.8">
                                </div>
                                <div class="pf-v5-l-grid pf-m-all-6-col-on-md">
                                    <div class="pf-v5-l-grid__item">
                                        <div class="pf-v5-c-form__group">
                                            <label class="pf-v5-c-form__label" for="dhcp-subnet">
                                                <span class="pf-v5-c-form__label-text">${_("Subnet")}</span>
                                            </label>
                                            <input class="pf-v5-c-form-control" type="text" id="dhcp-subnet" placeholder="192.168.1.0">
                                        </div>
                                    </div>
                                    <div class="pf-v5-l-grid__item">
                                        <div class="pf-v5-c-form__group">
                                            <label class="pf-v5-c-form__label" for="dhcp-netmask">
                                                <span class="pf-v5-c-form__label-text">${_("Netmask")}</span>
                                            </label>
                                            <input class="pf-v5-c-form-control" type="text" id="dhcp-netmask" placeholder="255.255.255.0">
                                        </div>
                                    </div>
                                </div>
                                <div class="pf-v5-l-grid pf-m-all-6-col-on-md">
                                    <div class="pf-v5-l-grid__item">
                                        <div class="pf-v5-c-form__group">
                                            <label class="pf-v5-c-form__label" for="dhcp-range-start">
                                                <span class="pf-v5-c-form__label-text">${_("DHCP Range Start")}</span>
                                            </label>
                                            <input class="pf-v5-c-form-control" type="text" id="dhcp-range-start" placeholder="192.168.1.100">
                                        </div>
                                    </div>
                                    <div class="pf-v5-l-grid__item">
                                        <div class="pf-v5-c-form__group">
                                            <label class="pf-v5-c-form__label" for="dhcp-range-end">
                                                <span class="pf-v5-c-form__label-text">${_("DHCP Range End")}</span>
                                            </label>
                                            <input class="pf-v5-c-form-control" type="text" id="dhcp-range-end" placeholder="192.168.1.200">
                                        </div>
                                    </div>
                                </div>
                                <div class="pf-v5-c-form__group">
                                    <label class="pf-v5-c-form__label" for="dhcp-gateway">
                                        <span class="pf-v5-c-form__label-text">${_("Default Gateway")}</span>
                                    </label>
                                    <input class="pf-v5-c-form-control" type="text" id="dhcp-gateway" placeholder="192.168.1.1">
                                </div>
                                <div class="pf-v5-l-grid pf-m-all-6-col-on-md">
                                    <div class="pf-v5-l-grid__item">
                                        <div class="pf-v5-c-form__group">
                                            <label class="pf-v5-c-form__label" for="dhcp-lease-time">
                                                <span class="pf-v5-c-form__label-text">${_("Default Lease Time (seconds)")}</span>
                                            </label>
                                            <input class="pf-v5-c-form-control" type="number" id="dhcp-lease-time" placeholder="600">
                                        </div>
                                    </div>
                                    <div class="pf-v5-l-grid__item">
                                        <div class="pf-v5-c-form__group">
                                            <label class="pf-v5-c-form__label" for="dhcp-max-lease-time">
                                                <span class="pf-v5-c-form__label-text">${_("Max Lease Time (seconds)")}</span>
                                            </label>
                                            <input class="pf-v5-c-form-control" type="number" id="dhcp-max-lease-time" placeholder="7200">
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <footer class="pf-v5-c-modal-box__footer">
                            <button id="save-dhcp-config" class="pf-v5-c-button pf-m-primary" type="button">
                                <i class="fas fa-save" aria-hidden="true"></i>
                                ${_("Save & Deploy")}
                            </button>
                            <button id="cancel-dhcp-edit" class="pf-v5-c-button pf-m-link" type="button">
                                ${_("Cancel")}
                            </button>
                        </footer>
                    </div>
                </div>
            </div>

            <!-- Log Streaming Modal -->
            <div class="pf-v5-c-backdrop" id="log-streaming-modal" hidden>
                <div class="pf-v5-l-bullseye">
                    <div class="pf-v5-c-modal-box pf-m-lg" role="dialog" aria-modal="true" aria-labelledby="log-streaming-modal-title">
                        <header class="pf-v5-c-modal-box__header">
                            <h1 class="pf-v5-c-modal-box__title" id="log-streaming-modal-title">
                                ${_("Real-time Log Output")}
                            </h1>
                            <div class="pf-v5-c-modal-box__header-actions">
                                <button id="close-log-streaming-modal" class="pf-v5-c-button pf-m-plain" type="button" aria-label="Close">
                                    <i class="pf-v5-pficon pf-v5-pficon-close" aria-hidden="true"></i>
                                </button>
                            </div>
                        </header>
                        <div class="pf-v5-c-modal-box__body" id="log-streaming-modal-body">
                            <pre id="log-output" class="log-output-container"></pre>
                        </div>
                    </div>
                </div>
            </div>
        `;

        this.bindEvents();
    }

    bindEvents() {
        const provisionBtn = document.getElementById('provision-btn');
        const joinBtn = document.getElementById('join-btn');
        const leaveBtn = document.getElementById('leave-btn');

        // Expandable sections
        const provisionToggle = document.getElementById('provision-advanced-toggle');
        const joinToggle = document.getElementById('join-advanced-toggle');

        provisionBtn.addEventListener('click', () => this.provisionDomain());
        joinBtn.addEventListener('click', () => this.joinDomain());
        leaveBtn.addEventListener('click', () => this.leaveDomain());

        // NTP/FSMO management button (removed - now handled automatically)

        // FSMO refresh button
        const fsmoRefreshBtn = document.getElementById('refresh-fsmo');
        fsmoRefreshBtn.addEventListener('click', () => this.handleFSMORefresh());

        const forceReplicationBtn = document.getElementById('force-replication');
        forceReplicationBtn.addEventListener('click', () => this.forceDomainReplication());

        // Service restart buttons
        const sambaRestartBtn = document.getElementById('restart-samba');
        const ntpRestartBtn = document.getElementById('restart-ntp');
        const dhcpRestartBtn = document.getElementById('restart-dhcp');

        sambaRestartBtn.addEventListener('click', () => {
            // Determine which service to restart based on domain role
            const serviceName = this.domainInfo && this.domainInfo.role === 'Domain Member' ? 'winbind' : 'samba-ad-dc';
            this.handleServiceRestart(serviceName);
        });
        ntpRestartBtn.addEventListener('click', () => this.handleServiceRestart('chrony'));
        dhcpRestartBtn.addEventListener('click', () => this.handleServiceRestart('isc-dhcp-server'));

        // DHCP management buttons
        const manageDhcpBtn = document.getElementById('manage-dhcp');
        const closeDhcpBtn = document.getElementById('close-dhcp-management');
        const editDhcpBtn = document.getElementById('edit-dhcp-config');
        const saveDhcpBtn = document.getElementById('save-dhcp-config');
        const cancelDhcpBtn = document.getElementById('cancel-dhcp-edit');
        const syncDhcpBtn = document.getElementById('sync-dhcp-config');

        manageDhcpBtn.addEventListener('click', () => this.showDhcpManagement());
        closeDhcpBtn.addEventListener('click', () => this.hideDhcpManagement());
        editDhcpBtn.addEventListener('click', () => this.showDhcpEditor());
        saveDhcpBtn.addEventListener('click', () => this.saveDhcpConfig());
        cancelDhcpBtn.addEventListener('click', () => this.hideDhcpEditor());
        syncDhcpBtn.addEventListener('click', () => this.syncDhcpConfig());

        // NTP management buttons
        const manageNtpBtn = document.getElementById('manage-ntp');
        const closeNtpBtn = document.getElementById('close-ntp-management');
        const editNtpBtn = document.getElementById('edit-ntp-config');
        const saveNtpBtn = document.getElementById('save-ntp-config');
        const cancelNtpBtn = document.getElementById('cancel-ntp-edit');
        const syncNtpBtn = document.getElementById('sync-ntp-config');

        manageNtpBtn.addEventListener('click', () => this.showNtpManagement());
        closeNtpBtn.addEventListener('click', () => this.hideNtpManagement());
        editNtpBtn.addEventListener('click', () => this.showNtpEditor());
        saveNtpBtn.addEventListener('click', () => this.saveNtpConfig());
        cancelNtpBtn.addEventListener('click', () => this.hideNtpEditor());
        syncNtpBtn.addEventListener('click', () => this.syncNtpConfig());

        // Help button handlers (to blur focus after click for tooltip dismissal)
        const ntpHelpBtn = document.getElementById('ntp-help-btn');
        const dhcpHelpBtn = document.getElementById('dhcp-help-btn');

        if (ntpHelpBtn) ntpHelpBtn.addEventListener('click', (e) => e.target.blur());
        if (dhcpHelpBtn) dhcpHelpBtn.addEventListener('click', (e) => e.target.blur());

        // FSMO role transfer buttons
        const fsmoTransferButtons = [
            { id: 'transfer-pdc', role: 'pdc' },
            { id: 'transfer-rid', role: 'rid' },
            { id: 'transfer-infrastructure', role: 'infrastructure' },
            { id: 'transfer-schema', role: 'schema' },
            { id: 'transfer-domain-naming', role: 'domain-naming' }
        ];

        const fsmoSeizeButtons = [
            { id: 'seize-pdc', role: 'pdc' },
            { id: 'seize-rid', role: 'rid' },
            { id: 'seize-infrastructure', role: 'infrastructure' },
            { id: 'seize-schema', role: 'schema' },
            { id: 'seize-domain-naming', role: 'domain-naming' }
        ];

        fsmoTransferButtons.forEach(({ id, role }) => {
            const btn = document.getElementById(id);
            if (btn) {
                btn.addEventListener('click', () => this.fsmoManager.transferFSMORole(role));
            }
        });

        fsmoSeizeButtons.forEach(({ id, role }) => {
            const btn = document.getElementById(id);
            if (btn) {
                btn.addEventListener('click', () => this.fsmoManager.seizeFSMORole(role));
            }
        });

        // Handle expandable sections
        provisionToggle.addEventListener('click', () => this.toggleExpandableSection('provision-advanced'));
        joinToggle.addEventListener('click', () => this.toggleExpandableSection('join-advanced'));

        // Modal backdrop click handlers
        const ntpModal = document.getElementById('ntp-config-modal');
        const dhcpModal = document.getElementById('dhcp-config-modal');
        const logStreamingModal = document.getElementById('log-streaming-modal');

        ntpModal.addEventListener('click', (e) => {
            if (e.target === ntpModal) {
                this.hideNtpEditor();
            }
        });

        dhcpModal.addEventListener('click', (e) => {
            if (e.target === dhcpModal) {
                this.hideDhcpEditor();
            }
        });

        logStreamingModal.addEventListener('click', (e) => {
            if (e.target === logStreamingModal) {
                this.uiManager.hideLogModal();
            }
        });

        const closeLogStreamingModalBtn = document.getElementById('close-log-streaming-modal');
        if (closeLogStreamingModalBtn) {
            closeLogStreamingModalBtn.addEventListener('click', () => this.uiManager.hideLogModal());
        }

        // Auto-generate NetBIOS name from domain name
        const domainNameInput = document.getElementById('domain-name-input');
        const netbiosNameInput = document.getElementById('netbios-name');

        // Track if user has manually modified the NetBIOS field
        let netbiosManuallyEdited = false;

        netbiosNameInput.addEventListener('input', () => {
            netbiosManuallyEdited = true;
        });

        domainNameInput.addEventListener('input', () => {
            if (!netbiosManuallyEdited) {
                const domainName = domainNameInput.value.trim();
                if (domainName) {
                    const netbiosName = domainName.split('.')[0].toUpperCase().substring(0, 15);
                    netbiosNameInput.value = netbiosName;
                } else {
                    netbiosNameInput.value = '';
                }
            }
        });

        // Handle DHCP configuration checkbox
        const enableDhcpCheckbox = document.getElementById('enable-dhcp');
        const dhcpOptionsDiv = document.getElementById('dhcp-provision-options');

        enableDhcpCheckbox.addEventListener('change', () => {
            if (enableDhcpCheckbox.checked) {
                dhcpOptionsDiv.style.display = 'block';
            } else {
                dhcpOptionsDiv.style.display = 'none';
            }
        });
    }

    toggleExpandableSection(sectionId) {
        const toggle = document.getElementById(sectionId + '-toggle');
        const content = document.getElementById(sectionId + '-content');
        const icon = toggle.querySelector('.pf-v5-c-accordion__toggle-icon i');

        const isExpanded = toggle.getAttribute('aria-expanded') === 'true';

        if (isExpanded) {
            toggle.setAttribute('aria-expanded', 'false');
            content.hidden = true;
            icon.className = 'fas fa-angle-right';
        } else {
            toggle.setAttribute('aria-expanded', 'true');
            content.hidden = false;
            icon.className = 'fas fa-angle-down';
        }
    }

    loadNetworkInterfaces() {
        // For backward compatibility, call the async version
        this.loadNetworkInterfacesAsync().catch(error => {
            console.error('Failed to load network interfaces:', error);
        });
    }

    parseNetworkInterfaces(output) {
        const interfaces = [];
        const lines = output.split('\n');
        let currentInterface = null;

        for (const line of lines) {
            // Match interface line like "2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP>"
            const interfaceMatch = line.match(/^\d+:\s+(\w+):\s+<(.+)>/);
            if (interfaceMatch) {
                const [, name, flags] = interfaceMatch;
                if (name !== 'lo' && flags.includes('UP')) {
                    currentInterface = { name, ips: [], mac: null };
                    interfaces.push(currentInterface);
                }
            }

            // Match MAC address line like "    link/ether 08:00:27:c9:d8:89"
            if (currentInterface) {
                const macMatch = line.match(/^\s+link\/ether\s+([a-fA-F0-9:]{17})/);
                if (macMatch) {
                    currentInterface.mac = macMatch[1];
                }

                // Match IP address line like "    inet 192.168.1.100/24"
                const ipMatch = line.match(/^\s+inet\s+(\d+\.\d+\.\d+\.\d+)\/\d+/);
                if (ipMatch) {
                    currentInterface.ips.push(ipMatch[1]);
                }
            }
        }

        return interfaces;
    }

    populateInterfaceSelectors() {
        const provisionSelector = document.getElementById('provision-interface');
        const joinSelector = document.getElementById('join-interface');

        if (provisionSelector && joinSelector) {
            const options = this.networkInterfaces.map(iface =>
                `<option value="${iface.name}">${iface.name} (${iface.ips.join(', ')})</option>`
            ).join('');

            provisionSelector.innerHTML = options;
            joinSelector.innerHTML = options;
        }
    }

    displayNetworkInfo() {
        // Find the primary interface (first non-loopback UP interface with an IP)
        const primaryInterface = this.networkInterfaces.find(iface =>
            iface.ips.length > 0 && iface.name !== 'lo'
        ) || this.networkInterfaces[0];

        if (primaryInterface) {
            const interfaceElement = document.getElementById('network-interface');
            const ipElement = document.getElementById('network-ip');
            const macElement = document.getElementById('network-mac');

            if (interfaceElement) interfaceElement.textContent = primaryInterface.name;
            if (ipElement) ipElement.textContent = primaryInterface.ips[0] || 'Not configured';
            if (macElement) macElement.textContent = primaryInterface.mac || 'Not available';
        }
    }

    showLoading(message = null) {
        const overlay = document.getElementById('loading-overlay');
        overlay.classList.remove('hidden');

        if (message) {
            const messageElement = document.getElementById('loading-message');
            if (messageElement) {
                messageElement.textContent = message;
            }
        }
    }

    hideLoading() {
        const overlay = document.getElementById('loading-overlay');
        overlay.classList.add('hidden');

        // Reset message to default
        const messageElement = document.getElementById('loading-message');
        if (messageElement) {
            messageElement.textContent = _("Processing domain operation...");
        }
    }

    // Initial loading methods for page startup
    showInitialLoading() {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            overlay.classList.remove('hidden');
        }

        // Set initial loading message
        const messageElement = document.getElementById('loading-message');
        if (messageElement) {
            messageElement.textContent = _("Loading domain controller data...");
        }
    }

    hideInitialLoading() {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            overlay.classList.add('hidden');
        }

        // Reset message to default
        const messageElement = document.getElementById('loading-message');
        if (messageElement) {
            messageElement.textContent = _("Processing domain operation...");
        }
    }

    // Async wrapper methods for initial data loading
    async loadNetworkInterfacesAsync() {
        return new Promise((resolve, reject) => {
            cockpit.spawn(['ip', 'addr', 'show'], { superuser: "try" })
                .then(output => {
                    this.networkInterfaces = this.parseNetworkInterfaces(output);
                    this.populateInterfaceSelectors();
                    this.displayNetworkInfo();
                    this.loadingStates.networkInterfaces = true;
                    resolve();
                })
                .catch(error => {
                    console.error('Failed to load network interfaces:', error);
                    this.loadingStates.networkInterfaces = true; // Mark as complete even on error
                    resolve(); // Don't reject to avoid blocking other operations
                });
        });
    }

    async checkDomainStatusAsync() {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.log('Domain status check timed out after 10 seconds');
                this.updateDomainStatus(null);
                this.loadingStates.domainStatus = true;
                resolve();
            }, 10000);

            // Check if local domain exists first (Domain Controller check)
            cockpit.spawn(['samba-tool', 'domain', 'info', '127.0.0.1'], { superuser: "try" })
                .then(output => {
                    clearTimeout(timeout);
                    console.log('Domain info output:', output);

                    const lines = output.split('\n');
                    const domainLine = lines.find(line => line.trim().startsWith('Domain') && line.includes(':'));
                    const forestLine = lines.find(line => line.trim().startsWith('Forest') && line.includes(':'));

                    if (domainLine && forestLine) {
                        const domain = domainLine.split(':')[1].trim();
                        const forest = forestLine.split(':')[1].trim();

                        this.getDomainSiteInfo(domain).then(site => {
                            this.updateDomainStatus({
                                domain: domain,
                                role: 'Domain Controller',
                                site: site || 'Default-First-Site-Name',
                                forest: forest
                            });
                            this.loadingStates.domainStatus = true;
                            resolve();
                        }).catch(() => {
                            this.updateDomainStatus({
                                domain: domain,
                                role: 'Domain Controller',
                                site: 'Default-First-Site-Name',
                                forest: forest
                            });
                            this.loadingStates.domainStatus = true;
                            resolve();
                        });
                    } else {
                        this.checkSambaAdDcServiceAsync().then(() => {
                            this.loadingStates.domainStatus = true;
                            resolve();
                        });
                    }
                })
                .catch(error => {
                    clearTimeout(timeout);
                    console.log('Domain info command failed:', error);
                    this.checkSambaAdDcServiceAsync().then(() => {
                        this.loadingStates.domainStatus = true;
                        resolve();
                    });
                });
        });
    }

    async checkSambaAdDcServiceAsync() {
        return new Promise((resolve) => {
            cockpit.spawn(['systemctl', 'is-active', 'samba-ad-dc'], { superuser: "try" })
                .then(output => {
                    if (output.trim() === 'active') {
                        console.log('Samba AD-DC service is active, checking member status');
                        this.checkDomainMemberStatusAsync().then(resolve);
                    } else {
                        console.log('Samba AD-DC service is not active');
                        this.updateDomainStatus(null);
                        resolve();
                    }
                })
                .catch(error => {
                    console.log('systemctl check failed:', error);
                    this.checkDomainMemberStatusAsync().then(resolve);
                });
        });
    }

    async checkDomainMemberStatusAsync() {
        return new Promise((resolve) => {
            cockpit.spawn(['realm', 'list'], { superuser: "try" })
                .then(output => {
                    console.log('Realm list output:', output);
                    const realmMatch = output.match(/realm-name:\s*(\S+)/);
                    if (realmMatch) {
                        const domain = realmMatch[1];
                        console.log('Found realm:', domain);

                        this.getDomainSiteInfo(domain).then(site => {
                            this.updateDomainStatus({
                                domain: domain,
                                role: 'Domain Member',
                                site: site || 'Default-First-Site-Name',
                                forest: domain
                            });
                            resolve();
                        }).catch(() => {
                            this.getDomainSiteInfo(domain).then(site => {
                                this.updateDomainStatus({
                                    domain: domain,
                                    role: 'Domain Member',
                                    site: site || 'Default-First-Site-Name',
                                    forest: domain
                                });
                            });
                            resolve();
                        });
                    } else {
                        console.log('No default realm found, trying net ads info...');
                        this.tryNetAdsInfoAsync().then(resolve);
                    }
                })
                .catch(error => {
                    console.log('Realm list failed:', error);
                    this.tryNetAdsInfoAsync().then(resolve);
                });
        });
    }

    async tryNetAdsInfoAsync() {
        return new Promise((resolve) => {
            cockpit.spawn(['net', 'ads', 'info'], { superuser: "try" })
                .then(output => {
                    console.log('Net ads info output:', output);
                    const realmMatch = output.match(/Realm:\s*(\S+)/);
                    if (realmMatch) {
                        const domain = realmMatch[1];
                        console.log('Found ads realm:', domain);

                        this.getDomainSiteInfo(domain).then(site => {
                            this.updateDomainStatus({
                                domain: domain,
                                role: 'Domain Member',
                                site: site || 'Default-First-Site-Name',
                                forest: domain
                            });
                        });
                        resolve();
                        return;
                    }

                    console.log('Not joined to domain');
                    this.updateDomainStatus(null);
                    resolve();
                })
                .catch(error => {
                    console.log('All domain member detection methods failed:', error);
                    this.updateDomainStatus(null);
                    resolve();
                });
        });
    }

    async loadCurrentHostnameAsync() {
        return new Promise((resolve) => {
            cockpit.spawn(['hostname', '-f'], { superuser: "try" })
                .then(output => {
                    const currentHostname = output.trim();
                    console.log('Current hostname:', currentHostname);

                    // Populate hostname fields with current hostname
                    const provisionHostname = document.getElementById('provision-hostname');
                    const joinHostname = document.getElementById('join-hostname');

                    if (provisionHostname && currentHostname !== 'debian') {
                        provisionHostname.value = currentHostname;
                    }

                    if (joinHostname && currentHostname !== 'debian') {
                        joinHostname.value = currentHostname;
                    }

                    // If hostname is just 'debian', suggest proper FQDN
                    if (currentHostname === 'debian') {
                        if (provisionHostname) provisionHostname.placeholder = 'dc1.example.com';
                        if (joinHostname) joinHostname.placeholder = 'dc2.example.com';
                    }

                    this.loadingStates.hostname = true;
                    resolve();
                })
                .catch(error => {
                    console.log('Could not get current hostname:', error);
                    // Set default placeholders
                    const provisionHostname = document.getElementById('provision-hostname');
                    const joinHostname = document.getElementById('join-hostname');

                    if (provisionHostname) provisionHostname.placeholder = 'dc1.example.com';
                    if (joinHostname) joinHostname.placeholder = 'dc2.example.com';

                    this.loadingStates.hostname = true; // Mark as complete even on error
                    resolve();
                });
        });
    }

    async initializeSysvolManagerAsync() {
        try {
            await this.sysvolManager.initialize();
            this.loadingStates.sysvolManager = true;
        } catch (error) {
            console.error('Failed to initialize SYSVOL manager:', error);
            this.loadingStates.sysvolManager = true; // Mark as complete even on error
        }
    }


    // Emergency function to clear stuck interface and refresh status
    clearStuckInterface() {
        console.log('Clearing stuck interface...');

        // Force hide loading overlay
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            overlay.classList.add('hidden');
        }

        // Clear any loading states
        const loadingElements = document.querySelectorAll('.pf-c-spinner, .spinner-border, .loading');
        loadingElements.forEach(el => {
            el.style.display = 'none';
            el.classList.add('hidden');
        });

        // Re-enable buttons
        const buttons = document.querySelectorAll('button[disabled]');
        buttons.forEach(btn => {
            btn.disabled = false;
        });

        // Refresh domain status
        console.log('Refreshing domain status after clearing stuck interface...');
        this.checkDomainStatus();
    }

    updateDomainStatus(info) {
        const statusBadge = document.getElementById('status-badge');
        const domainDetails = document.getElementById('domain-details');
        const nodomainMessage = document.getElementById('no-domain-message');
        const domainStats = document.querySelector('.domain-statistics');
        const leaveSection = document.getElementById('leave-section');
        const provisionSection = document.getElementById('provision-section');
        const joinSection = document.getElementById('join-section');

        if (info) {
            this.isDomainJoined = true;
            this.domainInfo = info;

            // Update status badge based on role
            if (info.role === 'Domain Controller') {
                statusBadge.textContent = _("Domain Controller");
                statusBadge.className = 'pf-v5-c-badge pf-m-green domain-status-badge';
            } else if (info.role === 'Domain Controller (Needs Configuration)') {
                statusBadge.textContent = _("Needs Configuration");
                statusBadge.className = 'pf-v5-c-badge pf-m-warning domain-status-badge';
            } else if (info.role === 'Domain Member') {
                statusBadge.textContent = _("Domain Member");
                statusBadge.className = 'pf-v5-c-badge pf-m-blue domain-status-badge';
            } else {
                statusBadge.textContent = _("Connected");
                statusBadge.className = 'pf-v5-c-badge pf-m-green domain-status-badge';
            }

            // Update domain details
            document.getElementById('domain-name').textContent = info.domain;
            document.getElementById('domain-role').textContent = info.role;
            document.getElementById('domain-site').textContent = info.site || 'Default-First-Site-Name';
            document.getElementById('domain-forest').textContent = info.forest || info.domain;

            // Show connected state
            domainDetails.classList.remove('hidden');
            nodomainMessage.classList.add('hidden');
            leaveSection.classList.remove('hidden');
            provisionSection.classList.add('hidden');
            joinSection.classList.add('hidden');

            // Update leave section based on role
            const leaveSectionTitle = leaveSection.querySelector('h4');
            const leaveAlert = leaveSection.querySelector('.pf-v5-c-alert__title');
            const leaveBtn = leaveSection.querySelector('#leave-btn');

            if (info.role === 'Domain Member') {
                leaveSectionTitle.textContent = _("Leave Domain");
                leaveAlert.textContent = _("This will remove the server from the domain. Domain authentication will no longer work.");
                leaveBtn.textContent = _("Leave Domain");
            } else {
                leaveSectionTitle.textContent = _("Leave Domain");
                leaveAlert.textContent = _("This will remove the server from the domain and reset all domain configurations.");
                leaveBtn.textContent = _("Leave Domain");
            }

            // Only show domain statistics and enable DC features for fully configured Domain Controllers
            if (info.role === 'Domain Controller') {
                domainStats.classList.remove('hidden');
                this.updateDomainStatistics();

                // Show DC-specific sections
                const fsmoSection = document.querySelector('.fsmo-roles-section');
                if (fsmoSection) fsmoSection.classList.remove('hidden');

                // Check service status for Domain Controllers only
                this.checkServiceStatus();

                // Load FSMO roles for Domain Controllers
                this.fsmoManager.loadFSMORoles();

            } else if (info.role === 'Domain Controller (Needs Configuration)') {
                // For DCs that need configuration, show limited info and configuration options
                domainStats.classList.add('hidden');

                // Hide FSMO sections until properly configured
                const fsmoSection = document.querySelector('.fsmo-roles-section');
                if (fsmoSection) fsmoSection.classList.add('hidden');

                // Check service status to show what needs to be fixed
                this.checkServiceStatus();

                // Don't try to load FSMO roles for unconfigured DCs
                this.clearFSMORoles();

                // Show provision/join sections for completing configuration
                provisionSection.classList.remove('hidden');
                joinSection.classList.remove('hidden');
            } else {
                domainStats.classList.add('hidden');

                // Hide DC-specific sections for domain members
                const fsmoSection = document.querySelector('.fsmo-roles-section');
                if (fsmoSection) fsmoSection.classList.add('hidden');

                // Clear statistics for domain members
                const statElements = ['user-count', 'computer-count', 'group-count', 'ou-count'];
                statElements.forEach(id => {
                    const element = document.getElementById(id);
                    if (element) element.textContent = '—';
                });

                // For domain members, show relevant service status (just basic services)
                this.updateServiceLabelsForDomainMember();
                this.checkDomainMemberServices();
            }
        } else {
            this.isDomainJoined = false;
            this.domainInfo = null;

            // Update status badge
            statusBadge.textContent = _("Not Connected");
            statusBadge.className = 'pf-v5-c-badge pf-m-red domain-status-badge';

            // Show disconnected state
            domainDetails.classList.add('hidden');
            nodomainMessage.classList.remove('hidden');
            domainStats.classList.add('hidden');
            leaveSection.classList.add('hidden');
            provisionSection.classList.remove('hidden');
            joinSection.classList.remove('hidden');
        }
    }

    updateDomainStatistics() {
        const commands = [
            { command: ['samba-tool', 'user', 'list'], element: 'user-count' },
            { command: ['samba-tool', 'computer', 'list'], element: 'computer-count' },
            { command: ['samba-tool', 'group', 'list'], element: 'group-count' },
            { command: ['samba-tool', 'ou', 'list'], element: 'ou-count' }
        ];

        commands.forEach(({ command, element }) => {
            cockpit.spawn(command, { superuser: "try" })
                .then(output => {
                    const count = output.trim().split('\n').filter(line => line.trim()).length;
                    document.getElementById(element).textContent = count;
                })
                .catch(error => {
                    console.log(`${element} command failed:`, error);
                    document.getElementById(element).textContent = '—';
                });
        });
    }

    async provisionDomain() {
        const domainName = document.getElementById('domain-name-input').value.trim();
        const hostname = document.getElementById('provision-hostname').value.trim();
        const netbiosName = document.getElementById('netbios-name').value.trim();
        const adminUser = document.getElementById('admin-user').value.trim();
        const adminPassword = document.getElementById('admin-password').value;
        const selectedInterface = document.getElementById('provision-interface').value;

        if (!domainName || !hostname || !adminPassword || !selectedInterface) {
            this.showError(_("Please fill in all required fields"));
            return;
        }

        // Validate domain name format
        if (!domainName.includes('.')) {
            this.showError(_("Domain name must be in FQDN format (e.g., example.com)"));
            return;
        }

        // Validate hostname format
        if (!this.validateHostname(hostname, domainName)) {
            this.showError(_("Hostname must be a valid FQDN within the domain (e.g., dc1.example.com)"));
            return;
        }

        this.showLoading();

        // Set hostname first
        this.setHostname(hostname).then(() => {
            this.continueProvision(domainName, hostname, netbiosName, adminUser, adminPassword, selectedInterface);
        }).catch(error => {
            this.hideLoading();
            this.showError(_("Failed to set hostname: ") + error.message);
        });
    }

    continueProvision(domainName, hostname, netbiosName, adminUser, adminPassword, selectedInterface) {
        // Get the IP address for the selected interface
        const interfaceInfo = this.networkInterfaces.find(iface => iface.name === selectedInterface);
        const interfaceIP = interfaceInfo ? interfaceInfo.ips[0] : null;

        if (!interfaceIP) {
            this.showError(_("Unable to get IP address for selected interface"));
            this.hideLoading();
            return;
        }

        // Use provided NetBIOS name or auto-generate
        const finalNetbiosName = netbiosName || domainName.split('.')[0].toUpperCase().substring(0, 15);

        // Use provided admin username or default
        const finalAdminUser = adminUser || 'Administrator';

        // Build base command
        const command = [
            'samba-tool', 'domain', 'provision',
            '--domain=' + finalNetbiosName,
            '--realm=' + domainName.toUpperCase(),
            '--adminpass=' + adminPassword,
            '--server-role=dc',
            '--host-ip=' + interfaceIP
        ];

        // Note: Custom admin user will be created after provisioning

        // Add advanced options if specified
        const dnsBackend = document.getElementById('dns-backend').value;
        const dnsForwarder = document.getElementById('dns-forwarder').value.trim();
        const siteName = document.getElementById('site-name').value.trim();
        const forestLevel = document.getElementById('forest-level').value;
        const useRfc2307 = document.getElementById('use-rfc2307').checked;
        const useXattrs = document.getElementById('use-xattrs').checked;

        if (dnsBackend && dnsBackend !== 'SAMBA_INTERNAL') {
            command.push('--dns-backend=' + dnsBackend);
        }

        if (dnsForwarder) {
            command.push('--option=dns forwarder = ' + dnsForwarder);
        }

        if (siteName) {
            command.push('--site=' + siteName);
            console.log('Using site name:', siteName);
        } else {
            console.log('No site name provided, using default');
        }

        if (forestLevel) {
            command.push('--function-level=' + forestLevel);
        }

        if (useRfc2307) {
            command.push('--use-rfc2307');
        }

        if (useXattrs) {
            command.push('--use-xattrs=yes');
        }

        // First, remove existing smb.conf if it exists to avoid conflicts
        cockpit.spawn(['rm', '-f', '/etc/samba/smb.conf'], { superuser: "try" })
            .then(() => {
                // Now run the provision command
                this.uiManager.showLogModal("Provisioning domain...");
                const proc = cockpit.spawn(command, { superuser: "try" });
                proc.stream(data => this.handleLogStream(data));
                return proc;
            })
            .then(output => {
                console.log('Provision output:', output);

                // Configure NTP for PDC Emulator (primary domain controller)
                const ntpServers = document.getElementById('ntp-servers').value.trim();
                this.configureNTPForPDC(ntpServers);

                // Update Kerberos configuration for RSAT compatibility
                this.updateKerberosConfig(domainName, hostname);

                // Create custom admin user if specified
                const setupUserPromise = (finalAdminUser !== 'Administrator') ?
                    this.createCustomAdminUser(finalAdminUser, adminPassword, domainName) :
                    Promise.resolve();

                return setupUserPromise.then(() => {
                    // If a custom site name was provided, create the site and move the DC
                    if (siteName && siteName !== 'Default-First-Site-Name') {
                        return this.createAndMoveSite(siteName, domainName);
                    }
                }).then(() => {
                    // Set up DHCP configuration if enabled
                    const enableDhcp = document.getElementById('enable-dhcp').checked;
                    if (enableDhcp) {
                        const dhcpRangeStart = document.getElementById('dhcp-provision-range-start').value.trim();
                        const dhcpRangeEnd = document.getElementById('dhcp-provision-range-end').value.trim();
                        const dhcpLeaseTime = document.getElementById('dhcp-provision-lease-time').value.trim();

                        return this.setupDhcpConfiguration(domainName, interfaceIP, interfaceInfo, {
                            rangeStart: dhcpRangeStart,
                            rangeEnd: dhcpRangeEnd,
                            leaseTime: dhcpLeaseTime
                        });
                    }
                    return Promise.resolve();
                }).then(() => {
                    // Enable and start samba-ad-dc service after successful provision
                    console.log('Domain provision successful, enabling and starting samba-ad-dc...');
                    return cockpit.spawn(['systemctl', 'enable', 'samba-ad-dc'], { superuser: "try" })
                        .then(() => {
                            return cockpit.spawn(['systemctl', 'start', 'samba-ad-dc'], { superuser: "try" });
                        })
                        .then(() => {
                            console.log('Samba AD DC service enabled and started successfully');

                            this.hideLoading();
                            this.getDomainSiteInfo(domainName).then(actualSite => {
                                this.updateDomainStatus({
                                    domain: domainName,
                                    role: 'Domain Controller',
                                    site: actualSite,
                                    forest: domainName
                                });
                            }).catch(() => {
                                this.updateDomainStatus({
                                    domain: domainName,
                                    role: 'Domain Controller',
                                    site: siteName || 'Default-First-Site-Name',
                                    forest: domainName
                                });
                            });
                            this.showSuccess(_("Domain provisioned successfully!"));

                            // Refresh service status after a short delay
                            setTimeout(() => {
                                this.checkServiceStatus();
                            }, 2000);
                        })
                        .catch(serviceError => {
                            console.warn('Service start failed but provision succeeded:', serviceError);
                            // Still show success but with a note about service
                            this.hideLoading();
                            this.getDomainSiteInfo(domainName).then(actualSite => {
                                this.updateDomainStatus({
                                    domain: domainName,
                                    role: 'Domain Controller',
                                    site: actualSite,
                                    forest: domainName
                                });
                            }).catch(() => {
                                this.updateDomainStatus({
                                    domain: domainName,
                                    role: 'Domain Controller',
                                    site: siteName || 'Default-First-Site-Name',
                                    forest: domainName
                                });
                            });
                            this.showSuccess(_("Domain provisioned successfully! You may need to manually start the samba-ad-dc service."));
                            setTimeout(() => {
                                this.checkServiceStatus();
                            }, 2000);
                        });
                });
            })
            .catch(error => {
                this.hideLoading();
                console.error('Provision failed:', error);
                this.showError(_("Failed to provision domain: ") + error.message);
            });
    }

    async joinDomain() {
        const domainName = document.getElementById('existing-domain').value.trim();
        const hostname = document.getElementById('join-hostname').value.trim();
        const domainControllerIP = document.getElementById('domain-controller-ip').value.trim();
        const username = document.getElementById('domain-user').value.trim();
        const password = document.getElementById('domain-password').value;
        const selectedInterface = document.getElementById('join-interface').value;

        if (!domainName || !hostname || !domainControllerIP || !username || !password || !selectedInterface) {
            this.showError(_("Please fill in all required fields"));
            return;
        }

        // Validate hostname format
        if (!this.validateHostname(hostname, domainName)) {
            this.showError(_("Hostname must be a valid FQDN within the domain (e.g., dc2.example.com)"));
            return;
        }

        // Validate network connectivity to domain controller
        console.log('Testing connectivity to domain controller:', domainControllerIP);
        this.showLoading(_("Testing connectivity to domain controller..."));

        // Set hostname first, then test connectivity
        this.setHostname(hostname).then(() => {
            // Test connectivity with multiple approaches
            this.testDomainControllerConnectivity(domainControllerIP, domainName)
                .then(() => {
                    console.log('Connectivity test passed, proceeding with domain join');
                    this.proceedWithDomainJoin(domainName, hostname, domainControllerIP, username, password, selectedInterface);
                })
                .catch(error => {
                    this.hideLoading();
                    this.showError(_("Cannot connect to domain controller: ") + error.message);
                });
        }).catch(error => {
            this.hideLoading();
            this.showError(_("Failed to set hostname: ") + error.message);
        });
    }

    testDomainControllerConnectivity(dcIP, domainName) {
        // Test basic network connectivity first
        return cockpit.spawn(['ping', '-c', '2', '-W', '3', dcIP], { superuser: "try" })
            .then(() => {
                console.log('Ping test successful');
                // Test SMB port connectivity
                return cockpit.spawn(['nc', '-z', '-w', '5', dcIP, '445'], { superuser: "try" });
            })
            .then(() => {
                console.log('SMB port test successful');
                // Skip DNS resolution test - DNS will be configured during join process
                console.log('Connectivity tests passed, DNS will be configured during join');
                return Promise.resolve();
            })
            .catch(error => {
                console.error('Connectivity test failed:', error);
                if (error.message.includes('ping')) {
                    throw new Error('Network unreachable - cannot ping ' + dcIP);
                } else if (error.message.includes('nc') || error.message.includes('Connection refused')) {
                    throw new Error('SMB port (445) is not accessible on ' + dcIP);
                } else {
                    throw new Error('Connectivity test failed: ' + error.message);
                }
            });
    }

    proceedWithDomainJoin(domainName, hostname, domainControllerIP, username, password, selectedInterface) {
        this.showLoading(_("Joining domain " + domainName + "..."));

        // Get the IP address for the selected interface
        const interfaceInfo = this.networkInterfaces.find(iface => iface.name === selectedInterface);
        const interfaceIP = interfaceInfo ? interfaceInfo.ips[0] : null;

        if (!interfaceIP) {
            this.showError(_("Unable to get IP address for selected interface"));
            this.hideLoading();
            return;
        }

        // Build base command
        const command = [
            'samba-tool', 'domain', 'join', domainName, 'DC',
            '-U', username + '%' + password,
            '--ipaddress=' + interfaceIP,
            '--server=' + domainControllerIP
        ];

        // Add advanced options if specified
        const siteName = document.getElementById('join-site-name').value.trim();
        const dnsBackend = document.getElementById('join-dns-backend').value;
        const dnsForwarder = document.getElementById('join-dns-forwarder').value.trim();
        const criticalOnly = document.getElementById('join-critical-only').checked;

        // For now, don't specify custom sites during join to avoid site creation issues
        // The server will be placed in the default site and can be moved later
        if (siteName && siteName !== 'Default-First-Site-Name') {
            console.log('Custom site specified but will use default site for join:', siteName);
        } else {
            console.log('Using default site for join');
        }

        if (dnsBackend && dnsBackend !== 'SAMBA_INTERNAL') {
            command.push('--dns-backend=' + dnsBackend);
        }

        if (dnsForwarder) {
            command.push('--option=dns forwarder = ' + dnsForwarder);
        }

        if (criticalOnly) {
            command.push('--domain-critical-only');
        }

        // First, remove existing smb.conf if it exists to avoid conflicts
        cockpit.spawn(['rm', '-f', '/etc/samba/smb.conf'], { superuser: "try" })
            .then(() => {
                // Configure DNS to use the domain controller before joining
                const dnsConfig = `nameserver ${domainControllerIP}\nnameserver 8.8.8.8\n`;

                // Backup existing resolv.conf
                return cockpit.spawn(['cp', '/etc/resolv.conf', '/etc/resolv.conf.backup'], { superuser: "try" })
                    .catch(() => console.log('Could not backup resolv.conf'));
            })
            .then(() => {
                // Set DNS to use domain controller with search domain
                const dnsConfig = `search ${domainName}\nnameserver ${domainControllerIP}\nnameserver 8.8.8.8\n`;
                return cockpit.spawn(['tee', '/etc/resolv.conf'], { superuser: "try" }).input(dnsConfig);
            })
            .then(() => {
                // Configure firewall for RPC dynamic ports needed for domain replication
                console.log('Configuring ufw firewall for domain replication...');

                const ufwCommands = [
                    'ufw allow 1024:65535/tcp',   // RPC dynamic ports
                    'ufw allow 1024:65535/udp'    // RPC dynamic ports UDP
                ];

                return Promise.all(ufwCommands.map(cmd =>
                    cockpit.spawn(cmd.split(' '), { superuser: "try" })
                        .catch(error => console.log('UFW command failed:', cmd, error.message))
                ));
            })
            .then(() => {
                console.log('DNS configured to use domain controller:', domainControllerIP);
                console.log('Join command:', command.join(' '));
                // Now run the join command
                this.uiManager.showLogModal("Joining domain...");
                const proc = cockpit.spawn(command, { superuser: "try" });
                proc.stream(data => this.handleLogStream(data));
                return proc;
            })
            .then(output => {
                console.log('Domain join successful, enabling and starting samba-ad-dc...');

                // Enable and start samba-ad-dc service after successful join
                return cockpit.spawn(['systemctl', 'enable', 'samba-ad-dc'], { superuser: "try" })
                    .then(() => {
                        return cockpit.spawn(['systemctl', 'start', 'samba-ad-dc'], { superuser: "try" });
                    })
                    .then(() => {
                        console.log('Samba AD DC service enabled and started successfully');

                        // Configure NTP for additional domain controller (gets time from PDC)
                        this.configureNTPForAdditionalDC(domainControllerIP);

                        // Update Kerberos configuration for RSAT compatibility
                        this.updateKerberosConfig(domainName, hostname);

                        this.hideLoading();
                        this.getDomainSiteInfo(domainName).then(actualSite => {
                            this.updateDomainStatus({
                                domain: domainName,
                                role: 'Domain Controller',
                                site: actualSite,
                                forest: domainName
                            });
                        }).catch(() => {
                            this.updateDomainStatus({
                                domain: domainName,
                                role: 'Domain Controller',
                                site: 'Default-First-Site-Name',
                                forest: domainName
                            });
                        });
                        this.showSuccess(_("Successfully joined domain as Domain Controller!"));

                        // Refresh service status after a short delay
                        setTimeout(() => {
                            this.checkServiceStatus();
                        }, 2000);
                    })
                    .catch(serviceError => {
                        console.warn('Service start failed but join succeeded:', serviceError);
                        // Still show success but with a note about service
                        this.configureNTPForAdditionalDC(domainControllerIP);

                        // Update Kerberos configuration for RSAT compatibility
                        this.updateKerberosConfig(domainName, hostname);
                        this.hideLoading();
                        this.getDomainSiteInfo(domainName).then(actualSite => {
                            this.updateDomainStatus({
                                domain: domainName,
                                role: 'Domain Controller',
                                site: actualSite,
                                forest: domainName
                            });
                        }).catch(() => {
                            this.updateDomainStatus({
                                domain: domainName,
                                role: 'Domain Controller',
                                site: 'Default-First-Site-Name',
                                forest: domainName
                            });
                        });
                        this.showSuccess(_("Joined domain successfully! You may need to manually start the samba-ad-dc service."));
                        setTimeout(() => {
                            this.checkServiceStatus();
                        }, 2000);
                    });
            })
            .catch(error => {
                this.hideLoading();
                console.error('Join failed:', error);
                this.showError(_("Failed to join domain: ") + error.message);
            });
    }

    leaveDomain() {
        if (!confirm(_("Are you sure you want to leave the domain? This will remove all domain configurations."))) {
            return;
        }

        this.showLoading();

        // First try to demote properly
        cockpit.spawn(['samba-tool', 'domain', 'demote'], { superuser: "try" })
            .then(output => {
                this.hideLoading();
                this.updateDomainStatus(null);
                this.showSuccess(_("Successfully left the domain"));
            })
            .catch(error => {
                console.error('Demote failed:', error);
                // If demote fails, try manual cleanup
                this.forceLeaveCleanup();
            });
    }

    createAndMoveSite(siteName, domainName) {
        console.log('Creating site:', siteName);

        // Create the new site (ignore if it already exists)
        return cockpit.spawn(['samba-tool', 'sites', 'create', siteName], { superuser: "try" })
            .then(() => {
                console.log('Site created successfully');
                this.completeSiteSetup(siteName, domainName);
            })
            .catch(error => {
                console.log('Site creation result:', error.message);
                // Check if the error is because site already exists
                if (error.message.includes('SiteAlreadyExistsException') || error.message.includes('already exists')) {
                    console.log('Site already exists, continuing...');
                    this.completeSiteSetup(siteName, domainName);
                } else {
                    console.error('Site creation failed with unexpected error:', error);
                    // If site creation fails for other reasons, continue with default site
                    this.hideLoading();
                    this.updateDomainStatus({
                        domain: domainName,
                        role: 'Domain Controller',
                        site: 'Default-First-Site-Name',
                        forest: domainName
                    });
                    this.showSuccess(_("Domain provisioned successfully! (using default site)"));
                }
            });
    }

    completeSiteSetup(siteName, domainName) {
        console.log('Completing site setup for:', siteName);
        this.hideLoading();
        this.updateDomainStatus({
            domain: domainName,
            role: 'Domain Controller',
            site: siteName,
            forest: domainName
        });
        this.showSuccess(_("Domain provisioned successfully! Site: ") + siteName);
    }


    configureNTPForPDC() {
        console.log('Configuring NTP for PDC Emulator (primary domain controller)');

        // PDC should get time from external reliable sources
        const ntpConfig = `
# NTP configuration for PDC Emulator (added by cockpit-domain-controller)
# PDC gets time from external sources and serves time to other domain controllers

# External NTP sources (reliable public servers)
pool time.cloudflare.com iburst
pool time.google.com iburst
pool pool.ntp.org iburst
pool time.nist.gov iburst

# Allow time serving to domain clients
allow all

# Serve time even if not synchronized to external sources
local stratum 10
`;

        // Backup existing chrony.conf and add our configuration
        const commands = [
            ['cp', '/etc/chrony.conf', '/etc/chrony.conf.backup'],
            ['sh', '-c', `echo '${ntpConfig}' >> /etc/chrony.conf`],
            ['systemctl', 'restart', 'chrony']
        ];

        let configPromise = Promise.resolve();
        commands.forEach(command => {
            configPromise = configPromise.then(() => {
                return cockpit.spawn(command, { superuser: "try" }).catch(err => {
                    console.log('NTP config command failed:', err);
                });
            });
        });

        configPromise.then(() => {
            console.log('PDC NTP configuration completed');
        });
    }

    configureNTPForAdditionalDC(pdcIP) {
        console.log('Configuring NTP for additional domain controller');

        // Additional DC should get time from PDC, not external sources
        const ntpConfig = `
# NTP configuration for additional domain controller (added by cockpit-domain-controller)
# Additional DC gets time from PDC Emulator, not external sources

# Primary time source: PDC Emulator
server ${pdcIP} iburst prefer

# Fallback to local hardware clock if PDC unavailable
local stratum 15

# Allow time serving to domain clients
allow all
`;

        // Backup existing chrony.conf and add our configuration
        const commands = [
            ['cp', '/etc/chrony.conf', '/etc/chrony.conf.backup'],
            ['sh', '-c', `echo '${ntpConfig}' >> /etc/chrony.conf`],
            ['systemctl', 'restart', 'chrony']
        ];

        let configPromise = Promise.resolve();
        commands.forEach(command => {
            configPromise = configPromise.then(() => {
                return cockpit.spawn(command, { superuser: "try" }).catch(err => {
                    console.log('NTP config command failed:', err);
                });
            });
        });

        configPromise.then(() => {
            console.log('Additional DC NTP configuration completed');
        });
    }

    forceLeaveCleanup() {
        console.log('Attempting comprehensive domain cleanup...');

        // Comprehensive cleanup: remove ALL domain-related configurations
        const cleanupCommands = [
            // Stop all domain-related services
            ['systemctl', 'stop', 'samba-ad-dc'],
            ['systemctl', 'stop', 'isc-dhcp-server'],
            ['systemctl', 'stop', 'chrony'],
            ['systemctl', 'stop', 'dhcp-fsmo-monitor.timer'],
            ['systemctl', 'stop', 'ntp-fsmo-monitor.timer'],

            // Disable services
            ['systemctl', 'disable', 'samba-ad-dc'],
            ['systemctl', 'disable', 'dhcp-fsmo-monitor.timer'],
            ['systemctl', 'disable', 'ntp-fsmo-monitor.timer'],

            // Remove Samba AD DC configuration
            ['rm', '-rf', '/etc/samba/smb.conf'],
            ['rm', '-rf', '/etc/samba/smb.conf.backup'],
            ['rm', '-rf', '/var/lib/samba/private'],
            ['rm', '-rf', '/var/lib/samba/sysvol'],
            ['rm', '-rf', '/var/cache/samba'],
            ['rm', '-rf', '/var/log/samba'],

            // Clean up DNS configuration
            ['rm', '-rf', '/etc/bind/named.conf.local.backup'],

            // Reset hostname to non-domain format if needed
            // ['hostnamectl', 'set-hostname', 'localhost'],

            // Clean up DHCP configuration (reset to basic)
            ['rm', '-rf', '/etc/dhcp/dhcpd.conf.backup'],

            // Reset Kerberos configuration
            ['rm', '-rf', '/etc/krb5.conf'],
            ['rm', '-rf', '/etc/krb5.keytab'],

            // Clean up Chrony NTP configuration (restore default)
            ['rm', '-rf', '/etc/chrony.conf.backup'],
            ['cp', '/usr/share/chrony/chrony.conf', '/etc/chrony.conf'],

            // Remove FSMO management components
            ['rm', '-rf', '/usr/local/bin/dhcp-fsmo-manager.sh'],
            ['rm', '-rf', '/usr/local/bin/ntp-fsmo-manager.sh'],
            ['rm', '-rf', '/etc/systemd/system/dhcp-fsmo-monitor.service'],
            ['rm', '-rf', '/etc/systemd/system/dhcp-fsmo-monitor.timer'],
            ['rm', '-rf', '/etc/systemd/system/ntp-fsmo-monitor.service'],
            ['rm', '-rf', '/etc/systemd/system/ntp-fsmo-monitor.timer'],

            // Clean up resolv.conf
            ['rm', '-rf', '/etc/resolv.conf.backup'],

            // Reload systemd after removing unit files
            ['systemctl', 'daemon-reload'],

            // Reset services to default state
            ['systemctl', 'enable', 'chrony'],
            ['systemctl', 'start', 'chrony'],

            // Restore original /etc/hosts if backup exists
            ['bash', '-c', 'if [ -f /etc/hosts.backup ]; then mv /etc/hosts.backup /etc/hosts; fi'],

            // Clear any cached credentials
            ['bash', '-c', 'rm -rf /tmp/krb5cc_* 2>/dev/null || true'],
            ['bash', '-c', 'rm -rf /var/tmp/krb5cc_* 2>/dev/null || true']
        ];

        // Create a basic DHCP config to replace the domain one
        const basicDhcpConfig = `# Basic DHCP configuration - NOT domain integrated
# This is a minimal configuration for the DHCP server
# Please configure this file according to your network requirements

default-lease-time 600;
max-lease-time 7200;
ddns-update-style none;
authoritative;

# Example subnet configuration (DISABLED by default)
# Uncomment and modify according to your network:
#
# subnet 192.168.1.0 netmask 255.255.255.0 {
#   range 192.168.1.100 192.168.1.200;
#   option routers 192.168.1.1;
#   option domain-name-servers 192.168.1.1;
#   option domain-name "example.com";
# }

# Log facility configuration
log-facility local7;
`;

        // Create basic krb5.conf
        const basicKrb5Config = `[libdefaults]
	default_realm = EXAMPLE.COM
	kdc_timesync = 1
	ccache_type = 4
	forwardable = true
	proxiable = true
	rdns = false

# The following krb5.conf variables are only for MIT Kerberos.
	fcc-mit-ticketflags = true
	udp_preference_limit = 0
`;

        let cleanupPromise = Promise.resolve();

        cleanupCommands.forEach(command => {
            cleanupPromise = cleanupPromise.then(() => {
                console.log('Running cleanup command:', command.join(' '));
                return cockpit.spawn(command, { superuser: "try" }).catch(err => {
                    console.log('Cleanup command failed (may be expected):', err);
                });
            });
        });

        // Write basic configuration files
        cleanupPromise = cleanupPromise.then(() => {
            console.log('Writing basic DHCP configuration...');
            return cockpit.file('/etc/dhcp/dhcpd.conf', { superuser: "try" }).replace(basicDhcpConfig);
        }).then(() => {
            console.log('Writing basic Kerberos configuration...');
            return cockpit.file('/etc/krb5.conf', { superuser: "try" }).replace(basicKrb5Config);
        });

        cleanupPromise.then(() => {
            this.hideLoading();
            this.updateDomainStatus(null);
            this.showSuccess(_("Complete domain cleanup finished. All domain configurations removed. Server is ready for fresh domain setup."));
        }).catch(error => {
            this.hideLoading();
            console.error('Cleanup failed:', error);
            this.showError(_("Domain cleanup partially failed: ") + error.message + _(" Manual verification may be required."));
        });
    }

    async checkDomainStatus() {
        // Only show loading if not in initial load (avoid double loading overlay)
        const isInitialLoad = Object.values(this.loadingStates).some(state => !state);
        if (!isInitialLoad) {
            this.showLoading();
        }
        console.log('Starting domain status check...');

        const timeout = setTimeout(() => {
            console.log('Command timed out after 10 seconds');
            if (!isInitialLoad) {
                this.hideLoading();
            }
            this.updateDomainStatus(null);
        }, 10000);

        // Check if local domain exists first (Domain Controller check)
        cockpit.spawn(['samba-tool', 'domain', 'info', '127.0.0.1'], { superuser: "try" })
            .then(output => {
                clearTimeout(timeout);
                console.log('Domain info output:', output);
                if (!isInitialLoad) {
                    this.hideLoading();
                }

                const lines = output.split('\n');
                const domainLine = lines.find(line => line.trim().startsWith('Domain') && line.includes(':'));
                const forestLine = lines.find(line => line.trim().startsWith('Forest') && line.includes(':'));

                if (domainLine) {
                    const domain = domainLine.split(':')[1]?.trim();
                    const forest = forestLine ? forestLine.split(':')[1]?.trim() : domain;

                    if (domain) {
                        this.getDomainSiteInfo(domain).then(site => {
                            this.updateDomainStatus({
                                domain: domain,
                                role: 'Domain Controller',
                                site: site,
                                forest: forest
                            });
                        }).catch(() => {
                            this.updateDomainStatus({
                                domain: domain,
                                role: 'Domain Controller',
                                site: 'Default-First-Site-Name',
                                forest: forest
                            });
                        });

                        // Periodically check and update NTP configuration based on FSMO roles
                        console.log('Checking NTP configuration based on FSMO roles...');
                        this.checkAndUpdateNTPForFSMO().catch(error => {
                            console.log('Periodic NTP/FSMO check failed:', error);
                        });

                        // Show current NTP status
                        this.showCurrentNTPStatus();

                        // Check service status for Domain Controllers
                        this.checkServiceStatus();

                        // Load FSMO roles
                        this.fsmoManager.loadFSMORoles();

                        // Set up periodic FSMO role updates
                        if (this.fsmoUpdateInterval) {
                            clearInterval(this.fsmoUpdateInterval);
                        }
                        this.fsmoUpdateInterval = setInterval(() => {
                            this.checkServiceStatus();
                            this.fsmoManager.loadFSMORoles();
                        }, 30000); // Update every 30 seconds
                    } else {
                        console.log('Could not parse domain from output');
                        this.checkDomainControllerStatus();
                    }
                } else {
                    console.log('Domain line not found in output, trying alternative DC detection...');
                    this.checkDomainControllerStatus();
                }
            })
            .catch(error => {
                clearTimeout(timeout);
                console.log('Domain controller check failed, trying alternative DC detection:', error);
                this.checkDomainControllerStatus();
            });
    }

    checkDomainControllerStatus() {
        console.log('Checking for domain controller indicators...');

        // Check multiple indicators that this should be a domain controller
        const indicators = {
            hasKrb5Config: false,
            hasSambaAdDcService: false,
            hasSmblConf: false,
            hasSambaPrivateDir: false,
            domain: null
        };

        // Check 1: Kerberos configuration (indicates domain involvement)
        cockpit.file('/etc/krb5.conf').read()
            .then(content => {
                const realmMatch = content.match(/default_realm\s*=\s*([^\s\n]+)/i);
                if (realmMatch) {
                    indicators.hasKrb5Config = true;
                    indicators.domain = realmMatch[1].toLowerCase();
                }
                return this.checkSambaAdDcService();
            })
            .then(hasService => {
                indicators.hasSambaAdDcService = hasService;
                return this.checkSambaConfig();
            })
            .then(hasSmb => {
                indicators.hasSmblConf = hasSmb;
                return this.checkSambaPrivateDir();
            })
            .then(hasPrivateDir => {
                indicators.hasSambaPrivateDir = hasPrivateDir;
                this.evaluateDomainControllerStatus(indicators);
            })
            .catch(error => {
                console.log('Error checking DC indicators:', error);
                // If we have domain info from krb5.conf, assume it's a DC that needs configuration
                if (indicators.hasKrb5Config && indicators.domain) {
                    this.getDomainSiteInfo(indicators.domain).then(site => {
                        this.updateDomainStatus({
                            domain: indicators.domain,
                            role: 'Domain Controller (Needs Configuration)',
                            site: site,
                            forest: indicators.domain
                        });
                    }).catch(() => {
                        this.updateDomainStatus({
                            domain: indicators.domain,
                            role: 'Domain Controller (Needs Configuration)',
                            site: 'Default-First-Site-Name',
                            forest: indicators.domain
                        });
                    });
                } else {
                    // Only fall back to member check if there's really no DC evidence
                    this.checkDomainMemberStatus();
                }
                if (!isInitialLoad) {
                    this.hideLoading();
                }
            });
    }

    async checkSambaAdDcService() {
        try {
            await cockpit.spawn(['systemctl', 'list-unit-files', 'samba-ad-dc.service'], { superuser: "try" });
            return true;
        } catch (error) {
            return false;
        }
    }

    async checkSambaConfig() {
        try {
            await cockpit.file('/etc/samba/smb.conf').read();
            return true;
        } catch (error) {
            return false;
        }
    }

    async checkSambaPrivateDir() {
        try {
            await cockpit.spawn(['test', '-d', '/var/lib/samba/private'], { superuser: "try" });
            return true;
        } catch (error) {
            return false;
        }
    }

    async evaluateDomainControllerStatus(indicators) {
        console.log('DC indicators:', indicators);

        if (indicators.hasKrb5Config && indicators.domain) {
            // Has domain configuration - assume it's a DC
            let role = 'Domain Controller';

            // Check if it needs configuration
            if (!indicators.hasSmblConf || !indicators.hasSambaPrivateDir) {
                role = 'Domain Controller (Needs Configuration)';
            }

            this.getDomainSiteInfo(indicators.domain).then(site => {
                this.updateDomainStatus({
                    domain: indicators.domain,
                    role: role,
                    site: site,
                    forest: indicators.domain
                });
            }).catch(() => {
                this.updateDomainStatus({
                    domain: indicators.domain,
                    role: role,
                    site: 'Default-First-Site-Name',
                    forest: indicators.domain
                });
            });
        } else {
            // No clear DC indicators, fall back to member check
            this.checkDomainMemberStatus();
        }

        const isInitialLoad = Object.values(this.loadingStates).some(state => !state);
        if (!isInitialLoad) {
            this.hideLoading();
        }
    }

    async checkDomainMemberStatus() {
        console.log('Checking domain member status...');
        const isInitialLoad = Object.values(this.loadingStates).some(state => !state);

        // Check /etc/krb5.conf for domain info first (more reliable)
        cockpit.file('/etc/krb5.conf').read()
            .then(content => {
                console.log('Checking krb5.conf for domain info...');
                const realmMatch = content.match(/default_realm\s*=\s*([^\s\n]+)/i);

                if (realmMatch) {
                    const domain = realmMatch[1].toLowerCase();

                    // Try to get site information from DNS
                    this.getDomainSiteInfo(domain).then(site => {
                        this.updateDomainStatus({
                            domain: domain,
                            role: 'Domain Member',
                            site: site || 'Default-First-Site-Name',
                            forest: domain
                        });
                        if (!isInitialLoad) {
                            this.hideLoading();
                        }
                    }).catch(() => {
                        this.getDomainSiteInfo(domain).then(site => {
                            this.updateDomainStatus({
                                domain: domain,
                                role: 'Domain Member',
                                site: site,
                                forest: domain
                            });
                        }).catch(() => {
                            this.updateDomainStatus({
                                domain: domain,
                                role: 'Domain Member',
                                site: 'Default-First-Site-Name',
                                forest: domain
                            });
                        });
                        if (!isInitialLoad) {
                            this.hideLoading();
                        }
                    });
                } else {
                    console.log('No default realm found, trying net ads info...');
                    this.tryNetAdsInfo();
                }
            })
            .catch(err => {
                console.log('Could not read krb5.conf, trying net ads info:', err);
                this.tryNetAdsInfo();
            });
    }

    tryNetAdsInfo() {
        // Fallback: try net ads info
        cockpit.spawn(['net', 'ads', 'info'], { superuser: "try" })
            .then(output => {
                console.log('Domain member info output:', output);
                const lines = output.split('\n');
                const realmLine = lines.find(line => line.trim().toLowerCase().includes('realm'));

                if (realmLine) {
                    const realmMatch = realmLine.match(/realm[:\s]+([^\s]+)/i);
                    if (realmMatch) {
                        const domain = realmMatch[1].toLowerCase();
                        this.getDomainSiteInfo(domain).then(site => {
                            this.updateDomainStatus({
                                domain: domain,
                                role: 'Domain Member',
                                site: site,
                                forest: domain
                            });
                        }).catch(() => {
                            this.updateDomainStatus({
                                domain: domain,
                                role: 'Domain Member',
                                site: 'Default-First-Site-Name',
                                forest: domain
                            });
                        });
                        if (!isInitialLoad) {
                            this.hideLoading();
                        }
                        return;
                    }
                }

                console.log('Not joined to domain');
                this.updateDomainStatus(null);
                if (!isInitialLoad) {
                    this.hideLoading();
                }
            })
            .catch(error => {
                console.log('All domain member detection methods failed:', error);
                this.updateDomainStatus(null);
                if (!isInitialLoad) {
                    this.hideLoading();
                }
            });
    }

    async getDomainSiteInfo(domain) {
        try {
            console.log('Getting site information for domain:', domain);

            // First try to get site info from samba-tool
            try {
                // Get current server name
                const hostname = await cockpit.spawn(['hostname', '-s'], { superuser: "try" });
                const serverName = hostname.trim();

                // Try LDAP query to find current server's site
                const domainDN = domain.split('.').map(part => `DC=${part}`).join(',');
                const ldapOutput = await cockpit.spawn([
                    'ldapsearch', '-x', '-H', 'ldap://localhost',
                    '-b', `CN=Sites,CN=Configuration,${domainDN}`,
                    `(cn=${serverName})`, 'distinguishedName'
                ], { superuser: "try" });

                // Parse LDAP output to extract site name
                const siteMatch = ldapOutput.match(/CN=[^,]+,CN=Servers,CN=([^,]+),CN=Sites/);
                if (siteMatch && siteMatch[1]) {
                    console.log('Found site from LDAP query:', siteMatch[1]);
                    return siteMatch[1];
                }
            } catch (ldapError) {
                console.log('Failed to get site info via LDAP:', ldapError);
            }

            // Fallback: try samba-tool sites list and find current server
            try {
                const sitesOutput = await cockpit.spawn(['samba-tool', 'sites', 'list'], { superuser: "try" });
                console.log('Available sites:', sitesOutput);

                // If we have sites other than default, try to determine which one
                const sites = sitesOutput.split('\n').filter(site => site.trim() && site !== 'Default-First-Site-Name');
                if (sites.length > 0) {
                    // For now, return the first non-default site
                    // In a real implementation, you'd need more logic to determine the correct site
                    console.log('Using first available site:', sites[0]);
                    return sites[0].trim();
                }
            } catch (sitesError) {
                console.log('Failed to get sites list:', sitesError);
            }

            // Final fallback
            return 'Default-First-Site-Name';
        } catch (error) {
            console.log('Failed to get site info:', error);
            return 'Default-First-Site-Name';
        }
    }

    setupThemeListener() {
        // Get storage mechanism (localStorage preferred, sessionStorage fallback)
        let storage;
        try {
            storage = window.localStorage;
        } catch(e) {
            storage = window.sessionStorage;
        }

        const handleThemeChange = () => {
            // Get current theme setting from shell:style
            const themeSetting = storage.getItem('shell:style') || 'auto';
            const systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

            // Apply theme logic same as cockpit shell
            const shouldBeDark = (themeSetting === 'dark') || (themeSetting === 'auto' && systemDark);

            if (shouldBeDark) {
                document.documentElement.classList.add('pf-v5-theme-dark');
            } else {
                document.documentElement.classList.remove('pf-v5-theme-dark');
            }

            console.log('Theme changed to:', shouldBeDark ? 'dark' : 'light', '(setting:', themeSetting + ')');
        };

        // Listen for system theme changes
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        mediaQuery.addEventListener('change', handleThemeChange);

        // Listen for storage changes (theme preference changes)
        window.addEventListener('storage', (e) => {
            if (e.key === 'shell:style') {
                handleThemeChange();
            }
        });

        // Also listen for manual theme changes by observing the document element
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                    const isDark = document.documentElement.classList.contains('pf-v5-theme-dark');
                    console.log('Document theme class changed:', isDark ? 'dark' : 'light');
                }
            });
        });

        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class']
        });

        // Initial theme detection and application
        handleThemeChange();
    }

    showError(message) {
        // In a real implementation, this would show a proper toast notification
        // For now, using alert as placeholder
        alert(message);
    }

    showSuccess(message) {
        // In a real implementation, this would show a proper toast notification
        // For now, using alert as placeholder
        alert(message);

        // Auto-refresh domain status for FSMO-related success messages
        if (message.toLowerCase().includes('role') &&
            (message.toLowerCase().includes('seized') ||
             message.toLowerCase().includes('transferred'))) {
            console.log('FSMO-related success detected, scheduling domain status refresh...');
            setTimeout(() => {
                console.log('Auto-refreshing domain status after FSMO success...');
                this.checkDomainStatus();
            }, 3000); // Wait 3 seconds to let user see the success message
        }
    }

    configureNTPForPDC(ntpServers = null) {
        console.log('Configuring NTP for PDC Emulator (primary domain controller)');

        // Parse NTP servers (comma-separated) or use defaults
        const defaultServers = 'time.cloudflare.com,time.google.com,pool.ntp.org,time.nist.gov';
        const serverList = (ntpServers || defaultServers).split(',').map(s => s.trim()).filter(s => s);

        // Build NTP configuration
        const serverLines = serverList.map(server => `pool ${server} iburst`).join('\n');

        // PDC should get time from external reliable sources
        const ntpConfig = `
# NTP configuration for PDC Emulator (added by cockpit-domain-controller)
# External NTP sources
${serverLines}

# Allow time serving to domain clients
allow all

# Serve time even if not synchronized to external sources
local stratum 10
`;

        // Append NTP configuration to chrony.conf
        const configCommand = `echo '${ntpConfig}' >> /etc/chrony/chrony.conf`;

        return cockpit.spawn(['sh', '-c', configCommand], { superuser: "try" })
            .then(() => {
                console.log('NTP configuration added to chrony.conf');
                // Restart chrony service to apply changes
                return cockpit.spawn(['systemctl', 'restart', 'chrony'], { superuser: "try" });
            })
            .then(() => {
                console.log('Chrony service restarted successfully');
            })
            .catch(error => {
                console.error('Failed to configure NTP for PDC:', error);
            });
    }

    configureNTPForAdditionalDC(pdcIP, ntpServers = null) {
        console.log('Configuring NTP for additional domain controller, PDC IP:', pdcIP);

        // Parse fallback NTP servers (comma-separated) or use defaults
        const defaultServers = 'time.cloudflare.com,time.google.com';
        const serverList = (ntpServers || defaultServers).split(',').map(s => s.trim()).filter(s => s);

        // Build fallback NTP configuration
        const fallbackLines = serverList.map(server => `pool ${server} iburst`).join('\n');

        // Additional DCs should get time from the PDC Emulator
        const ntpConfig = `
# NTP configuration for additional domain controller (added by cockpit-domain-controller)
# Get time from PDC Emulator
server ${pdcIP} iburst prefer

# Fallback external sources in case PDC is unavailable
${fallbackLines}

# Allow time serving to domain clients
allow all

# Serve time even if not synchronized to external sources
local stratum 10
`;

        // Append NTP configuration to chrony.conf
        const configCommand = `echo '${ntpConfig}' >> /etc/chrony/chrony.conf`;

        return cockpit.spawn(['sh', '-c', configCommand], { superuser: "try" })
            .then(() => {
                console.log('NTP configuration added to chrony.conf');
                // Restart chrony service to apply changes
                return cockpit.spawn(['systemctl', 'restart', 'chrony'], { superuser: "try" });
            })
            .then(() => {
                console.log('Chrony service restarted successfully');
            })
            .catch(error => {
                console.error('Failed to configure NTP for additional DC:', error);
            });
    }

    createCustomAdminUser(username, password, domainName) {
        console.log('Creating custom admin user:', username);

        return cockpit.spawn([
            'samba-tool', 'user', 'create', username, password,
            '--description=Custom Domain Administrator'
        ], { superuser: "try" })
            .then(() => {
                console.log('Custom admin user created');
                // Add to Domain Admins group
                return cockpit.spawn([
                    'samba-tool', 'group', 'addmembers', 'Domain Admins', username
                ], { superuser: "try" });
            })
            .then(() => {
                console.log('Custom admin user added to Domain Admins group');
                // Add to Enterprise Admins group
                return cockpit.spawn([
                    'samba-tool', 'group', 'addmembers', 'Enterprise Admins', username
                ], { superuser: "try" });
            })
            .then(() => {
                console.log('Custom admin user added to Enterprise Admins group');
            })
            .catch(error => {
                console.error('Failed to create custom admin user:', error);
                throw error;
            });
    }

    checkAndUpdateNTPForFSMO(ntpServers = null) {
        console.log('Checking FSMO roles and updating NTP configuration accordingly');

        // Check if this DC holds the PDC Emulator role
        return cockpit.spawn(['samba-tool', 'fsmo', 'show'], { superuser: "try" })
            .then(output => {
                console.log('FSMO roles output:', output);

                // Parse the output to see if this server holds PDC Emulator role
                const lines = output.split('\n');
                const pdcLine = lines.find(line => line.includes('PdcRole'));

                if (pdcLine) {
                    // Extract the server name that holds the PDC role
                    const match = pdcLine.match(/PdcRole owner: (.+)/);
                    if (match) {
                        const pdcOwner = match[1].trim();

                        // Get this server's hostname
                        return cockpit.spawn(['hostname', '-f'], { superuser: "try" })
                            .then(hostname => {
                                const thisServer = hostname.trim();
                                console.log('PDC Emulator owner:', pdcOwner, 'This server:', thisServer);

                                if (pdcOwner.toLowerCase().includes(thisServer.toLowerCase()) ||
                                    thisServer.toLowerCase().includes(pdcOwner.toLowerCase())) {
                                    console.log('This server holds PDC Emulator role - configuring as PDC');
                                    return this.reconfigureNTPForPDC(ntpServers);
                                } else {
                                    console.log('This server does not hold PDC Emulator role - configuring as additional DC');
                                    // Try to get the PDC IP address
                                    return this.getPDCIPAddress().then(pdcIP => {
                                        if (pdcIP) {
                                            return this.reconfigureNTPForAdditionalDC(pdcIP, ntpServers);
                                        } else {
                                            console.log('Could not determine PDC IP, using external sources');
                                            return this.reconfigureNTPForPDC(ntpServers); // Fallback to external sources
                                        }
                                    });
                                }
                            });
                    }
                }

                console.log('Could not determine PDC Emulator role, using external sources');
                return this.reconfigureNTPForPDC(ntpServers); // Fallback
            })
            .catch(error => {
                console.error('Failed to check FSMO roles:', error);
                console.log('Fallback: configuring NTP with external sources');
                return this.reconfigureNTPForPDC(ntpServers); // Fallback
            });
    }

    getPDCIPAddress() {
        // Try to resolve the PDC Emulator's IP address
        return cockpit.spawn(['samba-tool', 'fsmo', 'show'], { superuser: "try" })
            .then(output => {
                const lines = output.split('\n');
                const pdcLine = lines.find(line => line.includes('PdcRole'));

                if (pdcLine) {
                    const match = pdcLine.match(/PdcRole owner: (.+)/);
                    if (match) {
                        const pdcServer = match[1].trim();

                        // Try to resolve the PDC server name to IP
                        return cockpit.spawn(['getent', 'hosts', pdcServer], { superuser: "try" })
                            .then(hostOutput => {
                                const ip = hostOutput.trim().split(/\s+/)[0];
                                console.log('Resolved PDC IP:', ip);
                                return ip;
                            })
                            .catch(error => {
                                console.log('Could not resolve PDC IP via getent:', error);
                                return null;
                            });
                    }
                }
                return null;
            })
            .catch(error => {
                console.error('Failed to get PDC IP address:', error);
                return null;
            });
    }

    async reconfigureNTPForPDC(ntpServers = null) {
        console.log('Reconfiguring NTP for PDC Emulator role using SYSVOL orchestrator');

        try {
            // Use SYSVOL-based orchestrator for NTP configuration
            await this.sysvolManager.triggerOrchestration('ntp');
            console.log('NTP reconfiguration completed via SYSVOL orchestrator');
        } catch (error) {
            console.error('Failed to reconfigure NTP via orchestrator, falling back to direct config:', error);

            // Fallback to direct configuration
            return cockpit.spawn(['sed', '-i', '/# NTP configuration.*added by cockpit-domain-controller/,/^$/d', '/etc/chrony/chrony.conf'], { superuser: "try" })
                .then(() => {
                    return this.configureNTPForPDC(ntpServers);
                })
                .catch(error => {
                    console.error('Failed to reconfigure NTP for PDC:', error);
                });
        }
    }

    async reconfigureNTPForAdditionalDC(pdcIP, ntpServers = null) {
        console.log('Reconfiguring NTP for additional DC role using SYSVOL orchestrator, PDC IP:', pdcIP);

        try {
            // Use SYSVOL-based orchestrator for NTP configuration
            await this.sysvolManager.triggerOrchestration('ntp');
            console.log('NTP reconfiguration completed via SYSVOL orchestrator');
        } catch (error) {
            console.error('Failed to reconfigure NTP via orchestrator, falling back to direct config:', error);

            // Fallback to direct configuration
            return cockpit.spawn(['sed', '-i', '/# NTP configuration.*added by cockpit-domain-controller/,/^$/d', '/etc/chrony/chrony.conf'], { superuser: "try" })
                .then(() => {
                    return this.configureNTPForAdditionalDC(pdcIP, ntpServers);
                })
                .catch(error => {
                    console.error('Failed to reconfigure NTP for additional DC:', error);
                });
        }
    }

    // handleNTPFSMOUpdate() method removed - NTP is now handled automatically based on FSMO roles

    updateNTPStatus(message, type) {
        const statusText = document.getElementById('ntp-status');
        if (statusText) {
            statusText.textContent = message;
            statusText.className = 'ntp-status-text' + (type ? ' ' + type : '');
        }
    }

    checkAndUpdateNTPForFSMOWithFeedback() {
        console.log('Checking FSMO roles and updating NTP configuration with user feedback');

        this.updateNTPStatus(_("Checking current FSMO roles..."), 'updating');

        // Check if this DC holds the PDC Emulator role
        return cockpit.spawn(['samba-tool', 'fsmo', 'show'], { superuser: "try" })
            .then(output => {
                console.log('FSMO roles output:', output);

                // Parse the output to see if this server holds PDC Emulator role
                const lines = output.split('\n');
                const pdcLine = lines.find(line => line.includes('PdcRole'));

                if (pdcLine) {
                    // Extract the server name that holds the PDC role
                    const match = pdcLine.match(/PdcRole owner: (.+)/);
                    if (match) {
                        const pdcOwner = match[1].trim();

                        this.updateNTPStatus(_("Determining server role..."), 'updating');

                        // Get this server's hostname
                        return cockpit.spawn(['hostname', '-f'], { superuser: "try" })
                            .then(hostname => {
                                const thisServer = hostname.trim();
                                console.log('PDC Emulator owner:', pdcOwner, 'This server:', thisServer);

                                if (pdcOwner.toLowerCase().includes(thisServer.toLowerCase()) ||
                                    thisServer.toLowerCase().includes(pdcOwner.toLowerCase())) {
                                    this.updateNTPStatus(_("PDC Emulator: Adding external NTP servers to /etc/chrony/chrony.conf..."), 'updating');
                                    return this.reconfigureNTPForPDC();
                                } else {
                                    this.updateNTPStatus(_("Additional DC: Configuring chrony to use PDC Emulator for time..."), 'updating');
                                    // Try to get the PDC IP address
                                    return this.getPDCIPAddress().then(pdcIP => {
                                        if (pdcIP) {
                                            this.updateNTPStatus(_("Writing PDC Emulator (") + pdcIP + _(") to /etc/chrony/chrony.conf and restarting service..."), 'updating');
                                            return this.reconfigureNTPForAdditionalDC(pdcIP);
                                        } else {
                                            this.updateNTPStatus(_("Could not resolve PDC IP - adding external NTP servers instead..."), 'updating');
                                            return this.reconfigureNTPForPDC(); // Fallback to external sources
                                        }
                                    });
                                }
                            });
                    }
                }

                this.updateNTPStatus(_("Could not determine PDC role - using external sources..."), 'updating');
                return this.reconfigureNTPForPDC(); // Fallback
            })
            .catch(error => {
                console.error('Failed to check FSMO roles:', error);
                this.updateNTPStatus(_("FSMO check failed - using external sources..."), 'updating');
                return this.reconfigureNTPForPDC(); // Fallback
            });
    }

    async showCurrentNTPStatus() {
        try {
            // Get NTP status from SYSVOL and system
            const [sysvolSettings, systemSources] = await Promise.all([
                this.sysvolManager.readNTPConfig('settings').catch(() => null),
                cockpit.spawn(['chrony', 'sources'], { superuser: "try" }).catch(() => '')
            ]);

            console.log('Current NTP sources:', systemSources);
            console.log('SYSVOL NTP settings:', sysvolSettings);

            let statusMessage = "";

            if (sysvolSettings) {
                // Parse SYSVOL settings
                const roleMatch = sysvolSettings.match(/ROLE=(\w+)/);
                const generatedMatch = sysvolSettings.match(/GENERATED=([^\n]+)/);

                if (roleMatch) {
                    const role = roleMatch[1];
                    statusMessage = role === 'pdc' ?
                        _("PDC Emulator - External NTP sources (SYSVOL managed)") :
                        _("Additional DC - PDC time source (SYSVOL managed)");
                    if (generatedMatch) {
                        statusMessage += ` | Updated: ${generatedMatch[1].split('T')[0]}`;
                    }
                } else {
                    statusMessage = _("SYSVOL managed but role unknown");
                }
            } else {
                // Fall back to system analysis
                if (systemSources.includes('time.cloudflare.com') || systemSources.includes('time.google.com') || systemSources.includes('pool.ntp.org')) {
                    statusMessage = _("Using external NTP sources (PDC Emulator configuration)");
                } else {
                    statusMessage = _("Using domain controller time hierarchy");
                }
                statusMessage += " | Direct config";
            }

            this.updateNTPStatus(statusMessage, '');
        } catch (error) {
            console.log('Failed to check NTP sources:', error);
            this.updateNTPStatus(_("NTP status unknown - use Update NTP button to configure"), '');
        }
    }

    updateKerberosConfig(domainName, hostname) {
        console.log('Updating Kerberos configuration for domain:', domainName);

        const realm = domainName.toUpperCase();
        const domainLower = domainName.toLowerCase();
        const hostnameFull = hostname || `${cockpit.info.hostname}.${domainLower}`;

        const krb5Config = `[libdefaults]
default_realm = ${realm}
kdc_timesync = 1
ccache_type = 4
forwardable = true
proxiable = true
rdns = false
fcc-mit-ticketflags = true
udp_preference_limit = 0

[realms]
	${realm} = {
		kdc = ${hostnameFull}:88
		admin_server = ${hostnameFull}:749
		default_domain = ${domainLower}
	}

[domain_realm]
	.${domainLower} = ${realm}
	${domainLower} = ${realm}
`;

        return cockpit.file('/etc/krb5.conf', { superuser: "try" })
            .replace(krb5Config)
            .then(() => {
                console.log('Kerberos configuration updated successfully');
                return true;
            })
            .catch(error => {
                console.error('Failed to update Kerberos configuration:', error);
                throw error;
            });
    }

    // FSMO methods have been moved to modules/fsmo-manager.js
    // This class now delegates FSMO operations to the fsmoManager instance

    handleFSMORefresh() {
        const refreshButton = document.getElementById('refresh-fsmo');
        const originalIcon = refreshButton.innerHTML;

        // Show loading state
        refreshButton.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ' + _("Refreshing...");
        refreshButton.disabled = true;

        // Load FSMO roles
        this.fsmoManager.loadFSMORoles();

        // Reset button after 2 seconds
        setTimeout(() => {
            refreshButton.innerHTML = originalIcon;
            refreshButton.disabled = false;
        }, 2000);
    }

    forceDomainReplication() {
        const forceReplicationBtn = document.getElementById('force-replication');
        const originalIcon = forceReplicationBtn.innerHTML;

        // Show loading state
        forceReplicationBtn.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ' + _("Syncing...");
        forceReplicationBtn.disabled = true;

        // Force domain replication using samba-tool
        cockpit.spawn(['samba-tool', 'drs', 'replicate', '--full-sync'], { superuser: "try" })
            .then(output => {
                console.log('Domain replication forced successfully:', output);
                // Refresh FSMO roles after replication
                this.fsmoManager.loadFSMORoles();
            })
            .catch(error => {
                console.warn('Domain replication command failed:', error);
                // Still refresh FSMO roles to show current state
                this.fsmoManager.loadFSMORoles();
            })
            .finally(() => {
                // Reset button after operation completes
                setTimeout(() => {
                    forceReplicationBtn.innerHTML = originalIcon;
                    forceReplicationBtn.disabled = false;
                }, 1000);
            });
    }

    checkServiceStatus() {
        // Check core services
        this.checkIndividualService('samba-ad-dc', 'samba-status');
        this.checkIndividualService('chrony', 'ntp-service-status');

        // Check DHCP with intelligent handling
        this.checkDHCPServiceStatus();
    }

    checkDHCPServiceStatus() {
        const statusElement = document.getElementById('dhcp-status');
        if (!statusElement) return;

        statusElement.textContent = _("Checking...");
        statusElement.className = 'service-status-text checking';

        // First check if this DC should be running DHCP by checking FSMO roles
        this.shouldRunDHCP().then(shouldRun => {
            if (!shouldRun) {
                // This DC should not run DHCP (not PDC Emulator or not primary)
                statusElement.textContent = _("Not DHCP server");
                statusElement.className = 'service-status-text inactive';

                // DHCP FSMO status element left empty (no status text needed)
                return;
            }

            // This DC should run DHCP, check actual service status
            this.checkIndividualService('isc-dhcp-server', 'dhcp-status');
        }).catch(error => {
            console.log('Could not determine DHCP role, checking service anyway:', error);
            // Fallback to checking service status
            this.checkIndividualService('isc-dhcp-server', 'dhcp-status');
        });
    }

    async shouldRunDHCP() {
        try {
            // Check if this server holds the PDC Emulator role
            const output = await cockpit.spawn(['samba-tool', 'fsmo', 'show'], { superuser: "try", err: "ignore" });
            const lines = output.split('\n');
            const pdcLine = lines.find(line => line.includes('PdcEmulationMasterRole') || line.includes('PdcRole') || line.includes('PDC'));

            if (pdcLine) {
                try {
                    const hostname = await cockpit.spawn(['hostname', '-f'], { err: "ignore" });
                    const currentHost = hostname.trim().toLowerCase();

                    // Check if this host is mentioned in the PDC line
                    return pdcLine.toLowerCase().includes(currentHost) ||
                           pdcLine.toLowerCase().includes(currentHost.split('.')[0]);
                } catch (hostnameError) {
                    console.log('Could not get hostname for DHCP check:', hostnameError);
                    // Try hostname -s as fallback
                    try {
                        const shortHostname = await cockpit.spawn(['hostname', '-s'], { err: "ignore" });
                        const currentHost = shortHostname.trim().toLowerCase();
                        return pdcLine.toLowerCase().includes(currentHost);
                    } catch (shortHostnameError) {
                        console.log('Could not get short hostname either:', shortHostnameError);
                        return false;
                    }
                }
            }

            return false; // Default to not running DHCP
        } catch (error) {
            console.log('Could not check FSMO roles for DHCP decision:', error);

            // Fallback: Check if DHCP is actually configured and should run
            try {
                await cockpit.file('/etc/dhcp/dhcpd.conf').read();
                console.log('DHCP config exists, assuming should run');
                return true;
            } catch (configError) {
                console.log('No DHCP config found, should not run');
                return false;
            }
        }
    }

    checkIndividualService(serviceName, statusElementId) {
        const statusElement = document.getElementById(statusElementId);
        statusElement.textContent = _("Checking...");
        statusElement.className = 'service-status-text checking';

        // Get detailed service status
        cockpit.spawn(['systemctl', 'status', serviceName], { superuser: "try" })
            .then(output => {
                const lines = output.split('\n');
                const activeLine = lines.find(line => line.includes('Active:'));

                if (activeLine) {
                    if (activeLine.includes('active (running)')) {
                        statusElement.textContent = _("Running");
                        statusElement.className = 'service-status-text running';
                    } else if (activeLine.includes('inactive (dead)')) {
                        // Check for condition failures (samba-ad-dc specific)
                        const conditionLine = lines.find(line => line.includes('Condition:') || line.includes('start condition failed'));
                        if (conditionLine && serviceName === 'samba-ad-dc') {
                            statusElement.textContent = _("Not configured");
                            statusElement.className = 'service-status-text warning';
                        } else {
                            statusElement.textContent = _("Stopped");
                            statusElement.className = 'service-status-text stopped';
                        }
                    } else if (activeLine.includes('failed')) {
                        statusElement.textContent = _("Failed (needs config)");
                        statusElement.className = 'service-status-text error';
                    } else {
                        statusElement.textContent = _("Unknown state");
                        statusElement.className = 'service-status-text warning';
                    }
                } else {
                    statusElement.textContent = _("Status unknown");
                    statusElement.className = 'service-status-text warning';
                }
            })
            .catch(error => {
                console.log(`Service status check failed for ${serviceName}:`, error);
                if (error.message && error.message.includes('could not be found')) {
                    statusElement.textContent = _("Not installed");
                    statusElement.className = 'service-status-text error';
                } else if (error.message && error.message.includes('permission') || error.exit_status === 4) {
                    statusElement.textContent = _("Permission denied");
                    statusElement.className = 'service-status-text warning';
                } else {
                    // More descriptive error with fallback check
                    statusElement.textContent = _("Unable to check status");
                    statusElement.className = 'service-status-text warning';

                    // Try a simple service existence check as fallback
                    cockpit.spawn(['systemctl', 'list-unit-files', serviceName], { err: 'ignore' })
                        .then(output => {
                            if (output.includes(serviceName)) {
                                statusElement.textContent = _("Installed (status unknown)");
                                statusElement.className = 'service-status-text warning';
                            } else {
                                statusElement.textContent = _("Not available");
                                statusElement.className = 'service-status-text error';
                            }
                        })
                        .catch(() => {
                            statusElement.textContent = _("Status unavailable");
                            statusElement.className = 'service-status-text error';
                        });
                }
            });
    }

    updateServiceLabelsForDomainMember() {
        // Update service labels for domain members
        const sambaServiceName = document.querySelector('.service-item .service-name');
        if (sambaServiceName && sambaServiceName.textContent.includes('Samba AD-DC')) {
            sambaServiceName.innerHTML = `<i class="fas fa-users"></i>${_("Domain Authentication (Winbind)")}`;
        }

        // Update restart button tooltip
        const restartSambaBtn = document.getElementById('restart-samba');
        if (restartSambaBtn) {
            restartSambaBtn.title = _("Restart winbind service");
        }
    }

    checkDomainMemberServices() {
        // For domain members, check relevant services like winbind and chrony
        this.checkIndividualService('winbind', 'samba-status');
        this.checkIndividualService('chrony', 'ntp-service-status');

        // Update DHCP status for domain members (domain members should not run DHCP server)
        const dhcpStatus = document.getElementById('dhcp-status');
        if (dhcpStatus) {
            dhcpStatus.textContent = _("Not applicable (Domain Member)");
            dhcpStatus.className = 'service-status-text inactive';
        }
    }

    handleServiceRestart(serviceName) {
        let buttonId, statusElementId;

        // Map service names to button and status element IDs
        const serviceMap = {
            'samba-ad-dc': { button: 'restart-samba', status: 'samba-status' },
            'winbind': { button: 'restart-samba', status: 'samba-status' }, // Domain members use winbind
            'chrony': { button: 'restart-ntp', status: 'ntp-service-status' },
            'isc-dhcp-server': { button: 'restart-dhcp', status: 'dhcp-status' }
        };

        if (!serviceMap[serviceName]) {
            console.error('Unknown service:', serviceName);
            return;
        }

        const restartButton = document.getElementById(serviceMap[serviceName].button);
        const statusElement = document.getElementById(serviceMap[serviceName].status);
        const originalIcon = restartButton.innerHTML;

        // Show loading state
        restartButton.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ' + _("Restarting...");
        restartButton.disabled = true;

        statusElement.textContent = _("Restarting...");
        statusElement.className = 'service-status-text checking';

        cockpit.spawn(['systemctl', 'restart', serviceName], { superuser: "try" })
            .then(() => {
                // Check status after restart
                setTimeout(() => {
                    this.checkIndividualService(serviceName, serviceMap[serviceName].status);
                }, 2000);

                // Reset button
                setTimeout(() => {
                    restartButton.innerHTML = originalIcon;
                    restartButton.disabled = false;
                }, 3000);
            })
            .catch(error => {
                statusElement.textContent = _("Restart failed");
                statusElement.className = 'service-status-text stopped';

                // Reset button
                setTimeout(() => {
                    restartButton.innerHTML = originalIcon;
                    restartButton.disabled = false;
                }, 3000);
            });
    }

    // DHCP Management Methods
    showDhcpManagement() {
        const dhcpSection = document.getElementById('dhcp-management');
        dhcpSection.classList.remove('hidden');

        // Load current DHCP status
        this.checkDhcpFsmoStatus();
    }

    hideDhcpManagement() {
        const dhcpSection = document.getElementById('dhcp-management');
        dhcpSection.classList.add('hidden');
    }

    checkDhcpFsmoStatus() {
        const failoverElement = document.getElementById('dhcp-failover-status');
        const activeServerElement = document.getElementById('dhcp-active-server');
        const fsmoIndicator = document.getElementById('dhcp-fsmo-indicator');

        // Return early if essential elements don't exist (simplified UI)
        if (!failoverElement) {
            return;
        }

        // Check PDC Emulator role
        cockpit.spawn(['samba-tool', 'fsmo', 'show'], { superuser: "try" })
            .then(output => {
                const lines = output.split('\n');
                const pdcLine = lines.find(line => line.includes('PdcEmulationMasterRole owner:'));

                if (pdcLine) {
                    const pdcHolder = pdcLine.split(':')[1].trim();
                    const serverName = this.extractServerName(pdcHolder);

                    if (activeServerElement) {
                        activeServerElement.textContent = serverName;
                    }

                    // Check if this server is PDC
                    const thisServer = window.location.hostname;
                    const isPdc = pdcHolder.includes(thisServer);

                    if (isPdc) {
                        failoverElement.textContent = _("Active (PDC)");
                        if (fsmoIndicator) fsmoIndicator.classList.remove('hidden');
                    } else {
                        failoverElement.textContent = _("Standby (non-PDC)");
                        if (fsmoIndicator) fsmoIndicator.classList.add('hidden');
                    }
                } else {
                    if (activeServerElement) activeServerElement.textContent = _("Unknown");
                    failoverElement.textContent = _("Cannot determine");
                }
            })
            .catch(error => {
                if (activeServerElement) activeServerElement.textContent = _("Error");
                failoverElement.textContent = _("Check failed");
            });

        // Check SYSVOL backup status
        this.checkSysvolBackup();
    }

    checkSysvolBackup() {
        const syncStatusElement = document.getElementById('dhcp-sync-status');

        // Return early if element doesn't exist (simplified UI)
        if (!syncStatusElement) {
            return;
        }

        cockpit.spawn(['ls', '-la', '/var/lib/samba/sysvol/*/dhcp-configs/'], { superuser: "try" })
            .then(output => {
                if (output.includes('dhcpd.conf.active')) {
                    syncStatusElement.textContent = _("Synced");
                } else {
                    syncStatusElement.textContent = _("Not synced");
                }
            })
            .catch(error => {
                syncStatusElement.textContent = _("Check failed");
            });
    }

    async syncDhcpConfig() {
        const button = document.getElementById('sync-dhcp-config');
        const originalText = button.innerHTML;

        button.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ' + _("Syncing...");
        button.disabled = true;

        try {
            // Read the DHCP configuration from SYSVOL
            const sysvolConfig = await this.sysvolManager.readDHCPConfig('active');

            if (sysvolConfig) {
                // Deploy configuration to local DHCP server
                await cockpit.spawn(['tee', '/etc/dhcp/dhcpd.conf'], {
                    superuser: "try",
                    input: sysvolConfig
                });

                // Test configuration syntax
                await cockpit.spawn(['dhcpd', '-t', '-cf', '/etc/dhcp/dhcpd.conf'], {
                    superuser: "try"
                });

                // Restart DHCP service to apply changes
                await cockpit.spawn(['systemctl', 'restart', 'isc-dhcp-server'], {
                    superuser: "try"
                });

                this.showSuccess(_("DHCP configuration synced from SYSVOL and applied"));
                this.checkSysvolBackup();
            } else {
                // If no SYSVOL config exists, upload current local config to SYSVOL
                const localConfig = await cockpit.spawn(['cat', '/etc/dhcp/dhcpd.conf'], {
                    superuser: "try"
                });

                await this.sysvolManager.writeDHCPConfig(localConfig, 'active');
                this.showSuccess(_("Local DHCP configuration uploaded to SYSVOL for replication"));
            }
        } catch (error) {
            console.error('DHCP sync error:', error);
            this.showError(_("Failed to sync DHCP configuration: ") + error.message);
        } finally {
            setTimeout(() => {
                button.innerHTML = originalText;
                button.disabled = false;
            }, 2000);
        }
    }

    forceDhcpFailover() {
        const button = document.getElementById('force-dhcp-failover');
        const originalText = button.innerHTML;

        button.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ' + _("Processing...");
        button.disabled = true;

        cockpit.spawn(['/usr/local/bin/dhcp-fsmo-manager.sh'], { superuser: "try" })
            .then(() => {
                this.showSuccess(_("DHCP failover check completed"));
                // Refresh all status
                setTimeout(() => {
                    this.checkServiceStatus();
                    this.checkDhcpFsmoStatus();
                }, 2000);
            })
            .catch(error => {
                this.showError(_("DHCP failover failed: ") + error.message);
            })
            .finally(() => {
                setTimeout(() => {
                    button.innerHTML = originalText;
                    button.disabled = false;
                }, 3000);
            });
    }

    refreshDhcpLogs() {
        // Simplified UI doesn't have a logs display, this method is not needed
        // Return early to prevent errors
        return;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Extract server name from Active Directory Distinguished Name
    extractServerName(dn) {
        // Try to extract server name from DN format
        // CN=NTDS Settings,CN=DEBIAN,CN=Servers,CN=Default-First-Site-Name,CN=Sites,CN=Configuration,DC=guedry,DC=local

        if (!dn || typeof dn !== 'string') {
            return dn;
        }

        // Look for CN=servername pattern after CN=NTDS Settings
        const match = dn.match(/CN=NTDS Settings,CN=([^,]+)/);
        if (match) {
            return match[1];
        }

        // Fallback: look for any CN= pattern that might be a server name
        const cnMatch = dn.match(/CN=([^,]+)/);
        if (cnMatch) {
            const cn = cnMatch[1];
            // Skip common AD component names
            if (!['NTDS Settings', 'Servers', 'Sites', 'Configuration'].includes(cn)) {
                return cn;
            }
        }

        // If no pattern matches, return the full DN but truncated
        if (dn.length > 50) {
            return dn.substring(0, 47) + '...';
        }

        return dn;
    }

    // DHCP Configuration Methods
    setupDhcpConfiguration(domainName, interfaceIP, interfaceInfo, customOptions = {}) {
        console.log('Setting up DHCP configuration for domain:', domainName);

        // Check if DHCP server package is installed
        return cockpit.spawn(['dpkg', '-l', 'isc-dhcp-server'], { superuser: "try" })
            .then(() => {
                console.log('DHCP server package is installed');
                return this.doSetupDhcpConfiguration(domainName, interfaceIP, interfaceInfo, customOptions);
            })
            .catch(() => {
                throw new Error('DHCP server package (isc-dhcp-server) is not installed');
            });
    }

    doSetupDhcpConfiguration(domainName, interfaceIP, interfaceInfo, customOptions = {}) {
        console.log('Proceeding with DHCP configuration setup...');

        // Get actual network information from routing table and interface details
        return cockpit.spawn(['ip', 'route', 'show', 'default'], { superuser: "try" })
            .then(routeOutput => {
                const gatewayMatch = routeOutput.match(/default via ([0-9.]+)/);
                const actualGateway = gatewayMatch ? gatewayMatch[1] : interfaceIP.split('.').slice(0, 3).join('.') + '.254';

                // Extract network information from the actual IP address
                const ipParts = interfaceIP.split('.');
                const networkBase = ipParts.slice(0, 3).join('.');
                const netmask = '255.255.255.0';
                const network = networkBase + '.0';
                const broadcast = networkBase + '.255';

                // Use custom DHCP range if provided, otherwise auto-detect based on actual network
                const rangeStart = customOptions.rangeStart || `${networkBase}.100`;
                const rangeEnd = customOptions.rangeEnd || `${networkBase}.200`;
                const leaseTime = customOptions.leaseTime || '600';
                const maxLeaseTime = (parseInt(leaseTime) * 12).toString(); // Max is 12x default
                const dhcpRange = `${rangeStart} ${rangeEnd}`;

                // Get MAC address from interface info
                const macAddress = interfaceInfo.mac || '08:00:27:c9:d8:89';

                // Validate input parameters
                if (!domainName || !interfaceIP || !interfaceInfo) {
                    throw new Error('Missing required parameters for DHCP configuration');
                }

                const dhcpConfig = `# DHCP Configuration for ${domainName}
# Generated automatically during domain provisioning
# Managed by cockpit-domain-controller
# Last updated: ${new Date().toISOString()}

# Global settings
default-lease-time ${leaseTime};
max-lease-time ${maxLeaseTime};
ddns-update-style none;
authoritative;

# Domain settings
option domain-name "${domainName}";
option domain-name-servers ${interfaceIP};

# Log to local7 facility
log-facility local7;

# Subnet configuration for ${network}/${netmask}
subnet ${network} netmask ${netmask} {
    range ${dhcpRange};
    option routers ${actualGateway};
    option domain-name-servers ${interfaceIP};
    option domain-name "${domainName}";
    option broadcast-address ${broadcast};
    default-lease-time ${leaseTime};
    max-lease-time ${maxLeaseTime};
}

# Reserve IP for domain controller
host dc-server {
    hardware ethernet ${macAddress};
    fixed-address ${interfaceIP};
}
`;

                // Store DHCP configuration in LDAP
                const dhcpLdif = `# DHCP Configuration Object for ${domainName}
# This stores DHCP settings in Active Directory for replication
dn: CN=DHCP-Config,CN=Configuration,DC=${domainName.split('.').join(',DC=')}
objectClass: top
objectClass: container
cn: DHCP-Config
description: DHCP Configuration for ${domainName}
extensionName: DhcpConfig
extensionData: ${btoa(dhcpConfig)}
dhcpSubnet: ${network}
dhcpNetmask: ${netmask}
dhcpRangeStart: ${rangeStart}
dhcpRangeEnd: ${rangeEnd}
dhcpGateway: ${actualGateway}
dhcpDnsServers: ${interfaceIP}
dhcpDomainName: ${domainName}
dhcpLeaseTime: ${leaseTime}
dhcpMaxLeaseTime: ${maxLeaseTime}
whenCreated: ${new Date().toISOString()}
`;

                // First create SYSVOL directories and store config there too
                return cockpit.spawn(['mkdir', '-p', `/var/lib/samba/sysvol/${domainName}/dhcp-configs`], { superuser: "try" })
                    .then(() => {
                        // Store in SYSVOL for backwards compatibility
                        return cockpit.spawn(['tee', `/var/lib/samba/sysvol/${domainName}/dhcp-configs/dhcpd.conf.active`], {
                            superuser: "try"
                        }).input(dhcpConfig);
                    })
                    .then(() => {
                        // Store DHCP settings in a simple config file for FSMO managers
                        const dhcpSettings = `# DHCP Settings for ${domainName}
DHCP_SUBNET=${network}
DHCP_NETMASK=${netmask}
DHCP_RANGE_START=${rangeStart}
DHCP_RANGE_END=${rangeEnd}
DHCP_GATEWAY=${actualGateway}
DHCP_DNS_SERVERS=${interfaceIP}
DHCP_DOMAIN_NAME=${domainName}
DHCP_LEASE_TIME=${leaseTime}
DHCP_MAX_LEASE_TIME=${maxLeaseTime}
DHCP_LAST_UPDATED=${new Date().toISOString()}
`;
                        return cockpit.spawn(['tee', `/var/lib/samba/sysvol/${domainName}/dhcp-configs/dhcp-settings.conf`], {
                            superuser: "try"
                        }).input(dhcpSettings);
                    })
                    .then(() => {
                        // Copy configuration to system location
                        return cockpit.spawn(['cp', `/var/lib/samba/sysvol/${domainName}/dhcp-configs/dhcpd.conf.active`, '/etc/dhcp/dhcpd.conf'], {
                            superuser: "try"
                        });
                    })
                    .then(() => {
                        // Configure DHCP server interface - verify interface exists
                        const interfaceName = interfaceInfo.name || 'enp0s3';
                        console.log('Configuring DHCP for interface:', interfaceName);
                        const dhcpDefaults = `# Defaults for isc-dhcp-server (sourced by /etc/init.d/isc-dhcp-server)

# Path to dhcpd's config file (default: /etc/dhcp/dhcpd.conf).
#DHCPDv4_CONF=/etc/dhcp/dhcpd.conf
#DHCPDv6_CONF=/etc/dhcp/dhcpd6.conf

# Path to dhcpd's PID file (default: /var/run/dhcpd.pid).
#DHCPDv4_PID=/var/run/dhcpd.pid
#DHCPDv6_PID=/var/run/dhcpd6.pid

# Additional options to start dhcpd with.
#	Don't use options -cf or -pf here; use DHCPD_CONF/ DHCPD_PID instead
#OPTIONS=""

# On what interfaces should the DHCP server (dhcpd) serve DHCP requests?
#	Separate multiple interfaces with spaces, e.g. "eth0 eth1".
INTERFACESv4="${interfaceName}"
INTERFACESv6=""
`;
                        return cockpit.spawn(['tee', '/etc/default/isc-dhcp-server'], {
                            superuser: "try"
                        }).input(dhcpDefaults);
                    })
                    .then(() => {
                        // Validate DHCP configuration before starting service
                        return cockpit.spawn(['/usr/sbin/dhcpd', '-t', '-cf', '/etc/dhcp/dhcpd.conf'], {
                            superuser: "try"
                        }).catch(validationError => {
                            console.error('DHCP configuration validation failed:', validationError);
                            throw new Error('DHCP configuration is invalid: ' + validationError.message);
                        });
                    })
                    .then(() => {
                        // Stop any existing DHCP service first
                        return cockpit.spawn(['systemctl', 'stop', 'isc-dhcp-server'], { superuser: "try" })
                            .catch(() => {
                                // Service might not be running, that's okay
                                console.log('DHCP service was not running');
                            });
                    })
                    .then(() => {
                        // Unmask the service in case it was masked
                        return cockpit.spawn(['systemctl', 'unmask', 'isc-dhcp-server'], { superuser: "try" })
                            .catch(() => {
                                // Service might not be masked, that's okay
                                console.log('DHCP service was not masked');
                            });
                    })
                    .then(() => {
                        // Enable DHCP service
                        return cockpit.spawn(['systemctl', 'enable', 'isc-dhcp-server'], { superuser: "try" });
                    })
                    .then(() => {
                        // Start DHCP service with detailed error reporting
                        return cockpit.spawn(['systemctl', 'start', 'isc-dhcp-server'], { superuser: "try" })
                            .catch(startError => {
                                console.error('DHCP service start failed:', startError);
                                // Get detailed error information
                                return cockpit.spawn(['journalctl', '-u', 'isc-dhcp-server', '--no-pager', '-n', '20'], { superuser: "try" })
                                    .then(logs => {
                                        console.error('DHCP service logs:', logs);
                                        throw new Error('DHCP service failed to start. Check logs: ' + logs);
                                    })
                                    .catch(() => {
                                        throw new Error('DHCP service failed to start: ' + startError.message);
                                    });
                            });
                    })
                    .then(() => {
                        console.log('DHCP configuration stored in LDAP and activated successfully');
                        return Promise.resolve();
                    });
            })
            .catch(error => {
                console.error('DHCP configuration failed:', error);
                // Show specific error to user but don't fail provisioning
                this.showError('DHCP setup failed: ' + (error.message || 'Unknown error'));
                return Promise.resolve();
            });
    }

    // DHCP Configuration Editor Methods
    showDhcpEditor() {
        const modal = document.getElementById('dhcp-config-modal');
        modal.removeAttribute('hidden');

        // Load current DHCP configuration
        this.loadDhcpConfig();
    }

    hideDhcpEditor() {
        const modal = document.getElementById('dhcp-config-modal');
        modal.setAttribute('hidden', '');
    }

    loadDhcpConfig() {
        // Try to load DHCP configuration from LDAP first
        cockpit.spawn(['ldbsearch', '-H', '/var/lib/samba/private/sam.ldb', '(cn=DHCP-Config)', 'dhcpSubnet', 'dhcpNetmask', 'dhcpRangeStart', 'dhcpRangeEnd', 'dhcpGateway', 'dhcpDnsServers', 'dhcpDomainName', 'dhcpLeaseTime', 'dhcpMaxLeaseTime'], { superuser: "try" })
            .then(ldapOutput => {
                if (ldapOutput && ldapOutput.includes('dhcpSubnet:')) {
                    this.parseDhcpLdapConfig(ldapOutput);
                } else {
                    // Fallback to file-based config
                    return cockpit.spawn(['cat', '/etc/dhcp/dhcpd.conf'], { superuser: "try" })
                        .then(config => {
                            this.parseDhcpConfig(config);
                        });
                }
            })
            .catch(error => {
                console.error('Failed to load DHCP config from LDAP, trying file:', error);
                // Fallback to file-based config
                cockpit.spawn(['cat', '/etc/dhcp/dhcpd.conf'], { superuser: "try" })
                    .then(config => {
                        this.parseDhcpConfig(config);
                    })
                    .catch(fileError => {
                        console.error('Failed to load DHCP config from file:', fileError);
                        // Load defaults if nothing works
                        this.loadDhcpDefaults();
                    });
            });
    }

    loadDhcpDefaults() {
        // Get actual domain information
        cockpit.spawn(['samba-tool', 'domain', 'info', 'localhost'], { superuser: "try" })
            .then(output => {
                const lines = output.split('\n');
                const domainLine = lines.find(line => line.includes('Domain') && line.includes(':'));
                const actualDomain = domainLine ? domainLine.split(':')[1].trim() : 'guedry.local';

                // Get current network information
                const interfaceInfo = this.networkInterfaces.find(iface => iface.name === 'enp0s3');
                const interfaceIP = interfaceInfo ? interfaceInfo.ips[0] : '192.168.1.174';
                const networkBase = interfaceIP.split('.').slice(0, 3).join('.');

                // Get actual gateway from routing table
                return cockpit.spawn(['ip', 'route', 'show', 'default'], { superuser: "try" })
                    .then(routeOutput => {
                        const gatewayMatch = routeOutput.match(/default via ([0-9.]+)/);
                        const actualGateway = gatewayMatch ? gatewayMatch[1] : networkBase + '.254';

                        // Set form values with actual detected values
                        document.getElementById('dhcp-domain-name').value = actualDomain;
                        document.getElementById('dhcp-dns-servers').value = interfaceIP;
                        document.getElementById('dhcp-subnet').value = networkBase + '.0';
                        document.getElementById('dhcp-netmask').value = '255.255.255.0';
                        document.getElementById('dhcp-range-start').value = networkBase + '.100';
                        document.getElementById('dhcp-range-end').value = networkBase + '.200';
                        document.getElementById('dhcp-gateway').value = actualGateway;
                        document.getElementById('dhcp-lease-time').value = '600';
                        document.getElementById('dhcp-max-lease-time').value = '7200';
                    });
            })
            .catch(error => {
                console.error('Failed to get domain info, using defaults:', error);

                // Fallback to basic network detection
                const interfaceInfo = this.networkInterfaces.find(iface => iface.name === 'enp0s3');
                const interfaceIP = interfaceInfo ? interfaceInfo.ips[0] : '192.168.1.174';
                const networkBase = interfaceIP.split('.').slice(0, 3).join('.');

                document.getElementById('dhcp-domain-name').value = 'guedry.local';
                document.getElementById('dhcp-dns-servers').value = interfaceIP;
                document.getElementById('dhcp-subnet').value = networkBase + '.0';
                document.getElementById('dhcp-netmask').value = '255.255.255.0';
                document.getElementById('dhcp-range-start').value = networkBase + '.100';
                document.getElementById('dhcp-range-end').value = networkBase + '.200';
                document.getElementById('dhcp-gateway').value = networkBase + '.254';
                document.getElementById('dhcp-lease-time').value = '600';
                document.getElementById('dhcp-max-lease-time').value = '7200';
            });
    }

    parseDhcpLdapConfig(ldapOutput) {
        // Parse DHCP configuration from LDAP output
        const lines = ldapOutput.split('\n');

        // Extract values from LDAP attributes
        const getValue = (attr) => {
            const line = lines.find(line => line.startsWith(attr + ':'));
            return line ? line.split(':')[1].trim() : '';
        };

        document.getElementById('dhcp-domain-name').value = getValue('dhcpDomainName');
        document.getElementById('dhcp-dns-servers').value = getValue('dhcpDnsServers');
        document.getElementById('dhcp-subnet').value = getValue('dhcpSubnet');
        document.getElementById('dhcp-netmask').value = getValue('dhcpNetmask');
        document.getElementById('dhcp-range-start').value = getValue('dhcpRangeStart');
        document.getElementById('dhcp-range-end').value = getValue('dhcpRangeEnd');
        document.getElementById('dhcp-gateway').value = getValue('dhcpGateway');
        document.getElementById('dhcp-lease-time').value = getValue('dhcpLeaseTime');
        document.getElementById('dhcp-max-lease-time').value = getValue('dhcpMaxLeaseTime');
    }

    parseDhcpConfig(config) {
        // Parse existing DHCP configuration
        const lines = config.split('\n');

        // Extract domain name
        const domainMatch = config.match(/option domain-name "([^"]+)"/);
        if (domainMatch) {
            document.getElementById('dhcp-domain-name').value = domainMatch[1];
        }

        // Extract DNS servers
        const dnsMatch = config.match(/option domain-name-servers ([^;]+);/);
        if (dnsMatch) {
            document.getElementById('dhcp-dns-servers').value = dnsMatch[1].trim();
        }

        // Extract subnet
        const subnetMatch = config.match(/subnet ([0-9.]+) netmask ([0-9.]+)/);
        if (subnetMatch) {
            document.getElementById('dhcp-subnet').value = subnetMatch[1];
            document.getElementById('dhcp-netmask').value = subnetMatch[2];
        }

        // Extract range
        const rangeMatch = config.match(/range ([0-9.]+) ([0-9.]+);/);
        if (rangeMatch) {
            document.getElementById('dhcp-range-start').value = rangeMatch[1];
            document.getElementById('dhcp-range-end').value = rangeMatch[2];
        }

        // Extract gateway
        const gatewayMatch = config.match(/option routers ([^;]+);/);
        if (gatewayMatch) {
            document.getElementById('dhcp-gateway').value = gatewayMatch[1].trim();
        }

        // Extract lease times
        const leaseMatch = config.match(/default-lease-time ([0-9]+);/);
        if (leaseMatch) {
            document.getElementById('dhcp-lease-time').value = leaseMatch[1];
        }

        const maxLeaseMatch = config.match(/max-lease-time ([0-9]+);/);
        if (maxLeaseMatch) {
            document.getElementById('dhcp-max-lease-time').value = maxLeaseMatch[1];
        }
    }

    saveDhcpConfig() {
        const button = document.getElementById('save-dhcp-config');
        const originalText = button.innerHTML;

        button.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ' + _("Saving...");
        button.disabled = true;

        // Get form values
        const domainName = document.getElementById('dhcp-domain-name').value.trim();
        const dnsServers = document.getElementById('dhcp-dns-servers').value.trim();
        const subnet = document.getElementById('dhcp-subnet').value.trim();
        const netmask = document.getElementById('dhcp-netmask').value.trim();
        const rangeStart = document.getElementById('dhcp-range-start').value.trim();
        const rangeEnd = document.getElementById('dhcp-range-end').value.trim();
        const gateway = document.getElementById('dhcp-gateway').value.trim();
        const leaseTime = document.getElementById('dhcp-lease-time').value.trim();
        const maxLeaseTime = document.getElementById('dhcp-max-lease-time').value.trim();

        // Validate inputs
        if (!domainName || !dnsServers || !subnet || !netmask || !rangeStart || !rangeEnd || !gateway) {
            this.showError(_("Please fill in all required fields"));
            button.innerHTML = originalText;
            button.disabled = false;
            return;
        }

        // Generate DHCP configuration
        const interfaceInfo = this.networkInterfaces.find(iface => iface.name === 'enp0s3');
        const interfaceIP = interfaceInfo ? interfaceInfo.ips[0] : '192.168.1.174';
        const broadcast = subnet.split('.').slice(0, 3).join('.') + '.255';

        const dhcpConfig = `# DHCP Configuration for ${domainName}
# Generated by cockpit-domain-controller configuration editor
# Last updated: ${new Date().toISOString()}

# Global settings
default-lease-time ${leaseTime};
max-lease-time ${maxLeaseTime};
ddns-update-style none;
authoritative;

# Domain settings
option domain-name "${domainName}";
option domain-name-servers ${dnsServers};

# Log to local7 facility
log-facility local7;

# Subnet configuration for ${subnet}/${netmask}
subnet ${subnet} netmask ${netmask} {
    range ${rangeStart} ${rangeEnd};
    option routers ${gateway};
    option domain-name-servers ${dnsServers};
    option domain-name "${domainName}";
    option broadcast-address ${broadcast};
    default-lease-time ${leaseTime};
    max-lease-time ${maxLeaseTime};
}

# Reserve IP for domain controller
host dc-server {
    hardware ethernet ${interfaceInfo?.mac || '08:00:27:c9:d8:89'};
    fixed-address ${interfaceIP};
}
`;

        // Store DHCP configuration in LDAP
        const dhcpLdif = `# DHCP Configuration Update for ${domainName}
dn: CN=DHCP-Config,CN=Configuration,DC=${domainName.split('.').join(',DC=')}
changetype: modify
replace: dhcpSubnet
dhcpSubnet: ${subnet}
-
replace: dhcpNetmask
dhcpNetmask: ${netmask}
-
replace: dhcpRangeStart
dhcpRangeStart: ${rangeStart}
-
replace: dhcpRangeEnd
dhcpRangeEnd: ${rangeEnd}
-
replace: dhcpGateway
dhcpGateway: ${gateway}
-
replace: dhcpDnsServers
dhcpDnsServers: ${dnsServers}
-
replace: dhcpDomainName
dhcpDomainName: ${domainName}
-
replace: dhcpLeaseTime
dhcpLeaseTime: ${leaseTime}
-
replace: dhcpMaxLeaseTime
dhcpMaxLeaseTime: ${maxLeaseTime}
-
replace: extensionData
extensionData: ${btoa(dhcpConfig)}
-
replace: whenCreated
whenCreated: ${new Date().toISOString()}
`;

        // Save configuration to SYSVOL and LDAP
        cockpit.spawn(['mkdir', '-p', `/var/lib/samba/sysvol/${domainName}/dhcp-configs`], { superuser: "try" })
            .then(() => {
                return cockpit.spawn(['tee', `/var/lib/samba/sysvol/${domainName}/dhcp-configs/dhcpd.conf.active`], {
                    superuser: "try"
                }).input(dhcpConfig);
            })
            .then(() => {
                // Save LDIF for LDAP update
                return cockpit.spawn(['tee', `/var/lib/samba/sysvol/${domainName}/dhcp-configs/dhcp-config-update.ldif`], {
                    superuser: "try"
                }).input(dhcpLdif);
            })
            .then(() => {
                // Update DHCP configuration in LDAP
                return cockpit.spawn(['ldbmodify', '-H', `/var/lib/samba/private/sam.ldb`, `/var/lib/samba/sysvol/${domainName}/dhcp-configs/dhcp-config-update.ldif`], {
                    superuser: "try"
                });
            })
            .then(() => {
                // Copy to system location
                return cockpit.spawn(['cp', `/var/lib/samba/sysvol/${domainName}/dhcp-configs/dhcpd.conf.active`, '/etc/dhcp/dhcpd.conf'], {
                    superuser: "try"
                });
            })
            .then(() => {
                // Restart DHCP service
                return cockpit.spawn(['systemctl', 'restart', 'isc-dhcp-server'], { superuser: "try" });
            })
            .then(() => {
                this.showSuccess(_("DHCP configuration updated in LDAP and deployed successfully!"));
                this.hideDhcpEditor();
                this.checkIndividualService('isc-dhcp-server', 'dhcp-status');
            })
            .catch(error => {
                console.error('DHCP configuration save failed:', error);
                this.showError(_("Failed to save DHCP configuration: ") + error.message);
            })
            .finally(() => {
                button.innerHTML = originalText;
                button.disabled = false;
            });
    }

    // NTP Management Methods
    showNtpManagement() {
        const ntpSection = document.getElementById('ntp-management');
        ntpSection.classList.remove('hidden');

        // Load current NTP status
        this.checkNtpFsmoStatus();
    }

    hideNtpManagement() {
        const ntpSection = document.getElementById('ntp-management');
        ntpSection.classList.add('hidden');
    }

    checkNtpFsmoStatus() {
        const roleElement = document.getElementById('ntp-role-status');
        const stratumElement = document.getElementById('ntp-stratum');
        const syncStatusElement = document.getElementById('ntp-sync-status');

        // Return early if elements don't exist
        if (!roleElement) {
            return;
        }

        // Check PDC Emulator role
        cockpit.spawn(['samba-tool', 'fsmo', 'show'], { superuser: "try" })
            .then(output => {
                const lines = output.split('\n');
                const pdcLine = lines.find(line => line.includes('PdcEmulationMasterRole owner:'));

                if (pdcLine) {
                    const pdcHolder = pdcLine.split(':')[1].trim();

                    // Check if this server is PDC
                    const thisServer = window.location.hostname;
                    const isPdc = pdcHolder.includes(thisServer);

                    if (isPdc) {
                        roleElement.textContent = _("PDC Emulator");
                        roleElement.className = 'summary-value success';
                        if (stratumElement) stratumElement.textContent = "10";
                    } else {
                        roleElement.textContent = _("Domain Controller");
                        roleElement.className = 'summary-value';
                        if (stratumElement) stratumElement.textContent = "11";
                    }

                    // Check NTP synchronization status
                    this.checkNtpSyncStatus();
                } else {
                    roleElement.textContent = _("Unknown");
                    roleElement.className = 'summary-value error';
                }
            })
            .catch(error => {
                roleElement.textContent = _("Error");
                roleElement.className = 'summary-value error';
                if (syncStatusElement) {
                    syncStatusElement.textContent = _("Check failed");
                    syncStatusElement.className = 'summary-value error';
                }
            });
    }

    checkNtpSyncStatus() {
        const syncStatusElement = document.getElementById('ntp-sync-status');
        if (!syncStatusElement) return;

        // Check chrony tracking to determine sync status
        cockpit.spawn(['chronyc', 'tracking'], { superuser: "try" })
            .then(output => {
                if (output.includes('Reference ID') && !output.includes('127.127.1.1')) {
                    syncStatusElement.textContent = _("Synchronized");
                    syncStatusElement.className = 'summary-value success';
                } else {
                    syncStatusElement.textContent = _("Local clock");
                    syncStatusElement.className = 'summary-value warning';
                }
            })
            .catch(error => {
                syncStatusElement.textContent = _("Unknown");
                syncStatusElement.className = 'summary-value error';
            });
    }

    syncNtpConfig() {
        const button = document.getElementById('sync-ntp-config');
        const originalText = button.innerHTML;

        button.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ' + _("Syncing...");
        button.disabled = true;

        cockpit.spawn(['/usr/local/bin/ntp-fsmo-manager.sh'], { superuser: "try" })
            .then(() => {
                this.showSuccess(_("NTP configuration synchronized based on FSMO role"));
                this.refreshNtpStatus();
            })
            .catch(error => {
                this.showError(_("Failed to sync NTP configuration: ") + error.message);
            })
            .finally(() => {
                setTimeout(() => {
                    button.innerHTML = originalText;
                    button.disabled = false;
                }, 2000);
            });
    }

    forceNtpFailover() {
        const button = document.getElementById('force-ntp-failover');
        const originalText = button.innerHTML;

        button.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ' + _("Reconfiguring...");
        button.disabled = true;

        cockpit.spawn(['/usr/local/bin/ntp-fsmo-manager.sh'], { superuser: "try" })
            .then(() => {
                this.showSuccess(_("NTP hierarchy reconfigured successfully"));
                // Refresh all status
                setTimeout(() => {
                    this.checkServiceStatus();
                    this.checkNtpFsmoStatus();
                    this.refreshNtpStatus();
                }, 3000);
            })
            .catch(error => {
                this.showError(_("NTP reconfiguration failed: ") + error.message);
            })
            .finally(() => {
                setTimeout(() => {
                    button.innerHTML = originalText;
                    button.disabled = false;
                }, 3000);
            });
    }

    refreshNtpStatus() {
        const trackingElement = document.getElementById('ntp-tracking');
        const stratumElement = document.getElementById('ntp-stratum');
        const offsetElement = document.getElementById('ntp-offset');

        // Return early if elements don't exist (simplified UI)
        if (!trackingElement || !stratumElement || !offsetElement) {
            return;
        }

        trackingElement.innerHTML = '<div class="log-loading">' + _("Loading NTP status...") + '</div>';

        // Get chrony tracking information
        cockpit.spawn(['chronyc', 'tracking'], { superuser: "try" })
            .then(output => {
                if (output.trim()) {
                    const formattedOutput = this.escapeHtml(output)
                        .replace(/\n/g, '<br>')
                        .replace(/\s{2,}/g, ' &nbsp; ');
                    trackingElement.innerHTML = '<div class="ntp-tracking-content">' + formattedOutput + '</div>';

                    // Parse stratum and offset
                    const stratumMatch = output.match(/Stratum\s*:\s*(\d+)/);
                    const offsetMatch = output.match(/System time\s*:\s*([+-]?\d+\.\d+)/);

                    if (stratumMatch) {
                        stratumElement.textContent = stratumMatch[1];
                    }
                    if (offsetMatch) {
                        const offset = parseFloat(offsetMatch[1]);
                        offsetElement.textContent = offset.toFixed(3) + ' seconds';

                        // Color code based on offset
                        if (Math.abs(offset) < 0.1) {
                            offsetElement.className = 'ntp-info-value success';
                        } else if (Math.abs(offset) < 1.0) {
                            offsetElement.className = 'ntp-info-value warning';
                        } else {
                            offsetElement.className = 'ntp-info-value error';
                        }
                    }
                } else {
                    trackingElement.innerHTML = '<div class="log-loading">' + _("No NTP tracking data") + '</div>';
                }
            })
            .catch(error => {
                trackingElement.innerHTML = '<div class="log-loading">' + _("Failed to get NTP status") + '</div>';
                stratumElement.textContent = _("Error");
                offsetElement.textContent = _("Error");
            });
    }

    // NTP Configuration Editor Methods
    showNtpEditor() {
        const modal = document.getElementById('ntp-config-modal');
        modal.removeAttribute('hidden');

        // Load current NTP configuration
        this.loadNtpConfig();
    }

    hideNtpEditor() {
        const modal = document.getElementById('ntp-config-modal');
        modal.setAttribute('hidden', '');
    }

    loadNtpConfig() {
        // Read current chrony configuration
        cockpit.spawn(['cat', '/etc/chrony/chrony.conf'], { superuser: "try" })
            .then(config => {
                this.parseNtpConfig(config);
            })
            .catch(error => {
                console.error('Failed to load NTP config:', error);
                // Load defaults if config doesn't exist
                this.loadNtpDefaults();
            });
    }

    loadNtpDefaults() {
        // Set default values
        const interfaceInfo = this.networkInterfaces.find(iface => iface.name === 'enp0s3');
        const interfaceIP = interfaceInfo ? interfaceInfo.ips[0] : '192.168.1.174';
        const networkBase = interfaceIP.split('.').slice(0, 3).join('.');

        document.getElementById('ntp-external-servers').value = `pool.ntp.org
time.nist.gov
time.google.com
time.cloudflare.com`;
        document.getElementById('ntp-pdc-stratum').value = '10';
        document.getElementById('ntp-dc-stratum').value = '11';
        document.getElementById('ntp-allow-clients').value = networkBase + '.0/24';
    }

    parseNtpConfig(config) {
        // Parse existing NTP configuration
        const lines = config.split('\n');

        // Extract external servers (pool/server lines)
        const serverLines = lines.filter(line =>
            line.trim().startsWith('pool ') ||
            line.trim().startsWith('server ') && !line.includes('127.127.')
        );
        const servers = serverLines.map(line => {
            const match = line.match(/(?:pool|server)\s+([^\s]+)/);
            return match ? match[1] : '';
        }).filter(server => server && !server.includes('127.127.')).join('\n');

        if (servers) {
            document.getElementById('ntp-external-servers').value = servers;
        }

        // Extract stratum levels from local clock lines
        const pdcStratumMatch = config.match(/server 127\.127\.1\.0.*stratum (\d+)/);
        if (pdcStratumMatch) {
            document.getElementById('ntp-pdc-stratum').value = pdcStratumMatch[1];
        }

        // Extract allow networks
        const allowMatch = config.match(/allow ([^\s\n]+)/);
        if (allowMatch) {
            document.getElementById('ntp-allow-clients').value = allowMatch[1];
        }

        // Default DC stratum is typically PDC stratum + 1
        const pdcStratum = parseInt(document.getElementById('ntp-pdc-stratum').value) || 10;
        document.getElementById('ntp-dc-stratum').value = (pdcStratum + 1).toString();
    }

    saveNtpConfig() {
        const button = document.getElementById('save-ntp-config');
        const originalText = button.innerHTML;

        button.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ' + _("Saving...");
        button.disabled = true;

        // Get form values
        const externalServers = document.getElementById('ntp-external-servers').value.trim();
        const pdcStratum = document.getElementById('ntp-pdc-stratum').value.trim();
        const dcStratum = document.getElementById('ntp-dc-stratum').value.trim();
        const allowClients = document.getElementById('ntp-allow-clients').value.trim();

        // Validate inputs
        if (!externalServers || !pdcStratum || !dcStratum || !allowClients) {
            this.showError(_("Please fill in all required fields"));
            button.innerHTML = originalText;
            button.disabled = false;
            return;
        }

        // Create NTP configuration templates for both PDC and non-PDC roles
        const domainName = 'guedry.local'; // This should be dynamically determined
        const serverList = externalServers.split('\n').filter(s => s.trim()).map(s => `pool ${s.trim()}`).join('\n');

        const pdcConfig = `# NTP Configuration for PDC Emulator
# Generated by cockpit-domain-controller configuration editor
# Last updated: ${new Date().toISOString()}

# External NTP servers for PDC Emulator
${serverList}

# Local clock as fallback
server 127.127.1.0 stratum ${pdcStratum}

# Allow client access
allow ${allowClients}
allow 127.0.0.1

# Basic chrony settings
driftfile /var/lib/chrony/drift
makestep 1.0 3
rtcsync

# Logging
logdir /var/log/chrony
log tracking measurements statistics
`;

        const dcConfig = `# NTP Configuration for Domain Controller
# Generated by cockpit-domain-controller configuration editor
# Last updated: ${new Date().toISOString()}

# Sync with PDC Emulator (will be updated by FSMO manager)
server 127.127.1.0 stratum ${dcStratum}

# Allow client access
allow ${allowClients}
allow 127.0.0.1

# Basic chrony settings
driftfile /var/lib/chrony/drift
makestep 1.0 3
rtcsync

# Logging
logdir /var/log/chrony
log tracking measurements statistics
`;

        // Save configuration templates to SYSVOL
        cockpit.spawn(['mkdir', '-p', `/var/lib/samba/sysvol/${domainName}/ntp-configs`], { superuser: "try" })
            .then(() => {
                // Save PDC template
                return cockpit.spawn(['tee', `/var/lib/samba/sysvol/${domainName}/ntp-configs/chrony.conf.pdc`], {
                    superuser: "try"
                }).input(pdcConfig);
            })
            .then(() => {
                // Save DC template
                return cockpit.spawn(['tee', `/var/lib/samba/sysvol/${domainName}/ntp-configs/chrony.conf.dc`], {
                    superuser: "try"
                }).input(dcConfig);
            })
            .then(() => {
                // Save current settings
                return cockpit.spawn(['tee', `/var/lib/samba/sysvol/${domainName}/ntp-configs/ntp-settings.conf`], {
                    superuser: "try"
                }).input(`# NTP Settings
EXTERNAL_SERVERS="${externalServers.replace(/\n/g, ' ')}"
PDC_STRATUM=${pdcStratum}
DC_STRATUM=${dcStratum}
ALLOW_CLIENTS="${allowClients}"
LAST_UPDATED="${new Date().toISOString()}"
`);
            })
            .then(() => {
                // Apply current configuration based on FSMO role
                return cockpit.spawn(['/usr/local/bin/ntp-fsmo-manager.sh'], { superuser: "try" });
            })
            .then(() => {
                this.showSuccess(_("NTP configuration updated and deployed successfully!"));
                this.hideNtpEditor();
                this.refreshNtpStatus();
            })
            .catch(error => {
                console.error('NTP configuration save failed:', error);
                this.showError(_("Failed to save NTP configuration: ") + error.message);
            })
            .finally(() => {
                button.innerHTML = originalText;
                button.disabled = false;
            });
    }

    clearFSMORoles() {
        // Clear FSMO role displays for unconfigured domain controllers
        const roleElements = {
            'schema-master': { element: document.getElementById('schema-master'), name: _("Schema Master") },
            'domain-naming-master': { element: document.getElementById('domain-naming-master'), name: _("Domain Naming Master") },
            'pdc-emulator': { element: document.getElementById('pdc-emulator'), name: _("PDC Emulator") },
            'rid-master': { element: document.getElementById('rid-master'), name: _("RID Master") },
            'infrastructure-master': { element: document.getElementById('infrastructure-master'), name: _("Infrastructure Master") }
        };

        Object.values(roleElements).forEach(({ element }) => {
            if (element) {
                element.textContent = _("Configuration required");
                element.className = 'fsmo-role-holder warning';
            }
        });
    }

    validateHostname(hostname, domainName) {
        // Check if hostname is a valid FQDN
        if (!hostname || !hostname.includes('.')) {
            return false;
        }

        // Check if hostname ends with the domain name
        const hostnameLower = hostname.toLowerCase();
        const domainLower = domainName.toLowerCase();

        if (!hostnameLower.endsWith('.' + domainLower)) {
            return false;
        }

        // Basic hostname format validation
        const hostnamePattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
        return hostnamePattern.test(hostname);
    }

    handleLogStream(data) {
        const logOutput = document.getElementById('log-output');
        if (logOutput) {
            logOutput.textContent += data;
            logOutput.scrollTop = logOutput.scrollHeight; // Auto-scroll to bottom
        }
    }

    async setHostname(hostname) {
        console.log('Setting hostname to:', hostname);

        try {
            // Set the hostname using hostnamectl with superuser try
            await cockpit.spawn(['hostnamectl', 'set-hostname', hostname], { superuser: "try" });

            // Update /etc/hosts file
            const shortName = hostname.split('.')[0];
            const hostsEntry = `127.0.1.1 ${hostname} ${shortName}`;

            // Read current hosts file
            let hostsContent = '';
            try {
                hostsContent = await cockpit.file('/etc/hosts', { superuser: "try" }).read();
            } catch (error) {
                console.log('Could not read /etc/hosts, creating new entry');
                hostsContent = '';
            }

            // Remove any existing 127.0.1.1 entries and add the new one
            const hostsLines = hostsContent.split('\n');
            const filteredLines = hostsLines.filter(line => !line.startsWith('127.0.1.1'));
            filteredLines.push(hostsEntry);

            // Write back to hosts file with superuser permissions
            await cockpit.file('/etc/hosts', { superuser: "try" }).replace(filteredLines.join('\n'));

            console.log('Hostname set successfully');
            return Promise.resolve();
        } catch (error) {
            console.error('Failed to set hostname:', error);
            // If superuser "try" failed, provide helpful error message
            if (error.message && error.message.includes('permission') || error.message.includes('permitted')) {
                throw new Error('Permission denied. Please ensure you have administrative privileges.');
            }
            throw error;
        }
    }

    /**
     * Initialize test interface if tests are available
     */

    loadCurrentHostname() {
        // For backward compatibility, call the async version
        this.loadCurrentHostnameAsync().catch(error => {
            console.error('Failed to load current hostname:', error);
        });
    }
}

// Initialize the domain controller when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const domainController = new DomainController();
    domainController.init();
});

// Export for potential use by other modules
window.DomainController = DomainController;