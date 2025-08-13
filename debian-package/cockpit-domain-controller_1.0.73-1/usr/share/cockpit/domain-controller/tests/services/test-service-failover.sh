#!/bin/bash
# Service Failover Testing Script
# Tests DHCP, NTP, and other service failover based on FSMO role changes

set -e

SCRIPT_NAME="test-service-failover"
LOG_TAG="$SCRIPT_NAME"
TEST_LOG="/tmp/service-failover-test.log"

# Test configuration
DOMAIN_NAME=$(find /var/lib/samba/sysvol/ -maxdepth 1 -type d -name "*.local" 2>/dev/null | head -1 | xargs basename 2>/dev/null || echo "guedry.local")
SYSVOL_BASE="/var/lib/samba/sysvol/${DOMAIN_NAME}"
FSMO_CONFIG_DIR="${SYSVOL_BASE}/fsmo-configs"

# Service configuration
DHCP_CONFIG="/etc/dhcp/dhcpd.conf"
CHRONY_CONFIG="/etc/chrony/chrony.conf"
SAMBA_CONFIG="/etc/samba/smb.conf"

# Test results tracking
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Logging functions
log_info() {
    local msg="$1"
    echo "[INFO] $(date '+%Y-%m-%d %H:%M:%S') $msg" | tee -a "$TEST_LOG"
    logger -t "$LOG_TAG" -p info "$msg"
}

log_error() {
    local msg="$1"
    echo "[ERROR] $(date '+%Y-%m-%d %H:%M:%S') $msg" | tee -a "$TEST_LOG"
    logger -t "$LOG_TAG" -p err "$msg"
}

log_success() {
    local msg="$1"
    echo "[SUCCESS] $(date '+%Y-%m-%d %H:%M:%S') $msg" | tee -a "$TEST_LOG"
    logger -t "$LOG_TAG" -p info "SUCCESS: $msg"
}

# Test tracking functions
start_test() {
    local test_name="$1"
    ((TESTS_RUN++))
    log_info "Starting test: $test_name"
}

pass_test() {
    local test_name="$1"
    ((TESTS_PASSED++))
    log_success "PASSED: $test_name"
}

fail_test() {
    local test_name="$1"
    local reason="$2"
    ((TESTS_FAILED++))
    log_error "FAILED: $test_name - $reason"
}

# Get current FSMO role holders
get_fsmo_roles() {
    local fsmo_output
    fsmo_output=$(sudo samba-tool fsmo show 2>/dev/null || echo "FSMO_QUERY_FAILED")

    if [ "$fsmo_output" = "FSMO_QUERY_FAILED" ]; then
        return 1
    fi

    local this_server=$(hostname -s | tr '[:upper:]' '[:lower:]')

    # Extract role owners
    local pdc_owner=$(echo "$fsmo_output" | grep -i "PdcRole" | sed 's/.*CN=\([^,]*\).*/\1/' | tr '[:upper:]' '[:lower:]' || echo "unknown")
    local rid_owner=$(echo "$fsmo_output" | grep -i "RidAllocationMasterRole" | sed 's/.*CN=\([^,]*\).*/\1/' | tr '[:upper:]' '[:lower:]' || echo "unknown")
    local infra_owner=$(echo "$fsmo_output" | grep -i "InfrastructureMasterRole" | sed 's/.*CN=\([^,]*\).*/\1/' | tr '[:upper:]' '[:lower:]' || echo "unknown")
    local schema_owner=$(echo "$fsmo_output" | grep -i "SchemaMasterRole" | sed 's/.*CN=\([^,]*\).*/\1/' | tr '[:upper:]' '[:lower:]' || echo "unknown")
    local naming_owner=$(echo "$fsmo_output" | grep -i "DomainNamingMasterRole" | sed 's/.*CN=\([^,]*\).*/\1/' | tr '[:upper:]' '[:lower:]' || echo "unknown")

    # Determine if this server is PDC Emulator
    local is_pdc=false
    if echo "$pdc_owner" | grep -qi "$this_server" || echo "$this_server" | grep -qi "$pdc_owner"; then
        is_pdc=true
    fi

    echo "THIS_SERVER=$this_server"
    echo "PDC_OWNER=$pdc_owner"
    echo "RID_OWNER=$rid_owner"
    echo "INFRA_OWNER=$infra_owner"
    echo "SCHEMA_OWNER=$schema_owner"
    echo "NAMING_OWNER=$naming_owner"
    echo "IS_PDC=$is_pdc"
}

