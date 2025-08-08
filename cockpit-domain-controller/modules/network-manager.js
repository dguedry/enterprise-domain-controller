/**
 * Network and Connectivity Management Module
 * Handles network interface detection, connectivity tests, and DNS configuration
 */

export class NetworkManager {
    constructor(uiManager) {
        this.uiManager = uiManager;
    }

    /**
     * Get available network interfaces
     */
    async getNetworkInterfaces() {
        try {
            const output = await cockpit.spawn(['ip', 'addr', 'show'], { superuser: "try" });
            const interfaces = this.parseNetworkInterfaces(output);
            return interfaces.filter(iface => iface.name !== 'lo'); // Exclude loopback
        } catch (error) {
            console.error('Failed to get network interfaces:', error);
            return [];
        }
    }

    /**
     * Parse network interfaces from ip addr show output
     */
    parseNetworkInterfaces(output) {
        const interfaces = [];
        const lines = output.split('\n');
        let currentInterface = null;

        for (const line of lines) {
            const interfaceMatch = line.match(/^\d+:\s+(\w+):/);
            if (interfaceMatch) {
                if (currentInterface) {
                    interfaces.push(currentInterface);
                }
                currentInterface = {
                    name: interfaceMatch[1],
                    addresses: [],
                    state: line.includes('state UP') ? 'UP' : 'DOWN'
                };
            } else if (currentInterface && line.includes('inet ')) {
                const addrMatch = line.match(/inet\s+([^\s]+)/);
                if (addrMatch) {
                    currentInterface.addresses.push(addrMatch[1]);
                }
            }
        }

        if (currentInterface) {
            interfaces.push(currentInterface);
        }

        return interfaces;
    }

    /**
     * Populate interface dropdown with available interfaces
     */
    async populateInterfaceDropdown(dropdownId) {
        const dropdown = document.getElementById(dropdownId);
        if (!dropdown) return;

        try {
            const interfaces = await this.getNetworkInterfaces();
            
            // Clear existing options
            dropdown.innerHTML = '<option value="">Select network interface...</option>';
            
            // Add interface options
            interfaces.forEach(iface => {
                const option = document.createElement('option');
                option.value = iface.name;
                option.textContent = `${iface.name} (${iface.addresses.join(', ') || 'No IP'}) - ${iface.state}`;
                dropdown.appendChild(option);
            });

            console.log(`Populated ${dropdownId} with ${interfaces.length} interfaces`);
        } catch (error) {
            console.error('Failed to populate interface dropdown:', error);
        }
    }

    /**
     * Test basic network connectivity to a host
     */
    async testConnectivity(host, timeout = 5) {
        try {
            await cockpit.spawn(['ping', '-c', '2', '-W', timeout.toString(), host], { superuser: "try" });
            return { success: true, message: `Connectivity to ${host} successful` };
        } catch (error) {
            return { 
                success: false, 
                message: `Connectivity to ${host} failed: ${error.message}` 
            };
        }
    }

    /**
     * Test SMB/CIFS port connectivity
     */
    async testSMBConnectivity(host, port = 445, timeout = 5) {
        try {
            await cockpit.spawn(['nc', '-z', '-w', timeout.toString(), host, port.toString()], { superuser: "try" });
            return { success: true, message: `SMB port ${port} on ${host} is accessible` };
        } catch (error) {
            return { 
                success: false, 
                message: `SMB port ${port} on ${host} is not accessible: ${error.message}` 
            };
        }
    }

    /**
     * Test LDAP connectivity
     */
    async testLDAPConnectivity(host, port = 389) {
        try {
            await cockpit.spawn(['ldapsearch', '-x', '-H', `ldap://${host}:${port}`, '-b', '', '-s', 'base', 'objectclass=*'], { superuser: "try" });
            return { success: true, message: `LDAP service on ${host}:${port} is accessible` };
        } catch (error) {
            return { 
                success: false, 
                message: `LDAP service on ${host}:${port} is not accessible: ${error.message}` 
            };
        }
    }

