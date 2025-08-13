/**
 * UI Management Module
 * Handles user interface updates, loading states, and notifications
 */

const _ = cockpit.gettext;

export class UIManager {
    constructor() {
        this.loadingElement = null;
        this.currentDomainInfo = null;
    }

    /**
     * Show loading message with spinner
     */
    showLoading(message = "Processing...") {
        // Hide all display sections
        const domainDetails = document.getElementById('domain-details');
        const setupDisplay = document.getElementById('setup-display');
        const loadingDisplay = document.getElementById('loading-display');

        if (domainDetails) domainDetails.classList.add('hidden');
        if (setupDisplay) setupDisplay.classList.add('hidden');
        if (loadingDisplay) {
            loadingDisplay.classList.remove('hidden');
            const loadingMessage = document.getElementById('loading-message');
            if (loadingMessage) {
                loadingMessage.textContent = _(message);
            }
        }

        // Update status badge
        const statusBadge = document.getElementById('status-badge');
        if (statusBadge) {
            statusBadge.textContent = _(message);
            statusBadge.className = 'pf-v5-c-badge pf-m-blue domain-status-badge';
        }

        console.log('Loading shown:', message);
    }

    /**
     * Hide loading state
     */
    hideLoading() {
        const loadingDisplay = document.getElementById('loading-display');
        if (loadingDisplay) {
            loadingDisplay.classList.add('hidden');
        }

        // Show appropriate display based on domain status
        if (this.currentDomainInfo) {
            this.showDomainDetails();
        } else {
            this.showSetupDisplay();
        }

        console.log('Loading hidden');
    }

    /**
     * Show error message
     */
    showError(message) {
        console.error('Error:', message);
        // In a real implementation, this would show a proper toast notification
        // For now, using alert as placeholder
        alert("Error: " + message);
    }

    /**
     * Show success message
     */
    showSuccess(message) {
        console.log('Success:', message);
        // In a real implementation, this would show a proper toast notification
        // For now, using alert as placeholder
        alert("Success: " + message);
    }

    /**
     * Show information message
     */
    showInfo(message) {
        console.log('Info:', message);
        // In a real implementation, this would show a proper toast notification
        // For now, using alert as placeholder
        alert("Info: " + message);
    }

    /**
     * Hide all tabs
     */
    hideAllTabs() {
        document.querySelectorAll('.domain-tab-content').forEach(tab => {
            tab.classList.remove('active');
        });
    }

    /**
     * Show specific tab
     */
    showTab(tabId) {
        this.hideAllTabs();
        const tab = document.getElementById(tabId);
        if (tab) {
            tab.classList.add('active');
        }
    }

    /**
     * Update domain status information in the UI
     */
    updateDomainStatus(domainInfo) {
        this.currentDomainInfo = domainInfo;

        const statusBadge = document.getElementById('status-badge');

        if (domainInfo) {
            console.log('Domain status updated:', domainInfo);

            // Update status badge
            if (statusBadge) {
                statusBadge.textContent = _("Domain Controller");
                statusBadge.className = 'pf-v5-c-badge pf-m-green domain-status-badge';
            }

            // Update domain information display
            this.updateDomainInfoDisplay(domainInfo);

            // Show domain details
            this.showDomainDetails();
        } else {
            console.log('Domain status cleared - showing setup display');

            // Update status badge
            if (statusBadge) {
                statusBadge.textContent = _("Not configured");
                statusBadge.className = 'pf-v5-c-badge pf-m-read domain-status-badge';
            }

            // Clear domain information display
            this.clearDomainInfoDisplay();

            // Show setup display
            this.showSetupDisplay();
        }
    }

    /**
     * Show domain details section
     */
    showDomainDetails() {
        const domainDetails = document.getElementById('domain-details');
        const setupDisplay = document.getElementById('setup-display');
        const loadingDisplay = document.getElementById('loading-display');
        const noMessageDisplay = document.getElementById('no-domain-message');

        if (domainDetails) domainDetails.classList.remove('hidden');
        if (setupDisplay) setupDisplay.classList.add('hidden');
        if (loadingDisplay) loadingDisplay.classList.add('hidden');
        if (noMessageDisplay) noMessageDisplay.classList.add('hidden');
    }

