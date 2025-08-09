#!/bin/bash
# FSMO Role Failover Testing Script
# Tests automatic FSMO role seizure and failover capabilities

set -e

SCRIPT_NAME="test-fsmo-failover"
LOG_TAG="$SCRIPT_NAME"
TEST_LOG="/tmp/fsmo-failover-test.log"

# Test configuration
DOMAIN_NAME=$(find /var/lib/samba/sysvol/ -maxdepth 1 -type d -name "*.local" 2>/dev/null | head -1 | xargs basename 2>/dev/null || echo "guedry.local")
SYSVOL_BASE="/var/lib/samba/sysvol/${DOMAIN_NAME}"
FSMO_CONFIG_DIR="${SYSVOL_BASE}/fsmo-configs"

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
    fsmo_output=$(samba-tool fsmo show 2>/dev/null || echo "FSMO_QUERY_FAILED")
    
    if [ "$fsmo_output" = "FSMO_QUERY_FAILED" ]; then
        echo "ERROR: Failed to query FSMO roles"
        return 1
    fi
    
    local this_server=$(hostname -s | tr '[:upper:]' '[:lower:]')
    
    # Extract role owners
    local pdc_owner=$(echo "$fsmo_output" | grep -i "PdcRole" | sed 's/.*CN=\([^,]*\).*/\1/' | tr '[:upper:]' '[:lower:]' || echo "unknown")
    local rid_owner=$(echo "$fsmo_output" | grep -i "RidAllocationMasterRole" | sed 's/.*CN=\([^,]*\).*/\1/' | tr '[:upper:]' '[:lower:]' || echo "unknown")
    local infra_owner=$(echo "$fsmo_output" | grep -i "InfrastructureMasterRole" | sed 's/.*CN=\([^,]*\).*/\1/' | tr '[:upper:]' '[:lower:]' || echo "unknown")
    local schema_owner=$(echo "$fsmo_output" | grep -i "SchemaMasterRole" | sed 's/.*CN=\([^,]*\).*/\1/' | tr '[:upper:]' '[:lower:]' || echo "unknown")
    local naming_owner=$(echo "$fsmo_output" | grep -i "DomainNamingMasterRole" | sed 's/.*CN=\([^,]*\).*/\1/' | tr '[:upper:]' '[:lower:]' || echo "unknown")
    
    echo "THIS_SERVER=$this_server"
    echo "PDC_OWNER=$pdc_owner"
    echo "RID_OWNER=$rid_owner"
    echo "INFRA_OWNER=$infra_owner"
    echo "SCHEMA_OWNER=$schema_owner"
    echo "NAMING_OWNER=$naming_owner"
}

# Test FSMO role query functionality
test_fsmo_query() {
    start_test "FSMO Role Query"
    
    local fsmo_info
    if fsmo_info=$(get_fsmo_roles); then
        eval "$fsmo_info"
        
        if [[ -n "$PDC_OWNER" && -n "$RID_OWNER" && -n "$INFRA_OWNER" && -n "$SCHEMA_OWNER" && -n "$NAMING_OWNER" ]]; then
            log_info "FSMO Roles: PDC=$PDC_OWNER, RID=$RID_OWNER, INFRA=$INFRA_OWNER, SCHEMA=$SCHEMA_OWNER, NAMING=$NAMING_OWNER"
            pass_test "FSMO Role Query"
            return 0
        else
            fail_test "FSMO Role Query" "Missing role information"
            return 1
        fi
    else
        fail_test "FSMO Role Query" "Failed to query FSMO roles"
        return 1
    fi
}

# Test FSMO orchestrator functionality
test_fsmo_orchestrator() {
    start_test "FSMO Orchestrator Execution"
    
    if /usr/local/bin/fsmo-orchestrator.sh --query >/dev/null 2>&1; then
        pass_test "FSMO Orchestrator Execution"
        return 0
    else
        fail_test "FSMO Orchestrator Execution" "Orchestrator script failed"
        return 1
    fi
}

