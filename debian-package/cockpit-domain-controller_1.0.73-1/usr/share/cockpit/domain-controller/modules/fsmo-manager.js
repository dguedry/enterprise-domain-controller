/**
 * FSMO Operations Module
 * Handles all FSMO role operations including transfer, seize, and monitoring
 */

const _ = cockpit.gettext;

export class FSMOManager {
    constructor(uiManager, serviceManager) {
        this.uiManager = uiManager;
        this.serviceManager = serviceManager;
        this.roleMapping = {
            'pdc': 'pdc',
            'rid': 'rid',
            'infrastructure': 'infrastructure',
            'schema': 'schema',
            'domain-naming': 'naming'
        };
    }

    /**
     * Load and display FSMO roles
     */
    async loadFSMORoles() {
        console.log('Loading FSMO roles...');

        const roleElements = {
            'pdc-holder': { element: document.getElementById('pdc-holder'), role: 'PdcEmulationMasterRole' },
            'rid-holder': { element: document.getElementById('rid-holder'), role: 'RidAllocationMasterRole' },
            'infrastructure-holder': { element: document.getElementById('infrastructure-holder'), role: 'InfrastructureMasterRole' },
            'schema-holder': { element: document.getElementById('schema-holder'), role: 'SchemaMasterRole' },
            'domain-naming-holder': { element: document.getElementById('domain-naming-holder'), role: 'DomainNamingMasterRole' }
        };

        // Set loading state
        Object.values(roleElements).forEach(({ element }) => {
            element.textContent = _("Loading...");
            element.className = 'fsmo-role-holder loading';
        });

        try {
            let output, hostname, thisServer;

            // Try to get FSMO roles, with fallback for permission issues
            try {
                output = await cockpit.spawn(['samba-tool', 'fsmo', 'show'], { superuser: "try" });
            } catch (fsmoError) {
                console.log('Direct FSMO query failed, trying alternative methods:', fsmoError.message);
                // Set loading error but don't completely fail
                this.handleFSMOLoadError(fsmoError, roleElements);
                return;
            }

            try {
                hostname = await cockpit.spawn(['hostname', '-f'], { superuser: "try" });
                thisServer = hostname.trim().toLowerCase();
            } catch (hostnameError) {
                console.log('Could not get hostname, using fallback');
                thisServer = 'dc2'; // fallback based on samba config
            }

            this.processFSMORoles(output, roleElements, thisServer);
        } catch (error) {
            console.error('Failed to load FSMO roles:', error);
            this.handleFSMOLoadError(error, roleElements);
        }
    }

    /**
     * Process FSMO roles output and update UI
     */
    processFSMORoles(output, roleElements, thisServer) {
        const lines = output.split('\n');

        Object.entries(roleElements).forEach(([id, { element, role }]) => {
            const roleLine = lines.find(line => line.includes(role + ' owner:'));

            if (roleLine) {
                const match = roleLine.match(new RegExp(role + ' owner: (.+)'));

                if (match) {
                    const roleOwner = match[1].trim();
                    const serverName = this.extractServerName(roleOwner);

                    element.textContent = serverName;
                    element.setAttribute('title', roleOwner);

                    const isThisServer = roleOwner.toLowerCase().includes(thisServer) ||
                                       thisServer.includes(roleOwner.toLowerCase());

                    element.className = isThisServer ? 'fsmo-role-holder this-server' : 'fsmo-role-holder';

                    this.updateFSMOButtons(id, isThisServer);
                } else {
                    element.textContent = _("Parse error");
                    element.className = 'fsmo-role-holder';
                }
            } else {
                element.textContent = _("Not found");
                element.className = 'fsmo-role-holder';
            }
        });
    }

    /**
     * Handle FSMO load errors
     */
    handleFSMOLoadError(error, roleElements) {
        let errorText = _("Error loading roles");

        if (error.message?.includes('Permission denied')) {
            errorText = _("Permission denied - try refreshing");
        } else if (error.message?.includes('Failed to connect')) {
            errorText = _("Service not running");
        } else if (error.message?.includes('tdb')) {
            errorText = _("Database access issue");
        }

        console.log('Setting FSMO role elements to error state:', errorText);

        Object.values(roleElements).forEach(({ element }) => {
            if (element) {
                element.textContent = errorText;
                element.className = 'fsmo-role-holder error';
                element.style.display = ''; // Ensure element remains visible
            }
        });

        // Make sure buttons remain enabled so user can still attempt operations
        this.updateAllFSMOButtons(false); // false = not this server, so enable transfer buttons
    }

    /**
     * Update all FSMO button states
     */
    updateAllFSMOButtons(isThisServer) {
        const roles = ['pdc', 'rid', 'infrastructure', 'schema', 'domain-naming'];
        roles.forEach(role => {
            this.updateFSMOButtons(`${role}-holder`, isThisServer);
        });
    }