    /**
     * Show setup display section
     */
    showSetupDisplay() {
        const domainDetails = document.getElementById('domain-details');
        const setupDisplay = document.getElementById('setup-display');
        const loadingDisplay = document.getElementById('loading-display');
        const noMessageDisplay = document.getElementById('no-domain-message');

        if (domainDetails) domainDetails.classList.add('hidden');
        if (setupDisplay) setupDisplay.classList.remove('hidden');
        if (loadingDisplay) loadingDisplay.classList.add('hidden');
        if (noMessageDisplay) noMessageDisplay.classList.add('hidden');
    }

    /**
     * Update domain information display elements (matching original structure)
     */
    updateDomainInfoDisplay(domainInfo) {
        // Update domain name display
        const domainNameElement = document.getElementById('domain-name');
        if (domainNameElement) {
            domainNameElement.textContent = domainInfo.domain || 'Unknown';
        }

        // Update server role display
        const serverRoleElement = document.getElementById('domain-role');
        if (serverRoleElement) {
            serverRoleElement.textContent = domainInfo.role || 'Domain Controller';
        }

        // Update hostname display
        const hostnameElement = document.getElementById('current-hostname');
        if (hostnameElement) {
            hostnameElement.textContent = domainInfo.hostname || 'Unknown';
        }

        // Update NetBIOS name display
        const netbiosElement = document.getElementById('netbios-display');
        if (netbiosElement) {
            netbiosElement.textContent = domainInfo.netbios || 'Unknown';
        }
    }

    /**
     * Clear domain information display
     */
    clearDomainInfoDisplay() {
        const domainNameElements = document.querySelectorAll('.domain-name-display');
        domainNameElements.forEach(element => {
            element.textContent = _('Not configured');
        });

        const serverRoleElement = document.getElementById('server-role');
        if (serverRoleElement) {
            serverRoleElement.textContent = _('Not configured');
        }

        const hostnameElement = document.getElementById('current-hostname');
        if (hostnameElement) {
            hostnameElement.textContent = _('Not configured');
        }

        const netbiosElement = document.getElementById('netbios-display');
        if (netbiosElement) {
            netbiosElement.textContent = _('Not configured');
        }
    }

    /**
     * Update service status display
     */
    updateServiceStatus(serviceName, status, className = '') {
        const statusElement = document.getElementById(`${serviceName}-status`);
        if (statusElement) {
            statusElement.textContent = _(status);

            // Use PatternFly badges for status
            let badgeClass = 'pf-v5-c-badge ';
            switch (className) {
                case 'running':
                    badgeClass += 'pf-m-green';
                    break;
                case 'stopped':
                case 'error':
                    badgeClass += 'pf-m-red';
                    break;
                case 'warning':
                    badgeClass += 'pf-m-gold';
                    break;
                case 'checking':
                    badgeClass += 'pf-m-blue';
                    break;
                case 'inactive':
                default:
                    badgeClass += 'pf-m-read';
                    break;
            }
            statusElement.className = badgeClass;
        }
    }

    /**
     * Enable/disable form elements
     */
    setFormEnabled(formId, enabled) {
        const form = document.getElementById(formId);
        if (form) {
            const inputs = form.querySelectorAll('input, select, button, textarea');
            inputs.forEach(input => {
                input.disabled = !enabled;
            });
        }
    }

    /**
     * Clear form fields
     */
    clearForm(formId) {
        const form = document.getElementById(formId);
        if (form) {
            const inputs = form.querySelectorAll('input[type="text"], input[type="password"], textarea');
            inputs.forEach(input => {
                input.value = '';
            });

            const selects = form.querySelectorAll('select');
            selects.forEach(select => {
                select.selectedIndex = 0;
            });
        }
    }