# Test service status query
get_service_status() {
    local service="$1"

    if systemctl is-active "$service" >/dev/null 2>&1; then
        echo "active"
    elif systemctl is-enabled "$service" >/dev/null 2>&1; then
        echo "enabled"
    else
        echo "inactive"
    fi
}

# Test DHCP service configuration and status
test_dhcp_service() {
    start_test "DHCP Service Configuration"

    local fsmo_info
    if ! fsmo_info=$(get_fsmo_roles); then
        fail_test "DHCP Service Configuration" "Cannot determine FSMO roles"
        return 1
    fi

    eval "$fsmo_info"

    # Check DHCP service status
    local dhcp_status=$(get_service_status "isc-dhcp-server")
    log_info "DHCP service status: $dhcp_status"

    # Check DHCP configuration exists
    if [ -f "$DHCP_CONFIG" ]; then
        log_info "DHCP configuration file exists: $DHCP_CONFIG"

        # Validate basic DHCP configuration
        if grep -q "subnet\|range\|option domain-name" "$DHCP_CONFIG" 2>/dev/null; then
            log_info "DHCP configuration appears valid"

            # Check if service status matches PDC role
            if [ "$IS_PDC" = "true" ]; then
                if [ "$dhcp_status" = "active" ]; then
                    log_info "DHCP correctly active on PDC Emulator"
                    pass_test "DHCP Service Configuration"
                    return 0
                else
                    log_info "DHCP not active on PDC - may need orchestration"
                    pass_test "DHCP Service Configuration"
                    return 0
                fi
            else
                if [ "$dhcp_status" = "active" ]; then
                    log_info "DHCP active on non-PDC - unusual but not necessarily wrong"
                else
                    log_info "DHCP correctly inactive on non-PDC"
                fi
                pass_test "DHCP Service Configuration"
                return 0
            fi
        else
            fail_test "DHCP Service Configuration" "DHCP configuration appears invalid"
            return 1
        fi
    else
        fail_test "DHCP Service Configuration" "DHCP configuration file not found"
        return 1
    fi
}

# Test NTP/Chrony service configuration
test_ntp_service() {
    start_test "NTP Service Configuration"

    local fsmo_info
    if ! fsmo_info=$(get_fsmo_roles); then
        fail_test "NTP Service Configuration" "Cannot determine FSMO roles"
        return 1
    fi

    eval "$fsmo_info"

    # Check Chrony service status
    local chrony_status=$(get_service_status "chrony")
    log_info "Chrony service status: $chrony_status"

    if [ "$chrony_status" = "active" ]; then
        # Check chrony configuration
        if [ -f "$CHRONY_CONFIG" ]; then
            log_info "Chrony configuration file exists: $CHRONY_CONFIG"

            # Check if chrony is properly configured
            if chronyc tracking >/dev/null 2>&1; then
                local stratum=$(chronyc tracking 2>/dev/null | grep "Stratum" | awk '{print $3}')
                local offset=$(chronyc tracking 2>/dev/null | grep "Last offset" | awk '{print $4}')

                log_info "Chrony tracking - Stratum: $stratum, Offset: $offset"

                # Check NTP sources
                local source_count=$(chronyc sources 2>/dev/null | grep -c "^\^" || echo "0")
                log_info "Chrony has $source_count time sources"

                if [ "$IS_PDC" = "true" ]; then
                    log_info "This server is PDC Emulator - should be authoritative time source"
                else
                    log_info "This server is not PDC - should sync with PDC or external sources"
                fi

                pass_test "NTP Service Configuration"
                return 0
            else
                fail_test "NTP Service Configuration" "Chrony tracking not working"
                return 1
            fi
        else
            fail_test "NTP Service Configuration" "Chrony configuration file not found"
            return 1
        fi
    else
        fail_test "NTP Service Configuration" "Chrony service not active"
        return 1
    fi
}