    /**
     * Transfer FSMO role to this server
     */
    async transferFSMORole(role) {
        const roleName = this.getFSMORoleName(role);

        if (!confirm(`Are you sure you want to transfer the ${roleName} role to this server?`)) {
            return;
        }

        // Get domain admin credentials
        const credentials = await this.getDomainAdminCredentials();
        if (!credentials) {
            return; // User cancelled
        }

        console.log('Transferring FSMO role:', role);
        this.uiManager.showLoading(`Transferring ${roleName} role...`);

        const sambaRole = this.roleMapping[role];
        if (!sambaRole) {
            this.uiManager.hideLoading();
            this.uiManager.showError('Unknown FSMO role: ' + role);
            return;
        }

        try {
            // Run diagnostics first
            const diagnostics = await this.testFSMOConnectivity(sambaRole, role);

            if (!diagnostics.canProceed) {
                this.uiManager.hideLoading();

                // Show enhanced error with option to proceed anyway
                const errorMessage = `FSMO transfer blocked:\n\n${diagnostics.issues.join('\n')}\n\nOptions:\n• Use 'Seize' button instead (bypasses connectivity tests)\n• Or click 'Continue Anyway' to attempt transfer despite connectivity issues`;

                const proceed = confirm(`${errorMessage}\n\nWould you like to continue with the transfer anyway?\n\n⚠️ This may fail if the PDC is truly unreachable.`);

                if (!proceed) {
                    return;
                }

                console.log('User chose to proceed with FSMO transfer despite connectivity issues');
                this.uiManager.showLoading(`Attempting ${roleName} transfer...`);
            }

            // Set up authentication context before transfer
            await this.setupAuthenticationContext(credentials);

            await this.performFSMOTransfer(sambaRole, role, credentials);
        } catch (error) {
            console.error('FSMO role transfer failed:', error);
            this.uiManager.hideLoading();

            let errorMessage = `Failed to transfer ${roleName} role: ${error.message}`;

            // Provide specific guidance based on common error types
            if (error.message.includes('NT_STATUS_LOGON_FAILURE') || error.message.includes('authentication')) {
                errorMessage += `\n\n💡 Authentication issue - Check:\n• Username/password are correct\n• Account has domain admin privileges\n• Domain connectivity`;
            } else if (error.message.includes('NT_STATUS_CONNECTION_REFUSED') || error.message.includes('timeout')) {
                errorMessage += `\n\n💡 Connection issue - The current role holder may be:\n• Offline or unreachable\n• Behind a firewall\n• Network connectivity problems\n\n🔧 Try: Use "Seize" button for emergency takeover`;
            } else if (error.message.includes('already holds') || error.message.includes('same server')) {
                errorMessage += `\n\n💡 This server may already hold the role. Refreshing display...`;
                // Refresh the display to show current state
                setTimeout(() => this.loadFSMORoles(), 1000);
            }

            this.uiManager.showError(errorMessage);
        }
    }

    /**
     * Seize FSMO role (emergency operation)
     */
    async seizeFSMORole(role) {
        const roleName = this.getFSMORoleName(role);
        const warningMessage = `WARNING: Seizing the ${roleName} role should only be done in emergency situations when the current role holder is permanently unavailable. This can cause replication issues if the original role holder comes back online.\n\nAre you absolutely sure you want to SEIZE this role?`;

        if (!confirm(warningMessage)) {
            return;
        }

        // Get domain admin credentials
        const credentials = await this.getDomainAdminCredentials();
        if (!credentials) {
            return; // User cancelled
        }

        console.log('Seizing FSMO role:', role);
        this.uiManager.showLoading(`Seizing ${roleName} role...`);

        const sambaRole = this.roleMapping[role];
        if (!sambaRole) {
            this.uiManager.hideLoading();
            this.uiManager.showError('Unknown FSMO role: ' + role);
            return;
        }

        try {
            // Set up authentication context before seize
            await this.setupAuthenticationContext(credentials);

            const command = ['samba-tool', 'fsmo', 'seize', '--role=' + sambaRole];
            if (credentials.username) {
                // Format username for domain authentication
                let username = credentials.username;
                if (!username.includes('@') && !username.includes('\\')) {
                    // Add domain suffix if not present
                    try {
                        const domainName = await this.getCurrentDomainName();
                        if (domainName) {
                            username = `${credentials.username}@${domainName}`;
                            console.log('Formatted username for domain auth:', username);
                        }
                    } catch (error) {
                        console.log('Could not determine domain for username formatting');
                    }
                }
                command.push('-U', username);
            }

            // Use simple bind authentication to avoid machine account issues
            command.push('--use-kerberos=off');

            const process = cockpit.spawn(command, { superuser: "try" });

            // Send password via stdin if provided
            if (credentials.password) {
                process.input(credentials.password + '\n', true);
            }

            const output = await process;

            console.log('FSMO role seizure successful:', output);
            this.uiManager.hideLoading();
            this.uiManager.showSuccess(`${roleName} role seized successfully!`);

            // Special handling for PDC Emulator
            if (role === 'pdc') {
                await this.handlePDCTransfer();
            }

            // Refresh FSMO roles display and main domain status
            setTimeout(() => {
                this.loadFSMORoles();

                // Refresh main domain status to show updated role holder
                if (window.domainController && typeof window.domainController.checkDomainStatus === 'function') {
                    console.log('Refreshing domain status after FSMO seizure...');
                    window.domainController.checkDomainStatus();
                }
            }, 2000);

            // Also refresh domain status immediately for PDC role changes
            if (role === 'pdc') {
                setTimeout(() => {
                    if (window.domainController && typeof window.domainController.checkDomainStatus === 'function') {
                        console.log('Immediate domain status refresh for PDC role change...');
                        window.domainController.checkDomainStatus();
                    }
                }, 500);
            }
        } catch (error) {
            console.error('FSMO role seizure failed:', error);
            this.uiManager.hideLoading();
            this.uiManager.showError(`Failed to seize ${roleName} role: ` + error.message);
        }
    }

