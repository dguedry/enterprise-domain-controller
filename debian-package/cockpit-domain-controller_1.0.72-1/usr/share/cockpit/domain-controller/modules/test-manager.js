/**
 * Test Management Module
 * Handles comprehensive domain controller testing from the Cockpit interface
 */

const _ = cockpit.gettext;

export class TestManager {
    constructor(uiManager) {
        this.uiManager = uiManager;
        this.testResults = {};
        this.isTestRunning = false;
        this.currentTestProcess = null;

        // Test suite definitions
        this.testSuites = {
            'all': {
                name: 'All Tests',
                description: 'Run comprehensive test suite',
                command: '/usr/share/cockpit/domain-controller/tests/run-all-tests.sh',
                icon: 'fas fa-check-double'
            },
            'quick': {
                name: 'Quick Tests',
                description: 'Run basic connectivity tests',
                command: '/usr/share/cockpit/domain-controller/tests/run-all-tests.sh --quick',
                icon: 'fas fa-bolt'
            },
            'fsmo': {
                name: 'FSMO Tests',
                description: 'Test FSMO role management and failover',
                command: '/usr/share/cockpit/domain-controller/tests/run-all-tests.sh --suite fsmo',
                icon: 'fas fa-crown'
            },
            'coordination': {
                name: 'Multi-DC Coordination',
                description: 'Test multi-DC coordination and priority system',
                command: '/usr/share/cockpit/domain-controller/tests/run-all-tests.sh --suite coordination',
                icon: 'fas fa-network-wired'
            },
            'sysvol': {
                name: 'SYSVOL Sync',
                description: 'Test SYSVOL synchronization and replication',
                command: '/usr/share/cockpit/domain-controller/tests/run-all-tests.sh --suite sysvol',
                icon: 'fas fa-sync-alt'
            },
            'services': {
                name: 'Service Failover',
                description: 'Test DHCP, NTP, and service failover',
                command: '/usr/share/cockpit/domain-controller/tests/run-all-tests.sh --suite services',
                icon: 'fas fa-cogs'
            },
            'network': {
                name: 'Network Connectivity',
                description: 'Test network connectivity and DNS resolution',
                command: '/usr/share/cockpit/domain-controller/tests/run-all-tests.sh --suite network',
                icon: 'fas fa-globe'
            }
        };
    }

    /**
     * Initialize test interface
     */
    initializeTestInterface() {
        console.log('Initializing test interface');

        // Use setTimeout to ensure DOM is stable
        setTimeout(() => {
            this.createTestInterfaceWithRetry();
        }, 100);
    }

    /**
     * Create test interface with retry mechanism
     */
    createTestInterfaceWithRetry(retryCount = 0) {
        const maxRetries = 5;

        console.log(`Attempting to create test interface (attempt ${retryCount + 1})`);

        // Check if test section already exists
        const existingSection = document.querySelector('.test-section');
        if (existingSection) {
            console.log('Test section already exists, removing it');
            existingSection.remove();
        }

        const testSection = this.createTestSection();
        console.log('Test section created');

        // Find a good place to insert the test section
        const domainDetails = document.getElementById('domain-details');
        console.log('Domain details found:', !!domainDetails);

        if (domainDetails && !domainDetails.classList.contains('hidden')) {
            // Insert after FSMO roles section, or at the end if FSMO section not found
            const fsmoSection = domainDetails.querySelector('.fsmo-roles-section');
            console.log('FSMO section found:', !!fsmoSection);

            if (fsmoSection) {
                fsmoSection.parentNode.insertBefore(testSection, fsmoSection.nextSibling);
                console.log('Test section inserted after FSMO section');
            } else {
                domainDetails.appendChild(testSection);
                console.log('Test section appended to domain details');
            }

            // Verify the section was actually added and monitor for removal
            setTimeout(() => {
                const verifySection = document.querySelector('.test-section');
                if (verifySection) {
                    console.log('✅ Test section successfully added and persisted');

                    // Monitor for removal with MutationObserver
                    const observer = new MutationObserver((mutations) => {
                        mutations.forEach((mutation) => {
                            if (mutation.type === 'childList') {
                                mutation.removedNodes.forEach((node) => {
                                    if (node.nodeType === Node.ELEMENT_NODE &&
                                        (node.classList?.contains('test-section') ||
                                         node.querySelector?.('.test-section'))) {
                                        console.warn('🚨 Test section was removed by DOM mutation!');
                                        console.log('Removed by:', mutation.target);
                                        console.log('Stack trace:', new Error().stack);

                                        // Try to re-add it immediately
                                        if (retryCount < maxRetries) {
                                            console.log('Attempting immediate re-creation...');
                                            setTimeout(() => {
                                                this.createTestInterfaceWithRetry(retryCount + 1);
                                            }, 100);
                                        }
                                    }
                                });
                            }
                        });
                    });

                    // Monitor the domain-details container for changes
                    const domainDetails = document.getElementById('domain-details');
                    if (domainDetails) {
                        observer.observe(domainDetails, {
                            childList: true,
                            subtree: true
                        });
                        console.log('🔍 Monitoring DOM for test section removal');
                    }

                    // Also check periodically
                    const checkInterval = setInterval(() => {
                        if (!document.querySelector('.test-section')) {
                            console.warn('🚨 Test section disappeared during periodic check!');
                            clearInterval(checkInterval);
                            if (retryCount < maxRetries) {
                                this.createTestInterfaceWithRetry(retryCount + 1);
                            }
                        }
                    }, 1000);

                    // Stop monitoring after 10 seconds
                    setTimeout(() => {
                        observer.disconnect();
                        clearInterval(checkInterval);
                        console.log('🔍 Stopped monitoring test section');
                    }, 10000);

                } else {
                    console.warn('❌ Test section was removed after adding');
                    if (retryCount < maxRetries) {
                        console.log(`Retrying in 500ms... (${retryCount + 1}/${maxRetries})`);
                        setTimeout(() => {
                            this.createTestInterfaceWithRetry(retryCount + 1);
                        }, 500);
                    } else {
                        console.error('Max retries reached - test interface creation failed');
                    }
                }
            }, 200);

        } else {
            console.error('Domain details section not found or hidden');
            if (retryCount < maxRetries) {
                console.log(`Retrying in 500ms... (${retryCount + 1}/${maxRetries})`);
                setTimeout(() => {
                    this.createTestInterfaceWithRetry(retryCount + 1);
                }, 500);
            }
        }
    }