    /**
     * Test RPC connectivity
     */
    async testRPCConnectivity(host, port = 135, timeout = 5) {
        try {
            await cockpit.spawn(['nc', '-z', '-w', timeout.toString(), host, port.toString()], { superuser: "try" });
            return { success: true, message: `RPC port ${port} on ${host} is accessible` };
        } catch (error) {
            return { 
                success: false, 
                message: `RPC port ${port} on ${host} is not accessible: ${error.message}` 
            };
        }
    }

    /**
     * Comprehensive domain controller connectivity test
     */
    async testDomainControllerConnectivity(dcIP, domainName) {
        const results = [];
        
        console.log(`Testing connectivity to domain controller: ${dcIP} (${domainName})`);
        
        // Test basic network connectivity
        const pingResult = await this.testConnectivity(dcIP, 3);
        results.push({ test: 'Network Connectivity (Ping)', ...pingResult });
        
        if (!pingResult.success) {
            throw new Error(`Network connectivity failed: ${pingResult.message}`);
        }
        
        // Test SMB port connectivity
        const smbResult = await this.testSMBConnectivity(dcIP);
        results.push({ test: 'SMB Port (445)', ...smbResult });
        
        if (!smbResult.success) {
            throw new Error(`SMB connectivity failed: ${smbResult.message}`);
        }
        
        console.log('Domain controller connectivity tests passed:', results);
        return results;
    }

    /**
     * Set system hostname
     */
    async setHostname(hostname) {
        try {
            await cockpit.spawn(['hostnamectl', 'set-hostname', hostname], { superuser: "try" });
            console.log(`Hostname set to: ${hostname}`);
        } catch (error) {
            console.error('Failed to set hostname:', error);
            throw error;
        }
    }

    /**
     * Get current hostname
     */
    async getCurrentHostname() {
        try {
            const output = await cockpit.spawn(['hostname', '-f'], { superuser: "try" });
            return output.trim();
        } catch (error) {
            console.error('Failed to get hostname:', error);
            return 'unknown';
        }
    }

    /**
     * Configure static IP address on interface
     */
    async configureStaticIP(interfaceName, ipAddress, netmask, gateway, dnsServers = []) {
        try {
            console.log(`Configuring static IP on ${interfaceName}: ${ipAddress}/${netmask}`);
            
            // Create netplan configuration
            const netplanConfig = {
                network: {
                    version: 2,
                    renderer: 'networkd',
                    ethernets: {}
                }
            };
            
            netplanConfig.network.ethernets[interfaceName] = {
                dhcp4: false,
                addresses: [`${ipAddress}/${netmask}`]
            };
            
            if (gateway) {
                netplanConfig.network.ethernets[interfaceName].gateway4 = gateway;
            }
            
            if (dnsServers.length > 0) {
                netplanConfig.network.ethernets[interfaceName].nameservers = {
                    addresses: dnsServers
                };
            }
            
            // Write netplan configuration
            const configYaml = this.generateNetplanYaml(netplanConfig);
            await cockpit.file('/etc/netplan/01-cockpit-domain-controller.yaml', { superuser: "try" }).replace(configYaml);
            
            // Apply netplan configuration
            await cockpit.spawn(['netplan', 'apply'], { superuser: "try" });
            
            console.log('Static IP configuration applied successfully');
        } catch (error) {
            console.error('Failed to configure static IP:', error);
            throw error;
        }
    }

