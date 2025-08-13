/**
 * Domain Management Module
 * Handles domain provisioning, joining, and leaving operations
 */

const _ = cockpit.gettext;

export class DomainManager {
    constructor(uiManager) {
        this.uiManager = uiManager;
    }

    /**
     * Provision a new Active Directory domain
     */
    async provisionDomain() {
        const domainName = document.getElementById('domain-name').value.trim();
        const netbiosName = document.getElementById('netbios-name').value.trim();
        const adminPassword = document.getElementById('admin-password').value;
        const confirmPassword = document.getElementById('confirm-password').value;
        const hostname = document.getElementById('hostname').value.trim();
        const selectedInterface = document.getElementById('interface').value;

        // Validation
        if (!domainName || !netbiosName || !adminPassword || !confirmPassword || !hostname || !selectedInterface) {
            this.uiManager.showError(_("Please fill in all required fields"));
            return;
        }

        if (!this.validateDomainName(domainName)) {
            this.uiManager.showError(_("Domain name must be a valid FQDN (e.g., example.com)"));
            return;
        }

        if (!this.validateNetbiosName(netbiosName)) {
            this.uiManager.showError(_("NetBIOS name must be 15 characters or less and contain only letters, numbers, and hyphens"));
            return;
        }

        if (adminPassword !== confirmPassword) {
            this.uiManager.showError(_("Passwords do not match"));
            return;
        }

        if (!this.validateHostname(hostname, domainName)) {
            this.uiManager.showError(_("Hostname must be a valid FQDN within the domain"));
            return;
        }

        this.uiManager.showLoading(_("Provisioning domain " + domainName + "..."));

        try {
            await this.performDomainProvisioning(domainName, netbiosName, adminPassword, hostname, selectedInterface);
        } catch (error) {
            console.error('Domain provisioning failed:', error);
            this.uiManager.hideLoading();
            this.uiManager.showError(_("Failed to provision domain: ") + error.message);
        }
    }

    /**
     * Join an existing Active Directory domain
     */
    async joinDomain() {
        const domainName = document.getElementById('existing-domain').value.trim();
        const hostname = document.getElementById('join-hostname').value.trim();
        const domainControllerIP = document.getElementById('domain-controller-ip').value.trim();
        const username = document.getElementById('domain-user').value.trim();
        const password = document.getElementById('domain-password').value;
        const selectedInterface = document.getElementById('join-interface').value;

        if (!domainName || !hostname || !domainControllerIP || !username || !password || !selectedInterface) {
            this.uiManager.showError(_("Please fill in all required fields"));
            return;
        }

        if (!this.validateHostname(hostname, domainName)) {
            this.uiManager.showError(_("Hostname must be a valid FQDN within the domain (e.g., dc2.example.com)"));
            return;
        }

        this.uiManager.showLoading(_("Testing connectivity to domain controller..."));

        try {
            await this.setHostname(hostname);
            await this.testDomainControllerConnectivity(domainControllerIP, domainName);
            await this.performDomainJoin(domainName, hostname, domainControllerIP, username, password, selectedInterface);
        } catch (error) {
            console.error('Domain join failed:', error);
            this.uiManager.hideLoading();
            this.uiManager.showError(_("Failed to join domain: ") + error.message);
        }
    }

    /**
     * Leave the current domain
     */
    async leaveDomain() {
        if (!confirm(_("Are you sure you want to leave the domain? This will remove all domain configurations."))) {
            return;
        }

        this.uiManager.showLoading();

        try {
            // First try to demote properly
            await cockpit.spawn(['samba-tool', 'domain', 'demote'], { superuser: "try" });
            this.uiManager.hideLoading();
            this.uiManager.updateDomainStatus(null);
            this.uiManager.showSuccess(_("Successfully left the domain"));
        } catch (error) {
            console.error('Demote failed:', error);
            // If demote fails, try manual cleanup
            await this.forceLeaveCleanup();
        }
    }

    /**
     * Perform comprehensive domain cleanup
     */
    async forceLeaveCleanup() {
        console.log('Attempting comprehensive domain cleanup...');

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

            // Remove configurations
            ['rm', '-rf', '/etc/samba/smb.conf'],
            ['rm', '-rf', '/etc/samba/smb.conf.backup'],
            ['rm', '-rf', '/var/lib/samba/private'],
            ['rm', '-rf', '/var/lib/samba/sysvol'],
            ['rm', '-rf', '/var/cache/samba'],
            ['rm', '-rf', '/var/log/samba'],

            // Remove FSMO components
            ['rm', '-rf', '/usr/local/bin/dhcp-fsmo-manager.sh'],
            ['rm', '-rf', '/usr/local/bin/ntp-fsmo-manager.sh'],
            ['rm', '-rf', '/etc/systemd/system/dhcp-fsmo-monitor.service'],
            ['rm', '-rf', '/etc/systemd/system/dhcp-fsmo-monitor.timer'],
            ['rm', '-rf', '/etc/systemd/system/ntp-fsmo-monitor.service'],
            ['rm', '-rf', '/etc/systemd/system/ntp-fsmo-monitor.timer'],

            // Reload systemd
            ['systemctl', 'daemon-reload'],

            // Reset services
            ['systemctl', 'enable', 'chrony'],
            ['systemctl', 'start', 'chrony']
        ];