    /**
     * Perform FSMO transfer with timeout protection
     */
    async performFSMOTransfer(sambaRole, role, credentials) {
        const command = ['samba-tool', 'fsmo', 'transfer', '--role=' + sambaRole];

        // Add explicit server target using --URL parameter
        try {
            const currentPDC = await this.getCurrentPDCHolder();
            if (currentPDC) {
                // Use ldap URL format to target specific DC
                command.push('-H', `ldap://${currentPDC}`);
                console.log('Targeting specific DC server via LDAP:', currentPDC);
            }
        } catch (error) {
            console.log('Could not determine target server, using default discovery');
        }

        if (credentials.username) {
            // Format username for domain authentication
            let username = credentials.username;
            if (!username.includes('@') && !username.includes('\\')) {
                // Add domain suffix if not present
                try {
                    const domainName = await this.getCurrentDomainName();
                    if (domainName) {
                        username = `${credentials.username}@${domainName}`;
                        console.log('Formatted username for domain auth:', username);
                    }
                } catch (error) {
                    console.log('Could not determine domain for username formatting');
                }
            }
            command.push('-U', username);
        }

        // Use simple bind authentication to avoid machine account issues
        command.push('--use-kerberos=off');

        console.log('Executing FSMO transfer command:', command.join(' '));
        console.log('Using credentials for user:', credentials.username || 'default');

        const transferProcess = cockpit.spawn(command, {
            superuser: "try",
            err: "out"  // Capture stderr with stdout for better debugging
        });
        let transferTimedOut = false;

        // Send password via stdin if provided
        if (credentials.password) {
            console.log('Sending password to samba-tool process...');
            transferProcess.input(credentials.password + '\n', true);
        }

        // Add progress logging
        transferProcess.stream((data) => {
            console.log('FSMO transfer progress:', data);
        });

        // Set up timeout protection with longer timeout for remote transfers
        const timeoutId = setTimeout(() => {
            console.log('FSMO transfer command timed out after 60 seconds');
            transferTimedOut = true;
            transferProcess.close();
            this.uiManager.hideLoading();
            this.uiManager.showError(`FSMO transfer timed out after 60 seconds.\n\n⚠️  The current role holder may be:\n• Offline or unreachable\n• Network connectivity issues\n• Authentication problems\n\n💡 Solutions:\n• Use the "Seize" button for emergency takeover\n• Check if the current role holder is online\n• Verify network connectivity between DCs`);
        }, 60000);

        try {
            const output = await transferProcess;
            clearTimeout(timeoutId);

            // Don't show success if we already timed out
            if (transferTimedOut) {
                return;
            }

            console.log('FSMO role transfer output:', output);

            // Check if the transfer actually succeeded by examining the output
            const transferSucceeded = this.parseTransferResult(output, role);

            this.uiManager.hideLoading();

            if (transferSucceeded) {
                // Verify the transfer actually worked by checking FSMO roles
                console.log('Transfer appears successful, verifying...');
                this.uiManager.showLoading('Verifying FSMO transfer...');

                try {
                    // Wait a moment for AD replication
                    await new Promise(resolve => setTimeout(resolve, 3000));

                    // Check if we now hold the role
                    const verificationResult = await this.verifyFSMOTransfer(role);
                    this.uiManager.hideLoading();

                    if (verificationResult.success) {
                        this.uiManager.showSuccess(`✓ ${this.getFSMORoleName(role)} role transferred successfully and verified!`);

                        // Special handling for PDC Emulator
                        if (role === 'pdc') {
                            await this.handlePDCTransfer();
                        }

                        // Refresh FSMO roles display immediately
                        console.log('Refreshing FSMO roles display after successful transfer...');
                        this.loadFSMORoles();

                        // Also refresh after a delay to ensure replication
                        setTimeout(() => {
                            console.log('Second refresh of FSMO roles after replication delay...');
                            this.loadFSMORoles();
                        }, 2000);

                        // Also refresh domain status immediately for PDC role changes
                        if (role === 'pdc') {
                            setTimeout(() => {
                                if (window.domainController && typeof window.domainController.checkDomainStatus === 'function') {
                                    console.log('Immediate domain status refresh for PDC role transfer...');
                                    window.domainController.checkDomainStatus();
                                }
                            }, 500);
                        }
                    } else {
                        this.uiManager.showError(`FSMO transfer verification failed: ${verificationResult.message}. The role may not have transferred properly.`);
                        // Still refresh the display to show current state
                        setTimeout(() => {
                            this.loadFSMORoles();
                        }, 1000);
                    }
                } catch (verifyError) {
                    console.error('FSMO transfer verification failed:', verifyError);
                    this.uiManager.hideLoading();
                    this.uiManager.showSuccess(`${this.getFSMORoleName(role)} transfer completed, but verification failed. Check the roles display.`);

                    // Refresh FSMO roles display anyway
                    setTimeout(() => {
                        this.loadFSMORoles();
                    }, 1000);
                }
            } else {
                this.uiManager.showError(`FSMO transfer failed. The command completed but the role may not have transferred. Output: ${output}`);
                // Still refresh to show current state
                setTimeout(() => {
                    this.loadFSMORoles();
                }, 1000);
            }
        } catch (error) {
            clearTimeout(timeoutId);

            // Don't show error if we already timed out
            if (transferTimedOut) {
                return;
            }

            throw error;
        }
    }