    /**
     * Create test section HTML
     */
    createTestSection() {
        const section = document.createElement('div');
        section.className = 'pf-v5-c-card test-section';
        section.innerHTML = `
            <div class="pf-v5-c-card__header">
                <div class="pf-v5-c-card__header-main">
                    <h2 class="pf-v5-c-title pf-m-lg">
                        <i class="fas fa-vial test-icon"></i>
                        ${_('Domain Controller Tests')}
                    </h2>
                </div>
                <div class="pf-v5-c-card__actions">
                    <button class="pf-v5-c-button pf-m-plain test-toggle-btn" id="test-toggle-btn" aria-expanded="false">
                        <i class="fas fa-chevron-down" id="test-toggle-icon"></i>
                    </button>
                </div>
            </div>
            <div class="pf-v5-c-card__body test-content" id="test-content" style="display: none;">
                <div class="test-description">
                    <p>${_('Comprehensive testing suite for validating domain controller functionality, FSMO roles, service failover, and multi-DC coordination.')}</p>
                </div>

                <div class="test-grid" id="test-grid">
                    ${this.createTestButtons()}
                </div>

                <div class="test-output-section" id="test-output-section" style="display: none;">
                    <hr class="pf-v5-c-divider">
                    <h3 class="pf-v5-c-title pf-m-md">
                        <i class="fas fa-terminal"></i>
                        ${_('Test Output')}
                    </h3>
                    <div class="test-controls">
                        <button class="pf-v5-c-button pf-m-secondary" id="clear-output-btn">
                            <i class="fas fa-trash"></i> ${_('Clear Output')}
                        </button>
                        <button class="pf-v5-c-button pf-m-secondary" id="stop-test-btn" style="display: none;">
                            <i class="fas fa-stop"></i> ${_('Stop Test')}
                        </button>
                    </div>
                    <div class="test-output" id="test-output">
                        <pre id="test-output-content"></pre>
                    </div>
                </div>
            </div>
        `;

        // Add event listeners
        this.addTestEventListeners(section);

        return section;
    }

    /**
     * Create test buttons HTML
     */
    createTestButtons() {
        return Object.entries(this.testSuites).map(([key, suite]) => `
            <div class="test-card">
                <button class="pf-v5-c-button pf-m-primary test-button" data-test="${key}">
                    <i class="${suite.icon}"></i>
                    <span class="test-name">${_(suite.name)}</span>
                </button>
                <p class="test-description">${_(suite.description)}</p>
            </div>
        `).join('');
    }