# Test FSMO status tracking in SYSVOL
test_fsmo_status_tracking() {
    start_test "FSMO Status Tracking"
    
    # Initialize SYSVOL if needed
    if [ ! -d "$FSMO_CONFIG_DIR" ]; then
        /usr/local/bin/fsmo-orchestrator.sh --init
    fi
    
    local status_file="${FSMO_CONFIG_DIR}/fsmo-roles.conf"
    
    if [ -f "$status_file" ]; then
        local role_count=$(grep -c "^[A-Z].*=" "$status_file" 2>/dev/null || echo "0")
        if [ "$role_count" -ge 5 ]; then
            log_info "FSMO status file contains $role_count roles"
            pass_test "FSMO Status Tracking"
            return 0
        else
            fail_test "FSMO Status Tracking" "Status file missing roles (found: $role_count)"
            return 1
        fi
    else
        fail_test "FSMO Status Tracking" "Status file not found: $status_file"
        return 1
    fi
}

# Test multi-DC discovery
discover_domain_controllers() {
    local domain_name=$(hostname -d)
    local discovered_dcs=()
    
    # Try DNS SRV record lookup
    if command -v dig >/dev/null 2>&1; then
        local srv_records
        if srv_records=$(dig +short _ldap._tcp."$domain_name" SRV 2>/dev/null); then
            while IFS= read -r srv_line; do
                if [[ -n "$srv_line" ]]; then
                    local dc_fqdn=$(echo "$srv_line" | awk '{print $4}' | sed 's/\.$//')
                    local dc_name=$(echo "$dc_fqdn" | cut -d. -f1 | tr '[:upper:]' '[:lower:]')
                    discovered_dcs+=("$dc_name")
                fi
            done <<< "$srv_records"
        fi
    fi
    
    if [ ${#discovered_dcs[@]} -gt 0 ]; then
        # Remove duplicates and sort
        local unique_dcs=($(printf '%s\n' "${discovered_dcs[@]}" | sort -u))
        printf '%s\n' "${unique_dcs[@]}"
    fi
}

test_dc_discovery() {
    start_test "Domain Controller Discovery"

    local discovered_dcs
    mapfile -t discovered_dcs < <(discover_domain_controllers)

    if [ ${#discovered_dcs[@]} -gt 0 ]; then
        log_info "Discovered DCs: ${discovered_dcs[*]}"
        pass_test "Domain Controller Discovery"
        return 0
    else
        fail_test "Domain Controller Discovery" "No domain controllers discovered"
        return 1
    fi
}

# Test connectivity to other DCs
test_dc_connectivity() {
    start_test "DC Connectivity Testing"
    
    local fsmo_info
    if ! fsmo_info=$(get_fsmo_roles); then
        fail_test "DC Connectivity Testing" "Cannot get FSMO role information"
        return 1
    fi
    
    eval "$fsmo_info"
    local this_server="$THIS_SERVER"
    local reachable_dcs=0
    local total_dcs=0
    
    # Test connectivity to each role holder
    for role_owner in "$PDC_OWNER" "$RID_OWNER" "$INFRA_OWNER" "$SCHEMA_OWNER" "$NAMING_OWNER"; do
        if [[ -n "$role_owner" && "$role_owner" != "unknown" && "$role_owner" != "$this_server" ]]; then
            ((total_dcs++))
            
            # Test ping connectivity
            if ping -c 1 -W 2 "$role_owner" >/dev/null 2>&1; then
                ((reachable_dcs++))
                log_info "DC $role_owner is reachable"
                
                # Test LDAP port
                if nc -z -w 2 "$role_owner" 389 2>/dev/null; then
                    log_info "DC $role_owner LDAP port is accessible"
                else
                    log_error "DC $role_owner LDAP port is not accessible"
                fi
            else
                log_error "DC $role_owner is not reachable"
            fi
        fi
    done
    
    if [ $total_dcs -gt 0 ]; then
        log_info "DC Connectivity: $reachable_dcs/$total_dcs DCs reachable"
        if [ $reachable_dcs -gt 0 ]; then
            pass_test "DC Connectivity Testing"
            return 0
        else
            fail_test "DC Connectivity Testing" "No remote DCs reachable"
            return 1
        fi
    else
        log_info "Single DC environment - no remote DCs to test"
        pass_test "DC Connectivity Testing"
        return 0
    fi
}

# Test priority configuration
test_priority_configuration() {
    start_test "Priority Configuration"
    
    local priorities_file="${FSMO_CONFIG_DIR}/domain-dc-priorities.conf"
    
    # Initialize priorities if needed
    if [ ! -f "$priorities_file" ]; then
        /usr/local/bin/fsmo-orchestrator.sh --init
    fi
    
    if [ -f "$priorities_file" ]; then
        local this_server=$(hostname -s | tr '[:upper:]' '[:lower:]')
        
        # Check if this server has an entry
        if grep -q "^${this_server}:" "$priorities_file" 2>/dev/null; then
            log_info "Priority configuration found for this server"
            pass_test "Priority Configuration"
            return 0
        else
            fail_test "Priority Configuration" "No priority entry for this server"
            return 1
        fi
    else
        fail_test "Priority Configuration" "Priority configuration file not found"
        return 1
    fi
}

# Test auto-seizure configuration
test_auto_seizure_config() {
    start_test "Auto-Seizure Configuration"
    
    local seizure_config="${FSMO_CONFIG_DIR}/auto-seize.conf"
    
    # Initialize auto-seizure config if needed
    if [ ! -f "$seizure_config" ]; then
        /usr/local/bin/fsmo-orchestrator.sh --init
    fi
    
    if [ -f "$seizure_config" ]; then
        # Check for required configuration keys
        local required_keys=("AUTO_SEIZE_ENABLED" "SEIZURE_TIMEOUT" "AUTO_SEIZE_ROLES")
        local missing_keys=()
        
        for key in "${required_keys[@]}"; do
            if ! grep -q "^${key}=" "$seizure_config" 2>/dev/null; then
                missing_keys+=("$key")
            fi
        done
        
        if [ ${#missing_keys[@]} -eq 0 ]; then
            log_info "Auto-seizure configuration complete"
            pass_test "Auto-Seizure Configuration"
            return 0
        else
            fail_test "Auto-Seizure Configuration" "Missing keys: ${missing_keys[*]}"
            return 1
        fi
    else
        fail_test "Auto-Seizure Configuration" "Auto-seizure config file not found"
        return 1
    fi
}

# Test orchestration systemd integration
test_systemd_integration() {
    start_test "SystemD Integration"
    
    local timer_status=$(systemctl is-active fsmo-orchestrator.timer 2>/dev/null || echo "inactive")
    local timer_enabled=$(systemctl is-enabled fsmo-orchestrator.timer 2>/dev/null || echo "disabled")
    
    if [[ "$timer_status" == "active" && "$timer_enabled" == "enabled" ]]; then
        log_info "FSMO orchestrator timer is active and enabled"
        pass_test "SystemD Integration"
        return 0
    else
        fail_test "SystemD Integration" "Timer status: $timer_status, enabled: $timer_enabled"
        return 1
    fi
}

# Test manual FSMO role transfer
test_fsmo_manual_transfer() {
    start_test "FSMO Manual Role Transfer"

    local discovered_dcs
    mapfile -t discovered_dcs < <(discover_domain_controllers)

    if [ ${#discovered_dcs[@]} -lt 2 ]; then
        log_info "Skipping manual transfer test: requires at least 2 domain controllers."
        pass_test "FSMO Manual Role Transfer"
        return 0
    fi

    log_info "Multiple DCs found, proceeding with manual transfer test."

    local fsmo_info
    fsmo_info=$(get_fsmo_roles)
    eval "$fsmo_info"

    local original_pdc_owner="$PDC_OWNER"
    local this_server="$THIS_SERVER"
    local target_dc=""

    # Find a target DC that is not the current PDC owner
    for dc in "${discovered_dcs[@]}"; do
        if [[ "$dc" != "$original_pdc_owner" ]]; then
            target_dc=$dc
            break
        fi
    done

    if [ -z "$target_dc" ]; then
        # If all discovered DCs are the current owner, pick another one if possible
        for dc in "${discovered_dcs[@]}"; do
            if [[ "$dc" != "$this_server" ]]; then
                target_dc=$dc
                break
            fi
        done
    fi

    if [ -z "$target_dc" ]; then
        fail_test "FSMO Manual Role Transfer" "Could not find a suitable target DC to transfer role to."
        return 1
    fi

    log_info "Attempting to transfer PDC role from '$original_pdc_owner' to '$target_dc'"

    # Transfer the role
    if samba-tool fsmo transfer --role=pdc -H "$target_dc" --force; then
        log_info "Transfer command executed successfully. Verifying role change..."
        sleep 5 # Give a moment for the change to be recognized

        fsmo_info=$(get_fsmo_roles)
        eval "$fsmo_info"
        local new_pdc_owner="$PDC_OWNER"

        if [[ "$new_pdc_owner" == "$target_dc" ]]; then
            log_success "PDC role successfully transferred to '$target_dc'"

            # Transfer the role back to the original owner for cleanup
            log_info "Transferring PDC role back to '$original_pdc_owner'"
            if samba-tool fsmo transfer --role=pdc -H "$original_pdc_owner" --force; then
                log_info "Transfer back command successful. Verifying..."
                sleep 5
                fsmo_info=$(get_fsmo_roles)
                eval "$fsmo_info"
                if [[ "$PDC_OWNER" == "$original_pdc_owner" ]]; then
                    log_success "PDC role successfully transferred back to original owner."
                    pass_test "FSMO Manual Role Transfer"
                else
                    fail_test "FSMO Manual Role Transfer" "Failed to transfer role back. Current owner: $PDC_OWNER"
                fi
            else
                fail_test "FSMO Manual Role Transfer" "Failed to execute transfer back command."
            fi
        else
            fail_test "FSMO Manual Role Transfer" "Role owner did not change. Current owner: $new_pdc_owner"
        fi
    else
        fail_test "FSMO Manual Role Transfer" "samba-tool fsmo transfer command failed."
    fi
}

# Generate test report
generate_report() {
    local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local reports_dir="$(cd "$script_dir/../reports" && pwd)"
    local report_file="$reports_dir/fsmo-failover-test-$(date +%Y%m%d-%H%M%S).txt"
    
    # Ensure the reports directory exists
    mkdir -p "$reports_dir"

    cat > "$report_file" << EOF
FSMO Failover Test Report
Generated: $(date '+%Y-%m-%d %H:%M:%S')
Server: $(hostname)
Domain: $DOMAIN_NAME

Test Summary:
=============
Total Tests: $TESTS_RUN
Passed: $TESTS_PASSED
Failed: $TESTS_FAILED
Success Rate: $(( TESTS_PASSED * 100 / TESTS_RUN ))%

Current FSMO Role Assignments:
==============================
EOF
    
    # Add current FSMO roles to report
    if fsmo_info=$(get_fsmo_roles); then
        eval "$fsmo_info"
        cat >> "$report_file" << EOF
PDC Emulator: $PDC_OWNER
RID Master: $RID_OWNER
Infrastructure Master: $INFRA_OWNER
Schema Master: $SCHEMA_OWNER
Domain Naming Master: $NAMING_OWNER
This Server: $THIS_SERVER

EOF
    fi
    
    echo "Detailed Test Log:" >> "$report_file"
    echo "==================" >> "$report_file"
    cat "$TEST_LOG" >> "$report_file"
    
    echo "Test report saved to: $report_file"
    log_info "Test report generated: $report_file"
}

# Main test execution
main() {
    log_info "Starting FSMO Failover Testing"
    echo "FSMO Failover Test Suite"
    echo "========================"
    
    # Initialize test log
    echo "FSMO Failover Test Log - $(date)" > "$TEST_LOG"
    
    # Run all tests
    test_fsmo_query
    test_fsmo_orchestrator
    test_fsmo_status_tracking
    test_dc_discovery
    test_dc_connectivity
    test_priority_configuration
    test_auto_seizure_config
    test_systemd_integration
    test_fsmo_manual_transfer
    
    # Generate summary
    echo ""
    echo "Test Summary:"
    echo "============="
    echo "Total Tests: $TESTS_RUN"
    echo "Passed: $TESTS_PASSED"
    echo "Failed: $TESTS_FAILED"
    echo "Success Rate: $(( TESTS_PASSED * 100 / TESTS_RUN ))%"
    
    # Generate detailed report
    generate_report
    
    # Exit with appropriate code
    if [ $TESTS_FAILED -eq 0 ]; then
        log_info "All tests passed successfully"
        exit 0
    else
        log_error "$TESTS_FAILED test(s) failed"
        exit 1
    fi
}

# Usage information
usage() {
    cat << EOF
Usage: $0 [OPTIONS]

FSMO Failover Testing Script - Tests FSMO role management and failover capabilities

OPTIONS:
    -h, --help              Show this help message
    -v, --verbose           Enable verbose output
    --log-file FILE         Specify custom log file location

EXAMPLES:
    $0                      # Run all FSMO failover tests
    $0 --verbose            # Run with verbose output
    $0 --log-file /tmp/test.log  # Use custom log file

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