    /**
     * Parse transfer result to determine if it actually succeeded
     */
    parseTransferResult(output, role) {
        console.log('Parsing FSMO transfer result. Raw output:', JSON.stringify(output));
        console.log('Output length:', output ? output.length : 0);

        // Look for failure indicators first
        const failurePatterns = [
            /failed/i,
            /error/i,
            /could not/i,
            /unable/i,
            /not reachable/i,
            /connection.*refused/i,
            /timeout/i,
            /werr_/i
        ];

        // Check for failure patterns first
        for (const pattern of failurePatterns) {
            if (pattern.test(output)) {
                console.log('Transfer failed based on output pattern:', pattern, 'Output:', output);
                return false;
            }
        }

        // Look for success indicators in the output
        const successPatterns = [
            /transfer.*success/i,
            /role.*transferred/i,
            /successfully.*transferred/i,
            /completed.*successfully/i,
            /transfer.*complete/i
        ];

        // Check for success patterns
        for (const pattern of successPatterns) {
            if (pattern.test(output)) {
                console.log('Transfer succeeded based on output pattern:', pattern);
                return true;
            }
        }

        // Special case: Empty output from samba-tool often means success
        // samba-tool fsmo transfer typically produces no output on success
        if (!output || output.trim().length === 0) {
            console.log('Empty output detected - this usually indicates success for FSMO operations');
            return true;
        }

        // If we have output but no clear success/failure patterns, assume success
        console.log('Transfer result unclear but no failure patterns detected, assuming success');
        return true;
    }

    /**
     * Verify that FSMO transfer actually succeeded
     */
    async verifyFSMOTransfer(role) {
        try {
            console.log('Verifying FSMO transfer for role:', role);

            // Get current hostname
            const hostname = await cockpit.spawn(['hostname', '-f'], { superuser: "try" });
            const thisServer = hostname.trim().toLowerCase();
            console.log('This server hostname:', thisServer);

            // Query current FSMO roles
            let output;
            try {
                output = await cockpit.spawn(['samba-tool', 'fsmo', 'show'], { superuser: "try" });
            } catch (error) {
                console.log('Could not query FSMO roles for verification:', error);
                return { success: false, message: 'Could not query FSMO roles for verification' };
            }

            // Map role names to FSMO role strings
            const roleMapping = {
                'pdc': 'PdcEmulationMasterRole',
                'rid': 'RidAllocationMasterRole',
                'infrastructure': 'InfrastructureMasterRole',
                'schema': 'SchemaMasterRole',
                'domain-naming': 'DomainNamingMasterRole'
            };

            const fsmoRoleName = roleMapping[role];
            if (!fsmoRoleName) {
                return { success: false, message: 'Unknown role for verification' };
            }

            // Parse the output to find the role holder
            const lines = output.split('\n');
            const roleLine = lines.find(line => line.includes(fsmoRoleName + ' owner:'));

            if (!roleLine) {
                return { success: false, message: `Could not find ${fsmoRoleName} in FSMO output` };
            }

            const match = roleLine.match(new RegExp(fsmoRoleName + ' owner: (.+)'));
            if (match) {
                const roleOwner = match[1].trim().toLowerCase();
                console.log('Current role owner:', roleOwner);
                console.log('This server:', thisServer);

                // Check if this server now owns the role
                const isThisServer = roleOwner.includes(thisServer) || thisServer.includes(roleOwner.toLowerCase());

                if (isThisServer) {
                    console.log('✓ FSMO transfer verification successful');
                    return { success: true, message: 'Transfer verified successfully' };
                } else {
                    console.log('✗ FSMO transfer verification failed - role still owned by:', roleOwner);
                    return { success: false, message: `Role still owned by ${roleOwner}` };
                }
            }

            return { success: false, message: 'Could not parse role ownership information' };
        } catch (error) {
            console.error('Error during FSMO transfer verification:', error);
            return { success: false, message: 'Verification failed: ' + error.message };
        }
    }