    /**
     * Add event listeners to test section
     */
    addTestEventListeners(section) {
        console.log('Adding test event listeners');

        // Toggle button for collapsible section
        const toggleBtn = section.querySelector('#test-toggle-btn');
        console.log('Toggle button found:', !!toggleBtn);

        if (toggleBtn) {
            toggleBtn.addEventListener('click', (event) => {
                console.log('Toggle button clicked');
                event.preventDefault();
                event.stopPropagation();
                this.toggleTestSection();
            });
            console.log('Toggle event listener added');
        } else {
            console.error('Toggle button not found in section');
        }

        // Test button clicks
        section.addEventListener('click', (event) => {
            const testButton = event.target.closest('.test-button');
            if (testButton && !this.isTestRunning) {
                const testKey = testButton.dataset.test;
                this.runTest(testKey);
            }
        });

        // Clear output button
        const clearBtn = section.querySelector('#clear-output-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => this.clearTestOutput());
        }

        // Stop test button
        const stopBtn = section.querySelector('#stop-test-btn');
        if (stopBtn) {
            stopBtn.addEventListener('click', () => this.stopTest());
        }
    }

    /**
     * Toggle test section visibility
     */
    toggleTestSection() {
        console.log('toggleTestSection called');
        const testContent = document.getElementById('test-content');
        const toggleBtn = document.getElementById('test-toggle-btn');
        const toggleIcon = document.getElementById('test-toggle-icon');

        console.log('Test elements found:', {
            testContent: !!testContent,
            toggleBtn: !!toggleBtn,
            toggleIcon: !!toggleIcon
        });

        if (testContent && toggleBtn && toggleIcon) {
            const currentDisplay = window.getComputedStyle(testContent).display;
            const isVisible = currentDisplay !== 'none';

            console.log('Current computed display:', currentDisplay, 'isVisible:', isVisible);

            if (isVisible) {
                // Hide the section
                testContent.style.display = 'none';
                toggleBtn.setAttribute('aria-expanded', 'false');
                toggleIcon.className = 'fas fa-chevron-down';
                console.log('Section hidden');
            } else {
                // Show the section
                testContent.style.display = 'block';
                toggleBtn.setAttribute('aria-expanded', 'true');
                toggleIcon.className = 'fas fa-chevron-up';
                console.log('Section shown');
            }
        } else {
            console.error('Missing test section elements');
        }
    }

    /**
     * Run a specific test suite
     */
    async runTest(testKey) {
        if (this.isTestRunning) {
            this.uiManager.showInfo('A test is already running. Please wait for it to complete.');
            return;
        }

        const testSuite = this.testSuites[testKey];
        if (!testSuite) {
            this.uiManager.showError('Unknown test suite: ' + testKey);
            return;
        }

        this.isTestRunning = true;
        this.showTestOutput();
        this.updateTestUI(true);

        try {
            this.appendTestOutput(`Starting ${testSuite.name}...\n`);
            this.appendTestOutput(`Command: ${testSuite.command}\n`);
            this.appendTestOutput('═'.repeat(60) + '\n\n');

            // Discover domain controllers first
            await this.discoverDomainControllers();

            // Run the actual test
            const result = await this.executeTest(testSuite.command);

            this.appendTestOutput('\n' + '═'.repeat(60) + '\n');
            this.appendTestOutput(`Test completed with exit code: ${result.exit_code}\n`);

            if (result.exit_code === 0) {
                this.appendTestOutput('✅ All tests passed!\n');
                this.uiManager.showSuccess(`${testSuite.name} completed successfully!`);
            } else {
                this.appendTestOutput('❌ Some tests failed. Review output above.\n');
                this.uiManager.showInfo(`${testSuite.name} completed with failures.`);
            }

        } catch (error) {
            console.error('Test execution error:', error);
            this.appendTestOutput(`\nError: ${error.message}\n`);
            this.uiManager.showError('Test execution failed: ' + error.message);
        } finally {
            this.isTestRunning = false;
            this.updateTestUI(false);
        }
    }

    /**
     * Discover domain controllers before testing
     */
    async discoverDomainControllers() {
        this.appendTestOutput('🔍 Discovering domain controllers...\n');

        try {
            const proc = cockpit.spawn(['dig', '+short', '_ldap._tcp.' + (await this.getDomainName()), 'SRV'],
                { err: 'ignore' });

            const result = await proc;
            const dcs = result.split('\n')
                .filter(line => line.trim())
                .map(line => {
                    const parts = line.trim().split(' ');
                    return parts[3] ? parts[3].replace(/\.$/, '').split('.')[0] : null;
                })
                .filter(dc => dc)
                .filter((dc, index, arr) => arr.indexOf(dc) === index); // Remove duplicates

            if (dcs.length > 0) {
                this.appendTestOutput(`📋 Discovered ${dcs.length} domain controllers: ${dcs.join(', ')}\n\n`);
            } else {
                this.appendTestOutput('⚠️  No domain controllers discovered via DNS SRV records\n\n');
            }
        } catch (error) {
            this.appendTestOutput('⚠️  Could not discover domain controllers via DNS\n\n');
        }
    }