    /**
     * Generate YAML for netplan configuration
     */
    generateNetplanYaml(config) {
        // Simple YAML generation for netplan
        let yaml = 'network:\n';
        yaml += '  version: 2\n';
        yaml += '  renderer: networkd\n';
        yaml += '  ethernets:\n';
        
        for (const [iface, settings] of Object.entries(config.network.ethernets)) {
            yaml += `    ${iface}:\n`;
            yaml += `      dhcp4: ${settings.dhcp4}\n`;
            
            if (settings.addresses) {
                yaml += '      addresses:\n';
                settings.addresses.forEach(addr => {
                    yaml += `        - ${addr}\n`;
                });
            }
            
            if (settings.gateway4) {
                yaml += `      gateway4: ${settings.gateway4}\n`;
            }
            
            if (settings.nameservers) {
                yaml += '      nameservers:\n';
                yaml += '        addresses:\n';
                settings.nameservers.addresses.forEach(dns => {
                    yaml += `          - ${dns}\n`;
                });
            }
        }
        
        return yaml;
    }

    /**
     * Update DNS configuration for domain
     */
    async updateDNSConfiguration(domainName, dcIP) {
        try {
            console.log(`Updating DNS configuration for domain: ${domainName}, DC: ${dcIP}`);
            
            // Create resolv.conf entry
            const resolvConf = `# Generated by cockpit-domain-controller
nameserver ${dcIP}
search ${domainName}
`;
            
            // Backup original resolv.conf
            try {
                await cockpit.spawn(['cp', '/etc/resolv.conf', '/etc/resolv.conf.backup'], { superuser: "try" });
            } catch (backupError) {
                console.log('Could not backup resolv.conf:', backupError);
            }
            
            // Write new resolv.conf
            await cockpit.file('/etc/resolv.conf', { superuser: "try" }).replace(resolvConf);
            
            console.log('DNS configuration updated successfully');
        } catch (error) {
            console.error('Failed to update DNS configuration:', error);
            throw error;
        }
    }

    /**
     * Test DNS resolution for domain
     */
    async testDNSResolution(domainName) {
        try {
            await cockpit.spawn(['nslookup', domainName], { superuser: "try" });
            return { success: true, message: `DNS resolution for ${domainName} successful` };
        } catch (error) {
            return { 
                success: false, 
                message: `DNS resolution for ${domainName} failed: ${error.message}` 
            };
        }
    }

    /**
     * Get network interface IP address
     */
    async getInterfaceIP(interfaceName) {
        try {
            const output = await cockpit.spawn(['ip', 'addr', 'show', interfaceName], { superuser: "try" });
            const match = output.match(/inet\s+([^\/\s]+)/);
            return match ? match[1] : null;
        } catch (error) {
            console.error(`Failed to get IP for interface ${interfaceName}:`, error);
            return null;
        }
    }

    /**
     * Validate network configuration before domain operations
     */
    async validateNetworkConfiguration(selectedInterface, domainName) {
        const issues = [];
        
        try {
            // Check if selected interface exists and has IP
            const interfaces = await this.getNetworkInterfaces();
            const iface = interfaces.find(i => i.name === selectedInterface);
            
            if (!iface) {
                issues.push(`Selected interface '${selectedInterface}' not found`);
                return { valid: false, issues };
            }
            
            if (iface.addresses.length === 0) {
                issues.push(`Interface '${selectedInterface}' has no IP address assigned`);
            }
            
            if (iface.state !== 'UP') {
                issues.push(`Interface '${selectedInterface}' is not in UP state`);
            }
            
            // Test basic network connectivity
            const ip = iface.addresses[0]?.split('/')[0];
            if (ip) {
                const gateway = await this.getDefaultGateway();
                if (gateway) {
                    const connTest = await this.testConnectivity(gateway, 2);
                    if (!connTest.success) {
                        issues.push(`Cannot reach default gateway: ${gateway}`);
                    }
                }
            }
            
        } catch (error) {
            issues.push(`Network validation failed: ${error.message}`);
        }
        
        return {
            valid: issues.length === 0,
            issues
        };
    }

    /**
     * Get default gateway
     */
    async getDefaultGateway() {
        try {
            const output = await cockpit.spawn(['ip', 'route', 'show', 'default'], { superuser: "try" });
            const match = output.match(/default via ([^\s]+)/);
            return match ? match[1] : null;
        } catch (error) {
            console.error('Failed to get default gateway:', error);
            return null;
        }
    }
}