    /**
     * Test FSMO connectivity before transfer
     */
    async testFSMOConnectivity(sambaRole, role) {
        const results = {
            canProceed: false,
            issues: []
        };

        try {
            // First, discover the current PDC Emulator holder
            const currentPDC = await this.getCurrentPDCHolder();
            if (!currentPDC) {
                results.issues.push('• Cannot determine current PDC Emulator holder');
                results.canProceed = false;
                return results;
            }

            console.log('Testing connectivity to current PDC:', currentPDC);

            // Build test targets list with resolved IP as fallback
            let testTargets = [currentPDC];

            // Try to resolve the FQDN to IP and add as backup target
            try {
                const nslookupOutput = await cockpit.spawn(['nslookup', currentPDC], { superuser: "try" });
                const ipMatch = nslookupOutput.match(/Address:\s*(\d+\.\d+\.\d+\.\d+)/);
                if (ipMatch && ipMatch[1] !== currentPDC) {
                    testTargets.push(ipMatch[1]);
                    console.log(`Adding resolved IP as fallback target: ${ipMatch[1]}`);
                }
            } catch (error) {
                console.log('Could not resolve PDC FQDN to IP for fallback testing');
            }

            // Test connectivity to all possible targets - skip local FSMO query since it's failing
            let connectivitySuccess = false;

            for (const target of testTargets) {
                console.log(`Testing connectivity to: ${target}`);
                let targetSuccess = true;

                // Test network connectivity
                try {
                    console.log(`Testing network connectivity to ${target}...`);
                    await cockpit.spawn(['ping', '-c', '2', '-W', '3', target], { superuser: "try" });
                    console.log(`✓ Network connectivity to ${target} successful`);
                } catch (error) {
                    console.log(`✗ Network connectivity to ${target} failed:`, error.message);
                    targetSuccess = false;
                }

                // Test SMB port
                try {
                    console.log(`Testing SMB port connectivity to ${target}...`);
                    await cockpit.spawn(['nc', '-z', '-w', '5', target, '445'], { superuser: "try" });
                    console.log(`✓ SMB port connectivity to ${target} successful`);
                } catch (error) {
                    console.log(`✗ SMB port connectivity to ${target} failed:`, error.message);
                    targetSuccess = false;
                }

                if (targetSuccess) {
                    connectivitySuccess = true;
                    console.log(`✓ Successfully connected to PDC at ${target}`);

                    // Since basic connectivity works, the issue is likely permissions, not network
                    // Allow the transfer to proceed - the samba-tool command will use proper auth
                    results.canProceed = true;
                    break;
                }
            }

            if (!connectivitySuccess) {
                const targetList = testTargets.join(', ');
                results.issues.push(`• Cannot connect to domain controller (tried: ${targetList})`);
                results.issues.push('• Network connectivity failed to all tested addresses');
                results.issues.push(`• Make sure the PDC at ${currentPDC} is accessible and running`);
                results.canProceed = false;
            } else {
                console.log('✓ Connectivity test passed - FSMO transfer should work with proper credentials');
            }

            if (!results.canProceed) {
                results.issues.push('');
                results.issues.push('💡 These issues prevent graceful FSMO transfer.');
                results.issues.push('💡 FSMO "Seize" operations work locally and bypass these checks.');
            }

            return results;
        } catch (error) {
            console.error('Error during connectivity testing:', error);
            results.issues.push('• Failed to perform connectivity tests: ' + error.message);
            results.canProceed = false;
            return results;
        }
    }

    /**
     * Get the current PDC Emulator holder hostname
     */
    async getCurrentPDCHolder() {
        try {
            // First try with elevated permissions if needed
            let output;
            try {
                output = await cockpit.spawn(['samba-tool', 'fsmo', 'show'], { superuser: "try" });
            } catch (permissionError) {
                console.log('Permission denied for local FSMO query, using fallback discovery methods');
                return await this.discoverPDCFromDNS();
            }

            const lines = output.split('\n');
            const pdcLine = lines.find(line => line.includes('PdcEmulationMasterRole owner:'));

            if (pdcLine) {
                const match = pdcLine.match(/PdcEmulationMasterRole owner: (.+)/);
                if (match) {
                    // Extract server name from FSMO format like "CN=NTDS Settings,CN=DC1,CN=Servers,CN=Default-First-Site-Name,CN=Sites,CN=Configuration,DC=example,DC=com"
                    const ownerString = match[1].trim();
                    const serverMatch = ownerString.match(/CN=NTDS Settings,CN=([^,]+)/);

                    if (serverMatch) {
                        const serverName = serverMatch[1];
                        console.log('Current PDC Emulator holder from FSMO:', serverName);

                        // Try to resolve the hostname to get the FQDN
                        const resolvedFQDN = await this.tryResolveHostname(serverName);
                        return resolvedFQDN;
                    }
                }
            }

            // If we can't parse the FSMO output, use DNS fallback
            console.log('Could not parse FSMO output, using DNS discovery as fallback');
            return await this.discoverPDCFromDNS();
        } catch (error) {
            console.error('Failed to get current PDC holder:', error);
            // Use DNS discovery as final fallback
            return await this.discoverPDCFromDNS();
        }
    }

