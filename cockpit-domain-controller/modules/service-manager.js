/**
 * Service Management Module
 * Handles NTP, DHCP, and Samba service operations
 */

const _ = cockpit.gettext;

export class ServiceManager {
    constructor(uiManager) {
        this.uiManager = uiManager;
    }

    /**
     * Configure NTP for PDC Emulator role
     */
    async configureNTPForPDC(ntpServers = null) {
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
        
        try {
            await cockpit.spawn(['sh', '-c', configCommand], { superuser: "try" });
            console.log('NTP configuration added to chrony.conf');
            
            // Restart chrony service to apply changes
            await cockpit.spawn(['systemctl', 'restart', 'chrony'], { superuser: "try" });
            console.log('Chrony service restarted successfully');
        } catch (error) {
            console.error('Failed to configure NTP for PDC:', error);
            throw error;
        }
    }

    /**
     * Configure NTP for additional domain controller
     */
    async configureNTPForAdditionalDC(pdcIP, ntpServers = null) {
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
        
        try {
            await cockpit.spawn(['sh', '-c', configCommand], { superuser: "try" });
            console.log('NTP configuration added to chrony.conf');
            
            // Restart chrony service to apply changes
            await cockpit.spawn(['systemctl', 'restart', 'chrony'], { superuser: "try" });
            console.log('Chrony service restarted successfully');
        } catch (error) {
            console.error('Failed to configure NTP for additional DC:', error);
            throw error;
        }
    }