    /**
     * Validate form fields
     */
    validateForm(formId, requiredFields) {
        const form = document.getElementById(formId);
        if (!form) return false;

        const missing = [];

        requiredFields.forEach(fieldId => {
            const field = document.getElementById(fieldId);
            if (field && !field.value.trim()) {
                missing.push(fieldId);
                field.classList.add('error');
            } else if (field) {
                field.classList.remove('error');
            }
        });

        if (missing.length > 0) {
            this.showError(`Please fill in the following required fields: ${missing.join(', ')}`);
            return false;
        }

        return true;
    }

    /**
     * Set loading state for specific button
     */
    setButtonLoading(buttonId, loading, originalText = null) {
        const button = document.getElementById(buttonId);
        if (!button) return;

        if (loading) {
            if (originalText) {
                button.setAttribute('data-original-text', originalText);
            }
            button.disabled = true;
            button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
        } else {
            button.disabled = false;
            const original = button.getAttribute('data-original-text');
            if (original) {
                button.innerHTML = original;
                button.removeAttribute('data-original-text');
            } else {
                button.innerHTML = button.innerHTML.replace('<i class="fas fa-spinner fa-spin"></i> Processing...', 'Submit');
            }
        }
    }

    /**
     * Update progress bar
     */
    updateProgressBar(percentage, message = '') {
        const progressBar = document.getElementById('progress-bar');
        const progressText = document.getElementById('progress-text');

        if (progressBar) {
            progressBar.style.width = `${percentage}%`;
        }

        if (progressText && message) {
            progressText.textContent = message;
        }
    }

    /**
     * Show/hide elements
     */
    showElement(elementId) {
        const element = document.getElementById(elementId);
        if (element) {
            element.style.display = 'block';
        }
    }

    hideElement(elementId) {
        const element = document.getElementById(elementId);
        if (element) {
            element.style.display = 'none';
        }
    }

    /**
     * Toggle element visibility
     */
    toggleElement(elementId) {
        const element = document.getElementById(elementId);
        if (element) {
            const isVisible = element.style.display !== 'none';
            element.style.display = isVisible ? 'none' : 'block';
        }
    }

    /**
     * Add CSS class to element
     */
    addClass(elementId, className) {
        const element = document.getElementById(elementId);
        if (element) {
            element.classList.add(className);
        }
    }

    /**
     * Remove CSS class from element
     */
    removeClass(elementId, className) {
        const element = document.getElementById(elementId);
        if (element) {
            element.classList.remove(className);
        }
    }

    /**
     * Set element text content
     */
    setElementText(elementId, text) {
        const element = document.getElementById(elementId);
        if (element) {
            element.textContent = text;
        }
    }

    /**
     * Set element HTML content
     */
    setElementHTML(elementId, html) {
        const element = document.getElementById(elementId);
        if (element) {
            element.innerHTML = html;
        }
    }

    /**
     * Create notification toast (placeholder for future implementation)
     */
    showToast(message, type = 'info', duration = 5000) {
        // This would create a proper toast notification in a real implementation
        console.log(`Toast (${type}):`, message);

        // For now, fall back to appropriate method
        switch (type) {
            case 'error':
                this.showError(message);
                break;
            case 'success':
                this.showSuccess(message);
                break;
            case 'warning':
                this.showInfo('Warning: ' + message);
                break;
            default:
                this.showInfo(message);
                break;
        }
    }

    /**
     * Confirm dialog
     */
    confirm(message, title = 'Confirm') {
        return confirm(`${title}\n\n${message}`);
    }

    /**
     * Prompt dialog
     */
    prompt(message, defaultValue = '') {
        return prompt(message, defaultValue);
    }

    /**
     * Update timestamp display
     */
    updateLastUpdated(elementId = 'last-updated') {
        const element = document.getElementById(elementId);
        if (element) {
            const now = new Date();
            element.textContent = `Last updated: ${now.toLocaleString()}`;
        }
    }
}