    /**
     * Discover PDC FQDN from DNS and system configuration
     */
    async discoverPDCFromDNS() {
        try {
            // Try to get domain name from system configuration
            const domainName = await this.getCurrentDomainName();
            if (domainName) {
                // Try common PDC naming patterns
                const pdcCandidates = [
                    `dc1.${domainName}`,
                    `pdc.${domainName}`,
                    `dc.${domainName}`
                ];

                for (const candidate of pdcCandidates) {
                    try {
                        console.log(`Testing PDC candidate: ${candidate}`);
                        await cockpit.spawn(['nslookup', candidate], { superuser: "try" });
                        console.log(`✓ Found valid PDC FQDN: ${candidate}`);
                        return candidate;
                    } catch (error) {
                        console.log(`✗ PDC candidate ${candidate} not resolvable`);
                        continue;
                    }
                }
            }

            // Try to extract from /etc/hosts as fallback
            try {
                const hostsContent = await cockpit.file('/etc/hosts', { superuser: "try" }).read();
                const dcMatch = hostsContent.match(/\d+\.\d+\.\d+\.\d+\s+(dc1\.[\w.-]+)/);
                if (dcMatch) {
                    const fqdn = dcMatch[1];
                    console.log(`Found PDC FQDN in /etc/hosts: ${fqdn}`);
                    return fqdn;
                }
            } catch (hostError) {
                console.log('Could not read /etc/hosts for PDC discovery');
            }

            // Last resort: return a reasonable guess based on common patterns
            console.log('Using dc1.guedry.local as final fallback');
            return 'dc1.guedry.local';
        } catch (error) {
            console.error('PDC discovery failed:', error);
            return 'dc1.guedry.local';
        }
    }

    /**
     * Get current domain name from system configuration
     */
    async getCurrentDomainName() {
        try {
            // Try to get domain from samba configuration
            try {
                const sambaConfig = await cockpit.file('/etc/samba/smb.conf', { superuser: "try" }).read();
                const realmMatch = sambaConfig.match(/realm\s*=\s*(.+)/i);
                if (realmMatch) {
                    return realmMatch[1].trim().toLowerCase();
                }
            } catch (error) {
                console.log('Could not read samba config for domain name');
            }

            // Try to get domain from Kerberos config
            try {
                const krbConfig = await cockpit.file('/etc/krb5.conf', { superuser: "try" }).read();
                const defaultRealmMatch = krbConfig.match(/default_realm\s*=\s*(.+)/i);
                if (defaultRealmMatch) {
                    return defaultRealmMatch[1].trim().toLowerCase();
                }
            } catch (error) {
                console.log('Could not read krb5 config for domain name');
            }

            // Try hostname command as fallback
            try {
                const hostname = await cockpit.spawn(['hostname', '-d'], { superuser: "try" });
                if (hostname && hostname.trim()) {
                    return hostname.trim().toLowerCase();
                }
            } catch (error) {
                console.log('Could not get domain from hostname command');
            }

            return null;
        } catch (error) {
            console.error('Failed to get current domain name:', error);
            return null;
        }
    }