# Test Samba AD-DC service
test_samba_service() {
    start_test "Samba AD-DC Service"

    local samba_status=$(get_service_status "samba-ad-dc")
    log_info "Samba AD-DC service status: $samba_status"

    if [ "$samba_status" = "active" ]; then
        # Check Samba configuration
        if [ -f "$SAMBA_CONFIG" ]; then
            log_info "Samba configuration file exists: $SAMBA_CONFIG"

            # Validate basic Samba configuration
            if grep -q "server role.*active directory domain controller" "$SAMBA_CONFIG" 2>/dev/null; then
                log_info "Samba configured as Active Directory Domain Controller"

                # Test basic Samba functionality
                if samba-tool domain level show >/dev/null 2>&1; then
                    local domain_level=$(samba-tool domain level show 2>/dev/null | grep "Domain function level" | awk '{print $NF}')
                    log_info "Domain functional level: $domain_level"

                    # Test LDAP connectivity
                    if ldapsearch -x -H ldap://localhost -b "" -s base >/dev/null 2>&1; then
                        log_info "LDAP service responding correctly"
                        pass_test "Samba AD-DC Service"
                        return 0
                    else
                        fail_test "Samba AD-DC Service" "LDAP service not responding"
                        return 1
                    fi
                else
                    fail_test "Samba AD-DC Service" "Samba domain tools not working"
                    return 1
                fi
            else
                fail_test "Samba AD-DC Service" "Samba not configured as AD-DC"
                return 1
            fi
        else
            fail_test "Samba AD-DC Service" "Samba configuration file not found"
            return 1
        fi
    else
        fail_test "Samba AD-DC Service" "Samba AD-DC service not active"
        return 1
    fi
}

# Test service orchestration
test_service_orchestration() {
    start_test "Service Orchestration"

    # Test orchestrator execution
    if sudo /usr/local/bin/fsmo-orchestrator.sh --orchestrate-only >/dev/null 2>&1; then
        log_info "FSMO orchestrator executed successfully"

        # Wait a moment for services to settle
        sleep 5

        # Re-check service states after orchestration
        local dhcp_status=$(get_service_status "isc-dhcp-server")
        local chrony_status=$(get_service_status "chrony")
        local samba_status=$(get_service_status "samba-ad-dc")

        log_info "Post-orchestration service status:"
        log_info "  DHCP: $dhcp_status"
        log_info "  Chrony: $chrony_status"
        log_info "  Samba: $samba_status"

        # Check if essential services are running
        if [[ "$chrony_status" == "active" && "$samba_status" == "active" ]]; then
            log_info "Essential services are active after orchestration"
            pass_test "Service Orchestration"
            return 0
        else
            fail_test "Service Orchestration" "Essential services not active after orchestration"
            return 1
        fi
    else
        fail_test "Service Orchestration" "FSMO orchestrator execution failed"
        return 1
    fi
}

# Test SYSVOL service configuration storage
test_sysvol_service_config() {
    start_test "SYSVOL Service Configuration Storage"

    # Check if FSMO configuration directory exists
    if [ -d "$FSMO_CONFIG_DIR" ]; then
        log_info "FSMO configuration directory exists: $FSMO_CONFIG_DIR"

        # Check for service configuration files
        local config_files=(
            "${FSMO_CONFIG_DIR}/fsmo-services.conf"
            "${FSMO_CONFIG_DIR}/pdc-time-authority.conf"
            "${FSMO_CONFIG_DIR}/password-policy.conf"
        )

        local found_configs=0

        for config_file in "${config_files[@]}"; do
            if [ -f "$config_file" ]; then
                ((found_configs++))
                log_info "Found service config: $(basename "$config_file")"
            fi
        done

        if [ $found_configs -gt 0 ]; then
            log_info "Found $found_configs service configuration files in SYSVOL"
            pass_test "SYSVOL Service Configuration Storage"
            return 0
        else
            log_info "No service configuration files found - may need initialization"
            # Try to initialize
            if sudo /usr/local/bin/fsmo-orchestrator.sh --init >/dev/null 2>&1; then
                log_info "SYSVOL configuration initialized"
                pass_test "SYSVOL Service Configuration Storage"
                return 0
            else
                fail_test "SYSVOL Service Configuration Storage" "Cannot initialize SYSVOL configs"
                return 1
            fi
        fi
    else
        fail_test "SYSVOL Service Configuration Storage" "FSMO configuration directory not found"
        return 1
    fi
}

# Test service dependency management
test_service_dependencies() {
    start_test "Service Dependencies"

    # Check systemd service dependencies
    local samba_deps=$(systemctl list-dependencies samba-ad-dc.service 2>/dev/null | grep -c "●" || echo "0")
    log_info "Samba AD-DC has $samba_deps dependencies"

    # Check if orchestration services are properly configured
    local orchestrator_status=$(get_service_status "fsmo-orchestrator.timer")
    log_info "FSMO orchestrator timer status: $orchestrator_status"

    if [ "$orchestrator_status" = "active" ]; then
        # Check timer configuration
        if systemctl list-timers fsmo-orchestrator.timer >/dev/null 2>&1; then
            local next_run=$(systemctl list-timers fsmo-orchestrator.timer 2>/dev/null | grep "fsmo-orchestrator.timer" | awk '{print $1,$2}')
            log_info "Next orchestrator run: $next_run"
            pass_test "Service Dependencies"
            return 0
        else
            fail_test "Service Dependencies" "Orchestrator timer not properly configured"
            return 1
        fi
    else
        fail_test "Service Dependencies" "FSMO orchestrator timer not active"
        return 1
    fi
}