    /**
     * Check and update NTP configuration based on FSMO roles
     */
    async checkAndUpdateNTPForFSMO(ntpServers = null) {
        console.log('Checking FSMO roles and updating NTP configuration accordingly');
        
        try {
            // Check if this DC holds the PDC Emulator role
            const output = await cockpit.spawn(['samba-tool', 'fsmo', 'show'], { superuser: "try" });
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
                    const hostname = await cockpit.spawn(['hostname', '-f'], { superuser: "try" });
                    const thisServer = hostname.trim();
                    console.log('PDC Emulator owner:', pdcOwner, 'This server:', thisServer);
                    
                    if (pdcOwner.toLowerCase().includes(thisServer.toLowerCase()) || 
                        thisServer.toLowerCase().includes(pdcOwner.toLowerCase())) {
                        console.log('This server holds PDC Emulator role - configuring as PDC');
                        return this.configureNTPForPDC(ntpServers);
                    } else {
                        console.log('This server is an additional DC - configuring to sync from PDC');
                        // Try to resolve PDC IP from hostname
                        try {
                            const pdcIP = await this.resolvePDCIP(pdcOwner);
                            return this.configureNTPForAdditionalDC(pdcIP, ntpServers);
                        } catch (resolveError) {
                            console.log('Could not resolve PDC IP, falling back to PDC NTP config');
                            return this.configureNTPForPDC(ntpServers); // Fallback to external sources
                        }
                    }
                } else {
                    console.log('Could not parse PDC owner from output');
                    return this.configureNTPForPDC(ntpServers); // Fallback
                }
            } else {
                console.log('Could not find PDC role in FSMO output');
                return this.configureNTPForPDC(ntpServers); // Fallback
            }
        } catch (error) {
            console.error('Failed to check FSMO roles for NTP configuration:', error);
            return this.configureNTPForPDC(ntpServers); // Fallback to PDC config
        }
    }

    /**
     * Resolve PDC IP address from hostname
     */
    async resolvePDCIP(pdcHostname) {
        // Extract just the hostname without domain info
        const hostname = pdcHostname.split(',')[0].replace('CN=NTDS Settings,CN=', '').replace(',CN=Servers', '');
        
        try {
            const output = await cockpit.spawn(['getent', 'hosts', hostname], { superuser: "try" });
            const ip = output.trim().split(' ')[0];
            console.log(`Resolved ${hostname} to IP: ${ip}`);
            return ip;
        } catch (error) {
            console.error(`Failed to resolve ${hostname}:`, error);
            throw error;
        }
    }

    /**
     * Check DHCP service status and update UI
     */
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
                
                // Update DHCP FSMO status if element exists
                const dhcpFsmoStatus = document.getElementById('dhcp-fsmo-status');
                if (dhcpFsmoStatus) {
                    dhcpFsmoStatus.textContent = _("DHCP managed by PDC Emulator");
                }
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

    /**
     * Check if this server should run DHCP based on FSMO roles
     */
    async shouldRunDHCP() {
        try {
            // Check if this server holds the PDC Emulator role
            const output = await cockpit.spawn(['samba-tool', 'fsmo', 'show'], { superuser: "try" });
            const lines = output.split('\n');
            const pdcLine = lines.find(line => line.includes('PdcEmulationMasterRole') || line.includes('PdcRole') || line.includes('PDC'));
            
            if (pdcLine) {
                const hostname = await cockpit.spawn(['hostname', '-f'], { superuser: "try" });
                const currentHost = hostname.trim().toLowerCase();
                
                // Check if this host is mentioned in the PDC line
                return pdcLine.toLowerCase().includes(currentHost) || 
                       pdcLine.toLowerCase().includes(currentHost.split('.')[0]);
            }
            
            return false; // Default to not running DHCP
        } catch (error) {
            console.log('Could not check FSMO roles for DHCP decision:', error);
            
            // Fallback: Check if DHCP is actually configured and should run
            try {
                await cockpit.file('/etc/dhcp/dhcpd.conf').read();
                // If config exists, assume it should run
                return true;
            } catch (configError) {
                // No DHCP config, shouldn't run
                return false;
            }
        }
    }

    /**
     * Ensure DHCP service is running (called after PDC transfer)
     */
    async ensureDHCPRunning() {
        try {
            console.log('Ensuring DHCP service is running...');
            
            // Check if service is enabled, enable if not
            try {
                await cockpit.spawn(['systemctl', 'is-enabled', 'isc-dhcp-server'], { superuser: "try" });
            } catch (error) {
                console.log('DHCP service not enabled, enabling...');
                await cockpit.spawn(['systemctl', 'enable', 'isc-dhcp-server'], { superuser: "try" });
            }
            
            // Start the service
            await cockpit.spawn(['systemctl', 'start', 'isc-dhcp-server'], { superuser: "try" });
            console.log('DHCP service started successfully');
        } catch (error) {
            console.log('Failed to start DHCP service (may need configuration):', error);
            // Try enabling again in case of dependency issues
            try {
                await cockpit.spawn(['systemctl', 'enable', 'isc-dhcp-server'], { superuser: "try" });
            } catch (enableError) {
                console.log('Could not enable DHCP service:', enableError);
            }
        }
    }

    /**
     * Check individual service status and update UI element
     */
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
                console.error(`Failed to check ${serviceName} status:`, error);
                if (error.message && error.message.includes('not found')) {
                    statusElement.textContent = _("Not installed");
                    statusElement.className = 'service-status-text error';
                } else {
                    statusElement.textContent = _("Check failed");
                    statusElement.className = 'service-status-text error';
                }
            });
    }

    /**
     * Restart a service
     */
    async restartService(serviceName) {
        console.log(`Restarting service: ${serviceName}`);
        
        try {
            await cockpit.spawn(['systemctl', 'restart', serviceName], { superuser: "try" });
            console.log(`Service ${serviceName} restarted successfully`);
            this.uiManager.showSuccess(`Service ${serviceName} restarted successfully`);
            
            // Update status display
            setTimeout(() => {
                if (serviceName === 'isc-dhcp-server') {
                    this.checkDHCPServiceStatus();
                } else if (serviceName === 'samba-ad-dc') {
                    this.checkIndividualService('samba-ad-dc', 'samba-status');
                }
            }, 1000);
        } catch (error) {
            console.error(`Failed to restart ${serviceName}:`, error);
            this.uiManager.showError(`Failed to restart ${serviceName}: ` + error.message);
        }
    }

    /**
     * Enable and start Samba AD DC service
     */
    async enableAndStartSamba() {
        try {
            await cockpit.spawn(['systemctl', 'enable', 'samba-ad-dc'], { superuser: "try" });
            await cockpit.spawn(['systemctl', 'start', 'samba-ad-dc'], { superuser: "try" });
            console.log('Samba AD DC service enabled and started');
        } catch (error) {
            console.error('Failed to start Samba AD DC service:', error);
            throw error;
        }
    }

    /**
     * Stop domain-related services during cleanup
     */
    async stopDomainServices() {
        const services = [
            'samba-ad-dc',
            'isc-dhcp-server', 
            'chrony',
            'dhcp-fsmo-monitor.timer',
            'ntp-fsmo-monitor.timer'
        ];

        for (const service of services) {
            try {
                console.log(`Stopping service: ${service}`);
                await cockpit.spawn(['systemctl', 'stop', service], { superuser: "try" });
            } catch (error) {
                console.log(`Failed to stop ${service} (may be expected):`, error);
            }
        }
    }

    /**
     * Disable domain-related services during cleanup
     */
    async disableDomainServices() {
        const services = [
            'samba-ad-dc',
            'dhcp-fsmo-monitor.timer',
            'ntp-fsmo-monitor.timer'
        ];

        for (const service of services) {
            try {
                console.log(`Disabling service: ${service}`);
                await cockpit.spawn(['systemctl', 'disable', service], { superuser: "try" });
            } catch (error) {
                console.log(`Failed to disable ${service} (may be expected):`, error);
            }
        }
    }

    /**
     * Reset services to default state after domain cleanup
     */
    async resetServicesToDefault() {
        try {
            // Reload systemd daemon
            await cockpit.spawn(['systemctl', 'daemon-reload'], { superuser: "try" });
            
            // Reset chrony to default state
            await cockpit.spawn(['systemctl', 'enable', 'chrony'], { superuser: "try" });
            await cockpit.spawn(['systemctl', 'start', 'chrony'], { superuser: "try" });
            
            console.log('Services reset to default state');
        } catch (error) {
            console.error('Failed to reset services:', error);
            throw error;
        }
    }
}