    /**
     * Get domain name
     */
    async getDomainName() {
        try {
            const proc = cockpit.spawn(['hostname', '-d']);
            const result = await proc;
            return result.trim() || 'guedry.local';
        } catch (error) {
            return 'guedry.local';
        }
    }

    /**
     * Execute test command
     */
    async executeTest(command) {
        return new Promise((resolve, reject) => {
            const args = command.split(' ');
            const executable = args[0];
            const params = args.slice(1);

            this.currentTestProcess = cockpit.spawn([executable, ...params], {
                err: 'out'
            });

            let output = '';

            this.currentTestProcess.stream((data) => {
                output += data;
                this.appendTestOutput(data);
            });

            this.currentTestProcess.then(() => {
                resolve({ exit_code: 0, output });
            }).catch((error) => {
                if (error.exit_status !== undefined) {
                    resolve({ exit_code: error.exit_status, output });
                } else {
                    reject(error);
                }
            });
        });
    }

    /**
     * Stop running test
     */
    stopTest() {
        if (this.currentTestProcess) {
            this.currentTestProcess.close();
            this.currentTestProcess = null;
            this.appendTestOutput('\n⏹️  Test stopped by user\n');
            this.isTestRunning = false;
            this.updateTestUI(false);
        }
    }

    /**
     * Show test output section
     */
    showTestOutput() {
        // Expand the test section if it's collapsed
        const testContent = document.getElementById('test-content');
        const toggleBtn = document.getElementById('test-toggle-btn');
        const toggleIcon = document.getElementById('test-toggle-icon');

        if (testContent && testContent.style.display === 'none') {
            testContent.style.display = 'block';
            if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
            if (toggleIcon) toggleIcon.className = 'fas fa-chevron-up';
        }

        // Show the output section
        const outputSection = document.getElementById('test-output-section');
        if (outputSection) {
            outputSection.style.display = 'block';
        }
    }

    /**
     * Append text to test output
     */
    appendTestOutput(text) {
        const outputContent = document.getElementById('test-output-content');
        if (outputContent) {
            outputContent.textContent += text;
            outputContent.scrollTop = outputContent.scrollHeight;
        }
    }

    /**
     * Clear test output
     */
    clearTestOutput() {
        const outputContent = document.getElementById('test-output-content');
        if (outputContent) {
            outputContent.textContent = '';
        }
    }

    /**
     * Update test UI based on running state
     */
    updateTestUI(isRunning) {
        const testButtons = document.querySelectorAll('.test-button');
        const stopBtn = document.getElementById('stop-test-btn');

        testButtons.forEach(button => {
            button.disabled = isRunning;
            if (isRunning) {
                button.classList.add('pf-m-progress');
            } else {
                button.classList.remove('pf-m-progress');
            }
        });

        if (stopBtn) {
            stopBtn.style.display = isRunning ? 'inline-block' : 'none';
        }
    }

    /**
     * Get test results summary
     */
    getTestResults() {
        return this.testResults;
    }

    /**
     * Check if tests are available
     */
    async checkTestAvailability() {
        try {
            const proc = cockpit.spawn(['test', '-f', '/usr/share/cockpit/domain-controller/tests/run-all-tests.sh']);
            await proc;
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Manual test function for debugging (can be called from browser console)
     */
    debugToggle() {
        console.log('=== Manual Toggle Debug ===');
        const section = document.querySelector('.test-section');
        console.log('Test section exists:', !!section);

        if (section) {
            const toggleBtn = section.querySelector('#test-toggle-btn');
            const testContent = section.querySelector('#test-content');

            console.log('Toggle button exists:', !!toggleBtn);
            console.log('Test content exists:', !!testContent);

            if (toggleBtn && testContent) {
                console.log('Current display style:', testContent.style.display);
                console.log('Computed display:', window.getComputedStyle(testContent).display);

                // Force toggle
                if (testContent.style.display === 'none') {
                    testContent.style.display = 'block';
                    console.log('Forced to show');
                } else {
                    testContent.style.display = 'none';
                    console.log('Forced to hide');
                }
            }
        }
    }
}