    /**
     * Set up authentication context for FSMO operations
     */
    async setupAuthenticationContext(credentials) {
        try {
            console.log('Setting up authentication context for FSMO transfer...');

            // Start Winbind service if not running (needed for domain authentication)
            try {
                console.log('Starting Winbind service...');
                await cockpit.spawn(['systemctl', 'start', 'winbind'], { superuser: "try" });
                // Give it a moment to start up
                await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (error) {
                console.log('Note: Could not start Winbind service:', error.message);
            }

            // Clear any existing Kerberos tickets
            try {
                await cockpit.spawn(['kdestroy'], { superuser: "try" });
                console.log('Cleared existing Kerberos tickets');
            } catch (error) {
                console.log('No existing Kerberos tickets to clear');
            }

            // Get a Kerberos ticket for domain authentication
            if (credentials && credentials.username && credentials.password) {
                try {
                    console.log('Obtaining Kerberos ticket for', credentials.username);
                    const kinit = cockpit.spawn(['kinit', credentials.username], { superuser: "try" });
                    kinit.input(credentials.password + '\n', true);
                    await kinit;
                    console.log('✓ Kerberos authentication successful');
                } catch (error) {
                    console.log('Warning: Kerberos authentication failed:', error.message);
                    // Don't fail here - samba-tool might still work with username/password
                }
            }

            console.log('Authentication context setup completed');
        } catch (error) {
            console.error('Error setting up authentication context:', error);
            // Don't throw - let the FSMO transfer attempt proceed
        }
    }

    /**
     * Get domain admin credentials from user
     */
    async getDomainAdminCredentials() {
        try {
            // First, try to discover the domain admin username from domain info
            let suggestedUsername = 'Administrator';
            let domainName = '';

            try {
                const domainInfo = await cockpit.spawn(['samba-tool', 'domain', 'info'], { superuser: "try" });
                const domainMatch = domainInfo.match(/Domain\s*:\s*([^\s]+)/i);
                if (domainMatch) {
                    domainName = domainMatch[1];
                    suggestedUsername = `${domainName}\\Administrator`;
                }
            } catch (error) {
                console.log('Could not get domain info for username suggestion:', error);
            }

            // Use a more secure credential prompt
            return await this.promptForCredentials(suggestedUsername);
        } catch (error) {
            console.error('Error getting credentials:', error);
            this.uiManager.showError('Failed to get credentials: ' + error.message);
            return null;
        }
    }

    /**
     * Prompt for credentials using a secure dialog
     */
    async promptForCredentials(defaultUsername) {
        return new Promise((resolve) => {
            // Create temporary credential form
            const existingModal = document.getElementById('credential-modal');
            if (existingModal) {
                existingModal.remove();
            }

            const modal = document.createElement('div');
            modal.id = 'credential-modal';
            modal.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.7);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 10000;
            `;

            const dialog = document.createElement('div');
            dialog.style.cssText = `
                background: var(--pf-v5-global--BackgroundColor--100);
                padding: 20px;
                border-radius: 8px;
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
                min-width: 400px;
                max-width: 500px;
                color: var(--pf-v5-global--Color--100);
            `;

            dialog.innerHTML = `
                <h3>Domain Administrator Credentials</h3>
                <p>Enter credentials for FSMO role transfer:</p>
                <div style="margin: 15px 0;">
                    <label for="cred-username" style="display: block; margin-bottom: 5px;">Username:</label>
                    <input type="text" id="cred-username" value="${defaultUsername}"
                           style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px;
                                  background: var(--pf-v5-global--BackgroundColor--200);
                                  color: var(--pf-v5-global--Color--100);">
                    <small style="color: var(--pf-v5-global--Color--200);">Format: DOMAIN\\username or just username</small>
                </div>
                <div style="margin: 15px 0;">
                    <label for="cred-password" style="display: block; margin-bottom: 5px;">Password:</label>
                    <input type="password" id="cred-password"
                           style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px;
                                  background: var(--pf-v5-global--BackgroundColor--200);
                                  color: var(--pf-v5-global--Color--100);">
                </div>
                <div style="text-align: right; margin-top: 20px;">
                    <button id="cred-cancel" style="margin-right: 10px; padding: 8px 16px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer;">Cancel</button>
                    <button id="cred-ok" style="padding: 8px 16px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer;">OK</button>
                </div>
            `;

            modal.appendChild(dialog);
            document.body.appendChild(modal);

            const usernameInput = document.getElementById('cred-username');
            const passwordInput = document.getElementById('cred-password');
            const cancelBtn = document.getElementById('cred-cancel');
            const okBtn = document.getElementById('cred-ok');

            // Focus the password field if username is pre-filled
            if (defaultUsername) {
                passwordInput.focus();
            } else {
                usernameInput.focus();
            }

            const cleanup = () => {
                modal.remove();
            };

            const handleSubmit = () => {
                const username = usernameInput.value.trim();
                const password = passwordInput.value;

                if (!username || !password) {
                    alert('Please enter both username and password');
                    return;
                }

                cleanup();
                resolve({ username, password });
            };

            const handleCancel = () => {
                cleanup();
                resolve(null);
            };

            // Event listeners
            cancelBtn.addEventListener('click', handleCancel);
            okBtn.addEventListener('click', handleSubmit);

            // Handle Enter key
            passwordInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    handleSubmit();
                }
            });

            usernameInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    passwordInput.focus();
                }
            });

            // Handle Escape key
            modal.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    handleCancel();
                }
            });
        });
    }

    /**
     * Try to resolve hostname, falling back to different formats if needed
     */
    async tryResolveHostname(serverName) {
        const candidates = [
            serverName.toLowerCase(),
            serverName.toLowerCase() + '.local'
        ];

        // Try to get the current domain name and add it as a candidate
        try {
            const domainOutput = await cockpit.spawn(['samba-tool', 'domain', 'info'], { superuser: "try" });
            const domainMatch = domainOutput.match(/Domain\s*:\s*([^\s]+)/i);
            if (domainMatch) {
                const domainName = domainMatch[1].toLowerCase();
                candidates.push(serverName.toLowerCase() + '.' + domainName);
            }
        } catch (error) {
            console.log('Could not determine domain name for hostname resolution');
        }

        // Try to resolve hostname to IP address using getent hosts
        try {
            const getentOutput = await cockpit.spawn(['getent', 'hosts', serverName.toLowerCase()], { superuser: "try" });
            const ipMatch = getentOutput.trim().split(/\s+/)[0];
            if (ipMatch && /^\d+\.\d+\.\d+\.\d+$/.test(ipMatch)) {
                candidates.unshift(ipMatch); // Put IP first in the list
                console.log(`Resolved ${serverName} to IP address: ${ipMatch}`);
            }
        } catch (error) {
            console.log('Could not resolve hostname to IP:', error.message);
        }

        // Test each candidate
        for (const candidate of candidates) {
            try {
                console.log('Testing hostname candidate:', candidate);
                await cockpit.spawn(['ping', '-c', '1', '-W', '2', candidate], { superuser: "try" });
                console.log('Successfully resolved PDC hostname to:', candidate);
                return candidate;
            } catch (error) {
                console.log('Hostname candidate failed:', candidate, '-', error.message);
                continue;
            }
        }

        // If all candidates fail, return the original name and let the connectivity tests show specific errors
        console.log('All hostname resolution attempts failed, returning original name:', serverName.toLowerCase());
        return serverName.toLowerCase();
    }

    /**
     * Handle PDC Emulator role transfer special operations
     */
    async handlePDCTransfer() {
        console.log('Handling PDC Emulator transfer - updating NTP and DHCP services');

        // Configure NTP for PDC Emulator
        try {
            await this.serviceManager.configureNTPForPDC();
            console.log('NTP reconfigured for PDC Emulator role');
        } catch (error) {
            console.log('Failed to reconfigure NTP after PDC transfer:', error);
        }

        // Ensure DHCP service is running
        await this.serviceManager.ensureDHCPRunning();

        // Refresh DHCP status display
        setTimeout(() => {
            this.serviceManager.checkDHCPServiceStatus();
        }, 1000);
    }

    /**
     * Update FSMO button states based on role ownership
     */
    updateFSMOButtons(roleElementId, isThisServer) {
        const roleToButtonMap = {
            'pdc-holder': 'pdc',
            'rid-holder': 'rid',
            'infrastructure-holder': 'infrastructure',
            'schema-holder': 'schema',
            'domain-naming-holder': 'domain-naming'
        };

        const buttonRole = roleToButtonMap[roleElementId];
        if (!buttonRole) return;

        const transferBtn = document.getElementById(`transfer-${buttonRole}`);
        const seizeBtn = document.getElementById(`seize-${buttonRole}`);

        if (transferBtn && seizeBtn) {
            if (isThisServer) {
                transferBtn.disabled = true;
                transferBtn.innerHTML = '<i class="fas fa-check"></i> Already Here';
                transferBtn.title = `This server already holds the ${this.getFSMORoleName(buttonRole)} role`;
                seizeBtn.disabled = true;
                seizeBtn.title = `This server already holds the ${this.getFSMORoleName(buttonRole)} role`;
            } else {
                transferBtn.disabled = false;
                transferBtn.innerHTML = '<i class="fas fa-exchange-alt"></i> Transfer Here';
                transferBtn.title = `Transfer ${this.getFSMORoleName(buttonRole)} role to this server`;
                seizeBtn.disabled = false;
                seizeBtn.title = `Seize ${this.getFSMORoleName(buttonRole)} role (emergency only)`;
            }
        }
    }

    /**
     * Extract server name from FSMO role DN
     */
    extractServerName(roleDN) {
        const match = roleDN.match(/CN=NTDS Settings,CN=([^,]+),CN=Servers/);
        return match ? match[1] : roleDN;
    }

    /**
     * Get friendly FSMO role names
     */
    getFSMORoleName(role) {
        const roleNames = {
            'pdc': 'PDC Emulator',
            'rid': 'RID Master',
            'infrastructure': 'Infrastructure Master',
            'schema': 'Schema Master',
            'domain-naming': 'Domain Naming Master'
        };
        return roleNames[role] || role;
    }

    /**
     * Force domain replication to resolve FSMO inconsistencies
     */
    async forceDomainReplication() {
        console.log('Forcing domain replication to resolve FSMO inconsistencies...');
        this.uiManager.showLoading('Forcing domain replication...');

        const replicationProcess = cockpit.spawn(['samba-tool', 'drs', 'replicate', 'dc2.guedry.local', 'dc1.guedry.local', 'CN=Configuration,DC=guedry,DC=local'], { superuser: "try" });

        const timeoutId = setTimeout(() => {
            console.log('Replication command timed out after 30 seconds');
            replicationProcess.close();
            this.uiManager.hideLoading();
            this.uiManager.showError('Replication command timed out. This suggests network connectivity issues between domain controllers.');
        }, 30000);

        try {
            const output = await replicationProcess;
            clearTimeout(timeoutId);

            console.log('Configuration replication successful:', output);
            this.uiManager.hideLoading();
            this.uiManager.showSuccess('Domain replication forced successfully. FSMO roles should now be consistent.');

            setTimeout(() => {
                this.loadFSMORoles();
            }, 2000);
        } catch (error) {
            clearTimeout(timeoutId);
            console.error('Failed to force replication:', error);
            this.uiManager.hideLoading();

            const errorMsg = `Replication failed: ${error.message}

This FSMO split-brain situation requires immediate attention:

1. **Current Status**: Domain controllers disagree on role ownership
2. **Root Cause**: Network/authentication issues preventing replication
3. **Risk**: Domain instability, authentication problems

**Manual Resolution Options:**
• Check network connectivity between domain controllers
• Verify firewall rules allow AD replication ports
• Restart Samba services on both DCs
• Consider using 'Seize' instead of 'Transfer' for remaining roles`;

            this.uiManager.showError(errorMsg);
        }
    }
}