        try {
            for (const command of cleanupCommands) {
                console.log('Running cleanup command:', command.join(' '));
                try {
                    await cockpit.spawn(command, { superuser: "try" });
                } catch (err) {
                    console.log('Cleanup command failed (may be expected):', err);
                }
            }

            // Write basic configuration files
            await this.writeBasicConfigurations();

            this.uiManager.hideLoading();
            this.uiManager.updateDomainStatus(null);
            this.uiManager.showSuccess(_("Complete domain cleanup finished. Server is ready for fresh domain setup."));
        } catch (error) {
            this.uiManager.hideLoading();
            console.error('Cleanup failed:', error);
            this.uiManager.showError(_("Domain cleanup partially failed: ") + error.message);
        }
    }

    /**
     * Write basic configuration files after cleanup
     */
    async writeBasicConfigurations() {
        const basicDhcpConfig = `# Basic DHCP configuration - NOT domain integrated
# Please configure according to your network requirements

default-lease-time 600;
max-lease-time 7200;
ddns-update-style none;
authoritative;

# Log facility configuration
log-facility local7;
`;

        const basicKrb5Config = `[libdefaults]
	default_realm = EXAMPLE.COM
	kdc_timesync = 1
	ccache_type = 4
	forwardable = true
	proxiable = true
	rdns = false
	fcc-mit-ticketflags = true
	udp_preference_limit = 0
`;

        await cockpit.file('/etc/dhcp/dhcpd.conf', { superuser: "try" }).replace(basicDhcpConfig);
        await cockpit.file('/etc/krb5.conf', { superuser: "try" }).replace(basicKrb5Config);
    }

    /**
     * Validation methods
     */
    validateDomainName(domain) {
        const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.([a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.)*[a-zA-Z]{2,}$/;
        return domainRegex.test(domain);
    }

    validateNetbiosName(netbios) {
        return netbios && netbios.length <= 15 && /^[a-zA-Z0-9-]+$/.test(netbios);
    }

    validateHostname(hostname, domain) {
        return hostname && hostname.endsWith('.' + domain) && this.validateDomainName(hostname);
    }

    /**
     * Set system hostname
     */
    async setHostname(hostname) {
        await cockpit.spawn(['hostnamectl', 'set-hostname', hostname], { superuser: "try" });
    }

    /**
     * Test connectivity to domain controller
     */
    async testDomainControllerConnectivity(dcIP, domainName) {
        // Test basic network connectivity
        await cockpit.spawn(['ping', '-c', '2', '-W', '3', dcIP], { superuser: "try" });

        // Test SMB port connectivity
        await cockpit.spawn(['nc', '-z', '-w', '5', dcIP, '445'], { superuser: "try" });
    }

    /**
     * Update Kerberos configuration for domain operations
     */
    async updateKerberosConfig(domainName, dcHostname) {
        const realm = domainName.toUpperCase();
        const domain = domainName.toLowerCase();

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
\t${realm} = {
\t\tkdc = ${dcHostname}:88
\t\tadmin_server = ${dcHostname}:749
\t\tdefault_domain = ${domain}
\t}

[domain_realm]
\t.${domain} = ${realm}
\t${domain} = ${realm}
`;

        try {
            await cockpit.file('/etc/krb5.conf', { superuser: "try" }).replace(krb5Config);
            console.log('Kerberos configuration updated successfully');
        } catch (error) {
            console.error('Failed to update Kerberos configuration:', error);
            throw error;
        }
    }

    /**
     * Perform the actual domain provisioning
     */
    async performDomainProvisioning(domainName, netbiosName, adminPassword, hostname, selectedInterface) {
        // This is a placeholder for the complex domain provisioning logic
        // In the actual implementation, this would include:
        // - Setting up network configuration
        // - Creating samba configuration
        // - Running samba-tool domain provision
        // - Configuring services
        // - Setting up DHCP and NTP
        console.log(`Provisioning domain: ${domainName} with NetBIOS: ${netbiosName} on interface: ${selectedInterface}`);
        console.log(`Hostname: ${hostname}, Admin password provided: ${adminPassword ? 'Yes' : 'No'}`);
        throw new Error("Domain provisioning implementation needed - to be extracted from original file");
    }

    /**
     * Perform the actual domain join
     */
    async performDomainJoin(domainName, hostname, domainControllerIP, username, password, selectedInterface) {
        // This is a placeholder for the complex domain join logic
        // In the actual implementation, this would include:
        // - Testing connectivity to the domain controller
        // - Configuring DNS settings
        // - Running samba-tool domain join
        // - Updating Kerberos configuration
        // - Configuring services
        console.log(`Joining domain: ${domainName} at DC IP: ${domainControllerIP}`);
        console.log(`Hostname: ${hostname}, Username: ${username}, Interface: ${selectedInterface}`);
        console.log(`Password provided: ${password ? 'Yes' : 'No'}`);

        // Update Kerberos configuration for domain join
        await this.updateKerberosConfig(domainName, hostname);

        throw new Error("Domain join implementation needed - to be extracted from original file");
    }
}