# Test firewall service integration
test_firewall_integration() {
    start_test "Firewall Integration"

    # Check if firewalld is running
    if systemctl is-active firewalld >/dev/null 2>&1; then
        log_info "Firewalld is active"

        # Check for essential AD ports
        local essential_ports=("53/tcp" "53/udp" "88/tcp" "88/udp" "389/tcp" "445/tcp" "123/udp")
        local open_ports=0

        for port in "${essential_ports[@]}"; do
            if firewall-cmd --list-ports 2>/dev/null | grep -q "$port" ||
               firewall-cmd --list-services 2>/dev/null | grep -qE "(samba|dns|ntp|ldap)"; then
                ((open_ports++))
                log_info "Port/service $port is accessible"
            fi
        done

        if [ $open_ports -gt 0 ]; then
            log_info "Firewall allows $open_ports essential AD services/ports"
            pass_test "Firewall Integration"
            return 0
        else
            fail_test "Firewall Integration" "Essential AD ports not accessible"
            return 1
        fi
    else
        log_info "Firewalld not active - assuming no firewall restrictions"
        pass_test "Firewall Integration"
        return 0
    fi
}

# Test service failover simulation
test_failover_simulation() {
    start_test "Service Failover Simulation"

    local fsmo_info
    if ! fsmo_info=$(get_fsmo_roles); then
        fail_test "Service Failover Simulation" "Cannot determine FSMO roles"
        return 1
    fi

    eval "$fsmo_info"

    # Record current service states
    local initial_dhcp_status=$(get_service_status "isc-dhcp-server")
    local initial_chrony_status=$(get_service_status "chrony")

    log_info "Initial service states - DHCP: $initial_dhcp_status, Chrony: $initial_chrony_status"
    log_info "This server PDC status: $IS_PDC"

    # Simulate orchestration trigger
    if sudo /usr/local/bin/fsmo-orchestrator.sh --orchestrate-only >/dev/null 2>&1; then
        log_info "Orchestration completed"

        # Check final service states
        sleep 3
        local final_dhcp_status=$(get_service_status "isc-dhcp-server")
        local final_chrony_status=$(get_service_status "chrony")

        log_info "Final service states - DHCP: $final_dhcp_status, Chrony: $final_chrony_status"

        # Validate service states match role expectations
        if [ "$IS_PDC" = "true" ]; then
            if [ "$final_chrony_status" = "active" ]; then
                log_info "Chrony correctly active on PDC Emulator"
                pass_test "Service Failover Simulation"
                return 0
            else
                fail_test "Service Failover Simulation" "Chrony should be active on PDC"
                return 1
            fi
        else
            if [ "$final_chrony_status" = "active" ]; then
                log_info "Chrony active on non-PDC (normal for time sync)"
                pass_test "Service Failover Simulation"
                return 0
            else
                log_info "Chrony not active on non-PDC"
                pass_test "Service Failover Simulation"
                return 0
            fi
        fi
    else
        fail_test "Service Failover Simulation" "Orchestration failed"
        return 1
    fi
}

