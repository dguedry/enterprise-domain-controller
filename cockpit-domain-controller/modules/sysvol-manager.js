/*
 * SYSVOL Configuration Manager Module
 * Manages domain service configurations stored in SYSVOL
 * Part of cockpit-domain-controller package
 */

export class SysvolManager {
    constructor(uiManager) {
        this.uiManager = uiManager;
        this.domainName = null;
        this.sysvolBase = null;
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return true;

        try {
            // Discover domain name from SYSVOL
            const result = await cockpit.spawn([
                'find', '/var/lib/samba/sysvol/', '-maxdepth', '1', '-type', 'd', '-name', '*.local'
            ], { superuser: "try" });
            
            const domainDir = result.trim().split('\n')[0];
            if (domainDir) {
                this.domainName = domainDir.split('/').pop();
                this.sysvolBase = `/var/lib/samba/sysvol/${this.domainName}`;
                this.initialized = true;
                console.log('SYSVOL Manager initialized for domain:', this.domainName);
                return true;
            }
        } catch (error) {
            console.error('Failed to initialize SYSVOL Manager:', error);
        }
        
        return false;
    }

    async ensureSysvolStructure() {
        if (!this.initialized) {
            if (!await this.initialize()) {
                throw new Error('SYSVOL Manager not initialized');
            }
        }

        const directories = [
            `${this.sysvolBase}/ntp-configs`,
            `${this.sysvolBase}/dhcp-configs`,
            `${this.sysvolBase}/service-configs`
        ];

        for (const dir of directories) {
            try {
                await cockpit.spawn(['mkdir', '-p', dir], { superuser: "try" });
            } catch (error) {
                console.error(`Failed to create directory ${dir}:`, error);
                throw error;
            }
        }
    }

    async readNTPConfig(configType = 'current') {
        await this.ensureSysvolStructure();
        
        let configFile;
        switch (configType) {
            case 'pdc':
                configFile = `${this.sysvolBase}/ntp-configs/chrony.conf.pdc`;
                break;
            case 'dc':
                configFile = `${this.sysvolBase}/ntp-configs/chrony.conf.dc`;
                break;
            case 'settings':
                configFile = `${this.sysvolBase}/ntp-configs/ntp-settings.conf`;
                break;
            case 'current':
            default:
                // Try to determine current config type from settings
                try {
                    const settings = await this.readNTPConfig('settings');
                    const roleMatch = settings.match(/ROLE=(\w+)/);
                    if (roleMatch) {
                        return await this.readNTPConfig(roleMatch[1]);
                    }
                } catch (error) {
                    // Fallback to system config
                    configFile = '/etc/chrony/chrony.conf';
                }
                break;
        }

        try {
            const result = await cockpit.spawn(['cat', configFile], { superuser: "try" });
            return result;
        } catch (error) {
            console.error(`Failed to read NTP config ${configFile}:`, error);
            return null;
        }
    }

    async writeNTPConfig(config, configType = 'pdc') {
        await this.ensureSysvolStructure();
        
        const configFile = `${this.sysvolBase}/ntp-configs/chrony.conf.${configType}`;
        
        try {
            await cockpit.spawn(['tee', configFile], { 
                superuser: "try",
                input: config
            });
            
            // Update settings metadata
            const settings = `# NTP Configuration Metadata
ROLE=${configType}
GENERATED=${new Date().toISOString()}
GENERATED_BY=${await this.getHostname()}
CONFIG_FILE=chrony.conf.${configType}`;
            
            await cockpit.spawn(['tee', `${this.sysvolBase}/ntp-configs/ntp-settings.conf`], {
                superuser: "try",
                input: settings
            });
            
            console.log(`NTP configuration written to SYSVOL: ${configFile}`);
            return true;
        } catch (error) {
            console.error('Failed to write NTP config to SYSVOL:', error);
            throw error;
        }
    }

    async readDHCPConfig(configType = 'active') {
        await this.ensureSysvolStructure();
        
        let configFile;
        switch (configType) {
            case 'active':
                configFile = `${this.sysvolBase}/dhcp-configs/dhcpd.conf.active`;
                break;
            case 'settings':
                configFile = `${this.sysvolBase}/dhcp-configs/dhcp-settings.conf`;
                break;
            default:
                configFile = `${this.sysvolBase}/dhcp-configs/${configType}`;
                break;
        }

        try {
            const result = await cockpit.spawn(['cat', configFile], { superuser: "try" });
            return result;
        } catch (error) {
            console.error(`Failed to read DHCP config ${configFile}:`, error);
            return null;
        }
    }

    async writeDHCPConfig(config, configType = 'active') {
        await this.ensureSysvolStructure();
        
        const configFile = `${this.sysvolBase}/dhcp-configs/dhcpd.conf.${configType}`;
        
        try {
            await cockpit.spawn(['tee', configFile], {
                superuser: "try", 
                input: config
            });
            
            // Update settings metadata
            const settings = `# DHCP Configuration Metadata
GENERATED=${new Date().toISOString()}
GENERATED_BY=${await this.getHostname()}
CONFIG_FILE=dhcpd.conf.${configType}
DOMAIN=${this.domainName}`;
            
            await cockpit.spawn(['tee', `${this.sysvolBase}/dhcp-configs/dhcp-settings.conf`], {
                superuser: "try",
                input: settings
            });
            
            console.log(`DHCP configuration written to SYSVOL: ${configFile}`);
            return true;
        } catch (error) {
            console.error('Failed to write DHCP config to SYSVOL:', error);
            throw error;
        }
    }

