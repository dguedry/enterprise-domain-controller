# Domain Controller Comprehensive Test Suite

This comprehensive test suite is designed to validate all aspects of your multi-domain controller environment, including FSMO role management, service failover, SYSVOL synchronization, multi-DC coordination, and network connectivity. The suite automatically discovers all domain controllers via DNS SRV records and scales to any number of DCs.

## 🌐 Dynamic Multi-DC Architecture

### Automatic Domain Controller Discovery
- **DNS SRV Queries**: Discovers all DCs via `_ldap._tcp.domain.local` records
- **No Configuration**: Works with any number of DCs (1, 3, 5, 10+)
- **Real-time Discovery**: Each test run discovers current DC topology
- **Fallback Methods**: Multiple discovery methods (dig, nslookup, samba-tool)

### Scalable Testing
- **Single DC**: Tests basic functionality and readiness
- **2+ DCs**: Tests replication, coordination, and failover
- **Large Environments**: Efficient parallel testing and reporting

## 🧪 Test Suite Overview

### Test Categories

#### 1. **FSMO Failover Tests** (`fsmo/`)
- **File**: `test-fsmo-failover.sh`
- **Purpose**: Tests FSMO role management, automatic seizure, and orchestration
- **Tests**: Role query, orchestrator execution, status tracking, DC discovery, connectivity, priorities, auto-seizure, systemd integration

#### 2. **SYSVOL Synchronization Tests** (`sysvol/`)
- **File**: `test-sysvol-sync.sh`
- **Purpose**: Tests SYSVOL replication and configuration synchronization
- **Tests**: Structure validation, permissions, config files, write access, sync verification, replication latency, cleanup

#### 3. **Multi-DC Coordination Tests** (`coordination/`)
- **File**: `test-multi-dc-coordination.sh`
- **Purpose**: Tests priority-based coordination and anti-race condition mechanisms
- **Tests**: DC discovery, priority initialization, multi-DC management, seizure locks, orchestrator coordination, stale cleanup, race prevention

#### 4. **Service Failover Tests** (`services/`)
- **File**: `test-service-failover.sh`
- **Purpose**: Tests DHCP, NTP, and service failover based on FSMO roles
- **Tests**: DHCP configuration, NTP sync, Samba AD-DC, orchestration, SYSVOL configs, dependencies, firewall integration, failover simulation

#### 5. **Network Connectivity Tests** (`network/`)
- **File**: `test-network-connectivity.sh`
- **Purpose**: Tests network connectivity, DNS resolution, and AD service accessibility
- **Tests**: Interface configuration, DNS resolution, external connectivity, AD ports, inter-DC connectivity, NTP connectivity, DHCP network, latency, firewall

## 🚀 Quick Start

### Automatic Domain Controller Discovery
The test suite automatically discovers all domain controllers in your environment via DNS SRV record queries (`_ldap._tcp.domain.local`). No configuration needed!

### Run All Tests
```bash
# Run comprehensive test suite (auto-discovers all DCs)
cd /home/dguedry/Documents/ad-server/cockpit-domain-controller/tests
./run-all-tests.sh

# Example output: "Discovered 5 domain controllers via DNS: dc1, dc2, dc3, dc4, dc5"

# Run with verbose output and HTML report
./run-all-tests.sh --verbose --html

# Run tests in parallel (faster)
./run-all-tests.sh --parallel
```

### Run Individual Test Suites
```bash
# FSMO failover tests
./run-all-tests.sh --suite fsmo

# SYSVOL synchronization tests
./run-all-tests.sh --suite sysvol

# Multi-DC coordination tests
./run-all-tests.sh --suite coordination

# Service failover tests
./run-all-tests.sh --suite services

# Network connectivity tests
./run-all-tests.sh --suite network
```

### Quick Connectivity Check
```bash
# Run basic connectivity tests only
./run-all-tests.sh --quick
```

## 🏢 Multi-Domain Controller Testing Process

### Phase 1: Individual DC Validation
Run the comprehensive test suite on each of your domain controllers:

```bash
# On each DC in your environment
./run-all-tests.sh --verbose

# The suite will automatically discover all DCs via DNS
# Example output: "Discovered 5 domain controllers: dc1, dc2, dc3, dc4, dc5"
```

### Phase 2: Multi-DC Coordination Verification
```bash
# Check multi-DC coordination on all DCs
./run-all-tests.sh --suite coordination

# Verify SYSVOL synchronization
./run-all-tests.sh --suite sysvol
```

### Phase 3: Failover Testing
```bash
# 1. Stop primary DC services
sudo systemctl stop samba-ad-dc

# 2. Run failover tests on secondary DC
./run-all-tests.sh --simulate-failover

# 3. Verify automatic role seizure
./run-all-tests.sh --suite fsmo

# 4. Restart primary DC
sudo systemctl start samba-ad-dc
```

### Phase 4: Service Failover Validation
```bash
# Test DHCP/NTP failover
./run-all-tests.sh --suite services

# Check network connectivity during failover
./run-all-tests.sh --suite network
```

## 📊 Understanding Test Results

### Success Indicators
- **100% Pass Rate**: All systems functioning correctly
- **FSMO Roles**: Properly distributed and discoverable
- **SYSVOL Sync**: Configuration files replicating between DCs
- **Service Failover**: DHCP/NTP following PDC Emulator role
- **Network**: All DCs reachable with <100ms latency

### Common Issues and Solutions

#### FSMO Tests Failing
```bash
# Check FSMO orchestrator service
sudo systemctl status fsmo-orchestrator.timer

# Manual FSMO role query
sudo samba-tool fsmo show

# Reinitialize orchestration
sudo /usr/local/bin/fsmo-orchestrator.sh --init
```