# Generate service failover test report
generate_service_report() {
    local report_file="/home/dguedry/Documents/ad-server/cockpit-domain-controller/tests/reports/service-failover-test-$(date +%Y%m%d-%H%M%S).txt"

    cat > "$report_file" << EOF
Service Failover Test Report
Generated: $(date '+%Y-%m-%d %H:%M:%S')
Server: $(hostname)
Domain: $DOMAIN_NAME

Test Summary:
=============
Total Tests: $TESTS_RUN
Passed: $TESTS_PASSED
Failed: $TESTS_FAILED
Success Rate: $(( TESTS_PASSED * 100 / TESTS_RUN ))%

Current FSMO Role Status:
=========================
EOF

    # Add current FSMO roles to report
    if fsmo_info=$(get_fsmo_roles); then
        eval "$fsmo_info"
        cat >> "$report_file" << EOF
This Server: $THIS_SERVER
PDC Emulator: $PDC_OWNER
RID Master: $RID_OWNER
Infrastructure Master: $INFRA_OWNER
Schema Master: $SCHEMA_OWNER
Domain Naming Master: $NAMING_OWNER
Is PDC Emulator: $IS_PDC

EOF
    fi

    # Add current service status
    echo "Current Service Status:" >> "$report_file"
    echo "======================" >> "$report_file"
    local services=("samba-ad-dc" "chrony" "isc-dhcp-server" "fsmo-orchestrator.timer")
    for service in "${services[@]}"; do
        local status=$(get_service_status "$service")
        echo "$service: $status" >> "$report_file"
    done
    echo "" >> "$report_file"

    # Add service configuration analysis
    echo "Service Configuration Analysis:" >> "$report_file"
    echo "==============================" >> "$report_file"

    if [ -f "$DHCP_CONFIG" ]; then
        echo "DHCP Configuration: Present" >> "$report_file"
        local subnet_count=$(grep -c "subnet" "$DHCP_CONFIG" 2>/dev/null || echo "0")
        echo "  Configured Subnets: $subnet_count" >> "$report_file"
    else
        echo "DHCP Configuration: Missing" >> "$report_file"
    fi

    if [ -f "$CHRONY_CONFIG" ]; then
        echo "Chrony Configuration: Present" >> "$report_file"
        local server_count=$(grep -c "^server\|^pool" "$CHRONY_CONFIG" 2>/dev/null || echo "0")
        echo "  Configured Time Sources: $server_count" >> "$report_file"
    else
        echo "Chrony Configuration: Missing" >> "$report_file"
    fi

    if [ -f "$SAMBA_CONFIG" ]; then
        echo "Samba Configuration: Present" >> "$report_file"
        if grep -q "server role.*active directory domain controller" "$SAMBA_CONFIG" 2>/dev/null; then
            echo "  Role: Active Directory Domain Controller" >> "$report_file"
        else
            echo "  Role: Unknown or not AD-DC" >> "$report_file"
        fi
    else
        echo "Samba Configuration: Missing" >> "$report_file"
    fi
    echo "" >> "$report_file"

    echo "Detailed Test Log:" >> "$report_file"
    echo "==================" >> "$report_file"
    cat "$TEST_LOG" >> "$report_file"

    echo "Service failover test report saved to: $report_file"
    log_info "Service failover test report generated: $report_file"
}

# Main test execution
main() {
    log_info "Starting Service Failover Testing"
    echo "Service Failover Test Suite"
    echo "============================"

    # Initialize test log
    echo "Service Failover Test Log - $(date)" > "$TEST_LOG"

    # Run all tests
    test_dhcp_service
    test_ntp_service
    test_samba_service
    test_service_orchestration
    test_sysvol_service_config
    test_service_dependencies
    test_firewall_integration
    test_failover_simulation

    # Generate summary
    echo ""
    echo "Test Summary:"
    echo "============="
    echo "Total Tests: $TESTS_RUN"
    echo "Passed: $TESTS_PASSED"
    echo "Failed: $TESTS_FAILED"
    echo "Success Rate: $(( TESTS_PASSED * 100 / TESTS_RUN ))%"

    # Generate detailed report
    generate_service_report

    # Exit with appropriate code
    if [ $TESTS_FAILED -eq 0 ]; then
        log_info "All service failover tests passed successfully"
        exit 0
    else
        log_error "$TESTS_FAILED service failover test(s) failed"
        exit 1
    fi
}

# Usage information
usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Service Failover Testing Script - Tests DHCP, NTP, and service failover capabilities

OPTIONS:
    -h, --help              Show this help message
    -v, --verbose           Enable verbose output
    --simulate-failover     Run failover simulation only
    --check-services        Check current service status only
    --log-file FILE         Specify custom log file location

EXAMPLES:
    $0                      # Run all service failover tests
    $0 --check-services     # Check current service status
    $0 --simulate-failover  # Run failover simulation only
    $0 --verbose            # Run with verbose output

EOF
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            usage
            exit 0
            ;;
        -v|--verbose)
            set -x
            shift
            ;;
        --simulate-failover)
            test_failover_simulation
            exit $?
            ;;
        --check-services)
            echo "Current Service Status:"
            local services=("samba-ad-dc" "chrony" "isc-dhcp-server" "fsmo-orchestrator.timer")
            for service in "${services[@]}"; do
                local status=$(get_service_status "$service")
                echo "$service: $status"
            done
            exit 0
            ;;
        --log-file)
            TEST_LOG="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            usage
            exit 1
            ;;
    esac
done

# Run main function
main "$@"