    async getServiceStatus() {
        await this.ensureSysvolStructure();
        
        try {
            const result = await cockpit.spawn([
                'cat', `${this.sysvolBase}/service-configs/services-status.conf`
            ], { superuser: "try" });
            
            const services = {};
            const lines = result.split('\n');
            
            for (const line of lines) {
                if (line.startsWith('#') || !line.trim()) continue;
                
                const [serviceData] = line.split('=');
                const [service, status, timestamp, role, host, reportingHost] = line.split('=')[1].split(':');
                
                if (!services[serviceData]) {
                    services[serviceData] = [];
                }
                
                services[serviceData].push({
                    status,
                    timestamp,
                    role,
                    host,
                    reportingHost
                });
            }
            
            return services;
        } catch (error) {
            console.error('Failed to read service status:', error);
            return {};
        }
    }

    async triggerOrchestration(serviceType = null) {
        try {
            let args;
            
            if (serviceType === 'ntp' || serviceType === 'dhcp') {
                // Use domain service orchestrator for basic services
                args = ['/usr/local/bin/domain-service-orchestrator.sh'];
                if (serviceType === 'ntp') {
                    args.push('--ntp-only');
                } else if (serviceType === 'dhcp') {
                    args.push('--dhcp-only');
                } else {
                    args.push('--orchestrate');
                }
            } else if (serviceType === 'fsmo') {
                // Use FSMO orchestrator for comprehensive management
                args = ['/usr/local/bin/fsmo-orchestrator.sh', '--orchestrate'];
            } else {
                // Default to comprehensive FSMO orchestration
                args = ['/usr/local/bin/fsmo-orchestrator.sh', '--orchestrate'];
            }
            
            const result = await cockpit.spawn(args, { superuser: "try" });
            console.log('Orchestration triggered:', result);
            return true;
        } catch (error) {
            console.error('Failed to trigger orchestration:', error);
            throw error;
        }
    }

    async getFSMOStatus() {
        try {
            const result = await cockpit.spawn(['/usr/local/bin/fsmo-orchestrator.sh', '--query'], { superuser: "try" });
            
            // Parse FSMO status from output
            const lines = result.split('\n');
            const fsmoData = {};
            
            for (const line of lines) {
                if (line.includes('=')) {
                    const [key, value] = line.split('=');
                    fsmoData[key] = value;
                }
            }
            
            return fsmoData;
        } catch (error) {
            console.error('Failed to get FSMO status:', error);
            return {};
        }
    }

    async getFSMOServiceStatus() {
        await this.ensureSysvolStructure();
        
        try {
            const result = await cockpit.spawn([
                'cat', `${this.sysvolBase}/fsmo-configs/fsmo-roles.conf`
            ], { superuser: "try" });
            
            const roles = {};
            const lines = result.split('\n');
            
            for (const line of lines) {
                if (line.startsWith('#') || !line.trim()) continue;
                
                const [role, data] = line.split('=');
                if (data) {
                    const [holder, timestamp, status, services] = data.split(':');
                    roles[role] = {
                        holder,
                        timestamp,
                        status,
                        services: services ? services.split(',') : []
                    };
                }
            }
            
            return roles;
        } catch (error) {
            console.error('Failed to read FSMO service status:', error);
            return {};
        }
    }

    async applyConfigToSystem(serviceType) {
        // Apply SYSVOL configuration to local system
        try {
            if (serviceType === 'ntp') {
                // Copy SYSVOL NTP config to system
                const config = await this.readNTPConfig('current');
                if (config) {
                    await cockpit.spawn(['tee', '/etc/chrony/chrony.conf'], {
                        superuser: "try",
                        input: config
                    });
                    await cockpit.spawn(['systemctl', 'restart', 'chrony'], { superuser: "try" });
                }
            } else if (serviceType === 'dhcp') {
                // Copy SYSVOL DHCP config to system
                const config = await this.readDHCPConfig('active');
                if (config) {
                    await cockpit.spawn(['tee', '/etc/dhcp/dhcpd.conf'], {
                        superuser: "try", 
                        input: config
                    });
                    await cockpit.spawn(['systemctl', 'restart', 'isc-dhcp-server'], { superuser: "try" })
                        .catch(() => cockpit.spawn(['systemctl', 'restart', 'dhcpd'], { superuser: "try" }));
                }
            }
            
            console.log(`Applied ${serviceType} configuration from SYSVOL to system`);
            return true;
        } catch (error) {
            console.error(`Failed to apply ${serviceType} config to system:`, error);
            throw error;
        }
    }

    async syncConfigToSysvol(serviceType) {
        // Sync current system configuration to SYSVOL
        try {
            if (serviceType === 'ntp') {
                const config = await cockpit.spawn(['cat', '/etc/chrony/chrony.conf'], { superuser: "try" });
                await this.writeNTPConfig(config, 'current');
            } else if (serviceType === 'dhcp') {
                const config = await cockpit.spawn(['cat', '/etc/dhcp/dhcpd.conf'], { superuser: "try" });
                await this.writeDHCPConfig(config, 'active');
            }
            
            console.log(`Synced ${serviceType} configuration to SYSVOL`);
            return true;
        } catch (error) {
            console.error(`Failed to sync ${serviceType} config to SYSVOL:`, error);
            throw error;
        }
    }

    async getHostname() {
        try {
            const result = await cockpit.spawn(['hostname', '-s']);
            return result.trim();
        } catch (error) {
            return 'unknown';
        }
    }

    async listSysvolConfigs() {
        await this.ensureSysvolStructure();
        
        try {
            const result = await cockpit.spawn([
                'find', this.sysvolBase, '-name', '*.conf', '-o', '-name', '*.active'
            ], { superuser: "try" });
            
            return result.trim().split('\n').filter(f => f.length > 0);
        } catch (error) {
            console.error('Failed to list SYSVOL configs:', error);
            return [];
        }
    }
}