#### SYSVOL Sync Issues
```bash
# Check SYSVOL permissions
ls -la /var/lib/samba/sysvol/

# Test SYSVOL write access
./sysvol/test-sysvol-sync.sh --create-marker test1

# Check for test markers on other DCs
ls -la /var/lib/samba/sysvol/*/test-markers/
```

#### Network Connectivity Problems
```bash
# Test basic connectivity
./network/test-network-connectivity.sh --quick

# Check specific AD ports
./network/test-network-connectivity.sh --ports

# Test inter-DC latency
./network/test-network-connectivity.sh --latency
```

#### Service Failover Issues
```bash
# Check current service status
./services/test-service-failover.sh --check-services

# Simulate failover
./services/test-service-failover.sh --simulate-failover

# Manual orchestration trigger
sudo /usr/local/bin/fsmo-orchestrator.sh --orchestrate
```

## 📁 Test Reports

All test results are saved to the `reports/` directory with timestamps:

### Report Types
- **Comprehensive Summary**: `comprehensive-test-summary-YYYYMMDD-HHMMSS.txt`
- **HTML Report**: `comprehensive-test-summary-YYYYMMDD-HHMMSS.html` (with --html flag)
- **Individual Test Reports**: `{suite}-test-YYYYMMDD-HHMMSS.txt`
- **Multi-DC Summary**: `multi-dc-test-summary-YYYYMMDD-HHMMSS.txt`

### Report Contents
- **Test Summary**: Pass/fail rates and execution times
- **Environment Analysis**: FSMO roles, service status, network config
- **Detailed Logs**: Complete test execution logs
- **Recommendations**: Specific guidance for failed tests

## 🔧 Advanced Usage

### Custom Test Scenarios

#### Test SYSVOL Replication Timing
```bash
# Create test marker on DC1
./sysvol/test-sysvol-sync.sh --create-marker replication-test-$(date +%s)

# Wait 5 minutes, then check on other DCs
./sysvol/test-sysvol-sync.sh
```

#### Simulate Network Partitioning
```bash
# Block traffic to specific DC (temporary)
sudo iptables -A OUTPUT -d other-dc.domain.local -j DROP

# Run coordination tests to verify seizure behavior
./coordination/test-multi-dc-coordination.sh

# Remove block
sudo iptables -D OUTPUT -d other-dc.domain.local -j DROP
```

#### Test Priority-Based Seizure
```bash
# View current priorities
sudo /usr/local/bin/fsmo-orchestrator.sh --multi-dc-status

# Edit priorities in SYSVOL
sudo nano /var/lib/samba/sysvol/*/fsmo-configs/domain-dc-priorities.conf

# Test coordination with new priorities
./coordination/test-multi-dc-coordination.sh
```

### Automated Testing with Cron

Set up regular health checks:
```bash
# Add to crontab for daily testing
echo "0 2 * * * /home/dguedry/Documents/ad-server/cockpit-domain-controller/tests/run-all-tests.sh --quick > /var/log/dc-health-check.log 2>&1" | sudo crontab -
```

## 🛠️ Troubleshooting

### Test Script Issues
```bash
# Ensure all scripts are executable
chmod +x /home/dguedry/Documents/ad-server/cockpit-domain-controller/tests/**/*.sh

# Check script dependencies
which samba-tool chronyc dig nslookup nc

# Verify SYSVOL access
ls -la /var/lib/samba/sysvol/
```

### Permission Issues
```bash
# If tests require sudo access
sudo visudo
# Add: username ALL=(ALL) NOPASSWD: /usr/local/bin/fsmo-orchestrator.sh, /usr/bin/samba-tool
```

### Service Issues
```bash
# Restart key services
sudo systemctl restart samba-ad-dc chrony fsmo-orchestrator.timer

# Check service logs
sudo journalctl -u samba-ad-dc -f
sudo journalctl -u fsmo-orchestrator -f
```

## 📈 Expected Results for Healthy Multi-DC Environment

### Baseline Expectations
- **Discovery**: All DCs should discover each other via DNS SRV records (_ldap._tcp.domain.local)
- **FSMO Distribution**: All 5 roles assigned (single DC environments hold all roles)
- **SYSVOL Replication**: Configuration files sync within 15 minutes across all DCs
- **Service Failover**: DHCP/NTP failover within 5-10 minutes of PDC role change
- **Network Latency**: <100ms between DCs (ideal), <500ms (acceptable)
- **Coordination**: Priority-based seizure prevents conflicts regardless of DC count

### Performance Benchmarks
- **Test Execution Time**: 5-15 minutes per DC (sequential), 3-8 minutes (parallel)
- **FSMO Query**: <5 seconds
- **DNS Resolution**: <3 seconds
- **Service Status Check**: <10 seconds
- **Inter-DC Ping**: <100ms (LAN), <500ms (WAN)

## 🔄 Continuous Monitoring

### Regular Health Checks
```bash
# Weekly comprehensive test
./run-all-tests.sh --html

# Daily quick check
./run-all-tests.sh --quick

# Monitor specific components
./run-all-tests.sh --suite coordination  # Check coordination
./run-all-tests.sh --suite services      # Check service health
```

### Alerting Integration
The test scripts provide appropriate exit codes and logging for integration with monitoring systems:
- **Exit Code 0**: All tests passed
- **Exit Code 1**: Some tests failed
- **Logs**: Available in systemd journal and individual report files

---

## 📞 Support

For issues with the test suite:
1. **Check individual test logs** in the `reports/` directory
2. **Run tests with --verbose** for detailed output
3. **Review service logs** with `journalctl`
4. **Check SYSVOL permissions** and replication status
5. **Verify network connectivity** between all DCs

This test suite provides comprehensive validation of your domain controller environment and helps ensure reliable operation of your Active Directory infrastructure.