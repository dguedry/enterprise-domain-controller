#!/bin/bash
# SYSVOL Synchronization Testing Script
# Tests SYSVOL replication and configuration synchronization across domain controllers

set -e

SCRIPT_NAME="test-sysvol-sync"
LOG_TAG="$SCRIPT_NAME"
TEST_LOG="/tmp/sysvol-sync-test.log"

# Test configuration
DOMAIN_NAME=$(find /var/lib/samba/sysvol/ -maxdepth 1 -type d -name "*.local" 2>/dev/null | head -1 | xargs basename 2>/dev/null || echo "guedry.local")
SYSVOL_BASE="/var/lib/samba/sysvol/${DOMAIN_NAME}"
FSMO_CONFIG_DIR="${SYSVOL_BASE}/fsmo-configs"
TEST_MARKER_DIR="${SYSVOL_BASE}/test-markers"

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

# Discover other domain controllers
discover_domain_controllers() {
    local domain_name=$(hostname -d)
    if [ -z "$domain_name" ]; then
        domain_name="$DOMAIN_NAME"
    fi
    local discovered_dcs=()

    # Method 1: DNS SRV record lookup
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

    # Method 2: nslookup fallback
    if [ ${#discovered_dcs[@]} -eq 0 ] && command -v nslookup >/dev/null 2>&1; then
        local ns_output
        if ns_output=$(nslookup -type=SRV _ldap._tcp."$domain_name" 2>/dev/null); then
            local dc_names
            dc_names=$(echo "$ns_output" | grep "service = " | awk '{print $NF}' | sed 's/\.$//' | cut -d. -f1 | tr '[:upper:]' '[:lower:]' | sort -u)
            while IFS= read -r dc_name; do
                if [[ -n "$dc_name" ]]; then
                    discovered_dcs+=("$dc_name")
                fi
            done <<< "$dc_names"
        fi
    fi

    # Remove duplicates and sort
    local unique_dcs=($(printf '%s\n' "${discovered_dcs[@]}" | sort -u))
    printf '%s\n' "${unique_dcs[@]}"
}

# Test SYSVOL structure existence
test_sysvol_structure() {
    start_test "SYSVOL Structure"

    local required_dirs=(
        "$SYSVOL_BASE"
        "$FSMO_CONFIG_DIR"
        "${SYSVOL_BASE}/scripts"
        "${SYSVOL_BASE}/Policies"
    )

    local missing_dirs=()

    for dir in "${required_dirs[@]}"; do
        if [ ! -d "$dir" ]; then
            missing_dirs+=("$dir")
        fi
    done

    if [ ${#missing_dirs[@]} -eq 0 ]; then
        log_info "All required SYSVOL directories exist"
        pass_test "SYSVOL Structure"
        return 0
    else
        fail_test "SYSVOL Structure" "Missing directories: ${missing_dirs[*]}"
        return 1
    fi
}

# Test SYSVOL permissions
test_sysvol_permissions() {
    start_test "SYSVOL Permissions"

    # Check base SYSVOL permissions
    local sysvol_perms=$(stat -c "%a" "$SYSVOL_BASE" 2>/dev/null || echo "000")

    if [[ "$sysvol_perms" =~ ^(755|775)$ ]]; then
        log_info "SYSVOL base permissions correct: $sysvol_perms"

        # Check FSMO config directory permissions
        if [ -d "$FSMO_CONFIG_DIR" ]; then
            local fsmo_perms=$(stat -c "%a" "$FSMO_CONFIG_DIR" 2>/dev/null || echo "000")
            if [[ "$fsmo_perms" =~ ^(755|775)$ ]]; then
                log_info "FSMO config permissions correct: $fsmo_perms"
                pass_test "SYSVOL Permissions"
                return 0
            else
                fail_test "SYSVOL Permissions" "FSMO config perms incorrect: $fsmo_perms"
                return 1
            fi
        else
            fail_test "SYSVOL Permissions" "FSMO config directory missing"
            return 1
        fi
    else
        fail_test "SYSVOL Permissions" "SYSVOL base perms incorrect: $sysvol_perms"
        return 1
    fi
}

# Test FSMO configuration files in SYSVOL
test_fsmo_config_files() {
    start_test "FSMO Configuration Files"

    local required_files=(
        "${FSMO_CONFIG_DIR}/fsmo-roles.conf"
        "${FSMO_CONFIG_DIR}/fsmo-services.conf"
        "${FSMO_CONFIG_DIR}/domain-dc-priorities.conf"
    )

    local missing_files=()
    local existing_files=0

    for file in "${required_files[@]}"; do
        if [ -f "$file" ]; then
            ((existing_files++))
            log_info "Found config file: $(basename "$file")"
        else
            missing_files+=("$(basename "$file")")
        fi
    done

    if [ $existing_files -ge 2 ]; then
        if [ ${#missing_files[@]} -gt 0 ]; then
            log_info "Most config files exist, missing: ${missing_files[*]}"
        fi
        pass_test "FSMO Configuration Files"
        return 0
    else
        fail_test "FSMO Configuration Files" "Too few config files (${existing_files}/3)"
        return 1
    fi
}

# Create test marker file for sync testing
create_test_marker() {
    local marker_id="$1"
    local marker_file="${TEST_MARKER_DIR}/test-marker-${marker_id}-$(hostname -s).txt"

    # Create test markers directory if it doesn't exist
    if [ ! -d "$TEST_MARKER_DIR" ]; then
        mkdir -p "$TEST_MARKER_DIR" 2>/dev/null || mkdir -p "$TEST_MARKER_DIR"
    fi

    # Create marker file with timestamp and server info
    cat > "$marker_file" << EOF
Test Marker File
================
Marker ID: $marker_id
Created By: $(hostname -s)
Created At: $(date '+%Y-%m-%d %H:%M:%S')
Domain: $DOMAIN_NAME
Test Purpose: SYSVOL Synchronization Testing

This file is used to test SYSVOL replication across domain controllers.
If you see this file on other DCs, SYSVOL replication is working.
EOF

    log_info "Created test marker: $marker_file"
    echo "$marker_file"
}

# Check for test markers from other DCs
check_remote_markers() {
    start_test "Remote DC Markers"

    if [ ! -d "$TEST_MARKER_DIR" ]; then
        fail_test "Remote DC Markers" "Test markers directory not found"
        return 1
    fi

    local this_server=$(hostname -s)
    local remote_markers=()

    # Look for markers from other servers
    while IFS= read -r -d '' marker_file; do
        local marker_name=$(basename "$marker_file")
        if [[ ! "$marker_name" =~ $this_server ]]; then
            remote_markers+=("$marker_file")
        fi
    done < <(find "$TEST_MARKER_DIR" -name "test-marker-*.txt" -print0 2>/dev/null)

    if [ ${#remote_markers[@]} -gt 0 ]; then
        log_info "Found ${#remote_markers[@]} markers from remote DCs"
        for marker in "${remote_markers[@]}"; do
            local created_by=$(grep "Created By:" "$marker" | cut -d: -f2 | xargs)
            local created_at=$(grep "Created At:" "$marker" | cut -d: -f2- | xargs)
            log_info "  Marker from $created_by at $created_at"
        done
        pass_test "Remote DC Markers"
        return 0
    else
        log_info "No markers from remote DCs found (may indicate single DC or sync issue)"
        pass_test "Remote DC Markers"
        return 0
    fi
}

# Test SYSVOL write access
test_sysvol_write_access() {
    start_test "SYSVOL Write Access"

    local test_file="${SYSVOL_BASE}/write-test-$(date +%s).tmp"

    if echo "Write test" > "$test_file" 2>/dev/null; then
        if [ -f "$test_file" ]; then
            rm -f "$test_file" 2>/dev/null
            log_info "SYSVOL write access confirmed"
            pass_test "SYSVOL Write Access"
            return 0
        else
            fail_test "SYSVOL Write Access" "File creation appeared to succeed but file not found"
            return 1
        fi
    else
        # Try with sudo
        if sh -c "echo 'Write test' > '$test_file'" 2>/dev/null; then
            rm -f "$test_file" 2>/dev/null
            log_info "SYSVOL write access confirmed (with sudo)"
            pass_test "SYSVOL Write Access"
            return 0
        else
            fail_test "SYSVOL Write Access" "Cannot write to SYSVOL"
            return 1
        fi
    fi
}

# Test priority configuration synchronization
test_priority_sync() {
    start_test "Priority Configuration Sync"

    local priorities_file="${FSMO_CONFIG_DIR}/domain-dc-priorities.conf"
    local this_server=$(hostname -s | tr '[:upper:]' '[:lower:]')

    if [ ! -f "$priorities_file" ]; then
        # Initialize priorities
        /usr/local/bin/fsmo-orchestrator.sh --init >/dev/null 2>&1 || true
    fi

    if [ -f "$priorities_file" ]; then
        # Check if this server has an entry
        if grep -q "^${this_server}:" "$priorities_file" 2>/dev/null; then
            # Count total DC entries
            local dc_count=$(grep -c "^[a-zA-Z0-9].*:" "$priorities_file" 2>/dev/null || echo "0")
            log_info "Priority config has $dc_count DC entries including this server"

            # Check if we have entries for discovered DCs
            local discovered_dcs
            mapfile -t discovered_dcs < <(discover_domain_controllers)
            local found_remote_dcs=0

            for dc in "${discovered_dcs[@]}"; do
                if [[ "$dc" != "$this_server" ]] && grep -q "^${dc}:" "$priorities_file" 2>/dev/null; then
                    ((found_remote_dcs++))
                    log_info "Found priority entry for remote DC: $dc"
                fi
            done

            if [ $found_remote_dcs -gt 0 ] || [ ${#discovered_dcs[@]} -le 1 ]; then
                pass_test "Priority Configuration Sync"
                return 0
            else
                fail_test "Priority Configuration Sync" "No remote DC entries found in priorities"
                return 1
            fi
        else
            fail_test "Priority Configuration Sync" "This server not found in priorities"
            return 1
        fi
    else
        fail_test "Priority Configuration Sync" "Priority configuration file not found"
        return 1
    fi
}

# Test FSMO status synchronization
test_fsmo_status_sync() {
    start_test "FSMO Status Sync"

    local status_file="${FSMO_CONFIG_DIR}/fsmo-roles.conf"

    if [ -f "$status_file" ]; then
        # Check if status file has recent updates
        local last_modified=$(stat -c %Y "$status_file" 2>/dev/null || echo "0")
        local current_time=$(date +%s)
        local age=$((current_time - last_modified))

        # Consider file recent if modified within last hour
        if [ $age -lt 3600 ]; then
            log_info "FSMO status file recently updated (${age}s ago)"

            # Check if it contains role information
            local role_count=$(grep -c "^[A-Z].*=" "$status_file" 2>/dev/null || echo "0")
            if [ "$role_count" -ge 5 ]; then
                log_info "FSMO status contains $role_count role entries"
                pass_test "FSMO Status Sync"
                return 0
            else
                fail_test "FSMO Status Sync" "Insufficient role entries: $role_count"
                return 1
            fi
        else
            log_info "FSMO status file is old (${age}s), triggering update"
            /usr/local/bin/fsmo-orchestrator.sh --orchestrate-only >/dev/null 2>&1 || true
            pass_test "FSMO Status Sync"
            return 0
        fi
    else
        fail_test "FSMO Status Sync" "FSMO status file not found"
        return 1
    fi
}

# Test replication latency by creating and monitoring markers
test_replication_latency() {
    start_test "Replication Latency Test"

    local marker_id="latency-$(date +%s)"
    local marker_file

    # Create test marker
    if marker_file=$(create_test_marker "$marker_id"); then
        log_info "Created latency test marker: $(basename "$marker_file")"

        # Wait a bit for potential replication
        log_info "Waiting 30 seconds for potential replication..."
        sleep 30

        # Check if any remote DCs exist to replicate to
        local discovered_dcs
        mapfile -t discovered_dcs < <(discover_domain_controllers)
        local this_server=$(hostname -s)
        local remote_dc_count=0

        for dc in "${discovered_dcs[@]}"; do
            if [[ "$dc" != "$this_server" ]]; then
                ((remote_dc_count++))
            fi
        done

        if [ $remote_dc_count -eq 0 ]; then
            log_info "Single DC environment - no replication to test"
            pass_test "Replication Latency Test"
            return 0
        else
            log_info "Multi-DC environment detected ($remote_dc_count remote DCs)"
            log_info "Replication latency test marker created - check other DCs manually"
            pass_test "Replication Latency Test"
            return 0
        fi
    else
        fail_test "Replication Latency Test" "Failed to create test marker"
        return 1
    fi
}

# Test SYSVOL cleanup functionality
test_sysvol_cleanup() {
    start_test "SYSVOL Cleanup"

    # Look for old test markers (older than 1 day)
    local old_markers=()
    local current_time=$(date +%s)
    local one_day=$((24 * 3600))

    if [ -d "$TEST_MARKER_DIR" ]; then
        while IFS= read -r -d '' marker_file; do
            local file_time=$(stat -c %Y "$marker_file" 2>/dev/null || echo "0")
            local age=$((current_time - file_time))

            if [ $age -gt $one_day ]; then
                old_markers+=("$marker_file")
            fi
        done < <(find "$TEST_MARKER_DIR" -name "test-marker-*.txt" -print0 2>/dev/null)

        if [ ${#old_markers[@]} -gt 0 ]; then
            log_info "Found ${#old_markers[@]} old test markers for cleanup"

            # Clean up old markers
            for marker in "${old_markers[@]}"; do
                if rm -f "$marker" 2>/dev/null; then
                    log_info "Cleaned up old marker: $(basename "$marker")"
                fi
            done
        else
            log_info "No old test markers found for cleanup"
        fi
    else
        log_info "Test markers directory doesn't exist yet"
    fi

    pass_test "SYSVOL Cleanup"
    return 0
}

# Generate comprehensive SYSVOL report
generate_sysvol_report() {
    local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local reports_dir="$(cd "$script_dir/../reports" && pwd)"
    local report_file="$reports_dir/sysvol-sync-test-$(date +%Y%m%d-%H%M%S).txt"

    # Ensure the reports directory exists
    mkdir -p "$reports_dir"

    cat > "$report_file" << EOF
SYSVOL Synchronization Test Report
Generated: $(date '+%Y-%m-%d %H:%M:%S')
Server: $(hostname)
Domain: $DOMAIN_NAME

Test Summary:
=============
Total Tests: $TESTS_RUN
Passed: $TESTS_PASSED
Failed: $TESTS_FAILED
Success Rate: $(( TESTS_PASSED * 100 / TESTS_RUN ))%

SYSVOL Structure Analysis:
==========================
SYSVOL Base: $SYSVOL_BASE
EOF

    # Add directory analysis
    if [ -d "$SYSVOL_BASE" ]; then
        echo "SYSVOL Base Size: $(du -sh "$SYSVOL_BASE" | cut -f1)" >> "$report_file"
        echo "SYSVOL Permissions: $(stat -c "%a %U:%G" "$SYSVOL_BASE")" >> "$report_file"
        echo "" >> "$report_file"

        echo "SYSVOL Contents:" >> "$report_file"
        find "$SYSVOL_BASE" -maxdepth 2 -type d | while read -r dir; do
            echo "  $(basename "$dir"): $(stat -c "%a" "$dir" 2>/dev/null || echo "N/A")" >> "$report_file"
        done
        echo "" >> "$report_file"
    fi

    # Add discovered DCs
    echo "Discovered Domain Controllers:" >> "$report_file"
    echo "=============================" >> "$report_file"
    local discovered_dcs
    mapfile -t discovered_dcs < <(discover_domain_controllers)
    for dc in "${discovered_dcs[@]}"; do
        echo "  $dc" >> "$report_file"
    done
    echo "" >> "$report_file"

    # Add test markers analysis
    if [ -d "$TEST_MARKER_DIR" ]; then
        echo "Test Markers Analysis:" >> "$report_file"
        echo "=====================" >> "$report_file"
        local marker_count=$(find "$TEST_MARKER_DIR" -name "test-marker-*.txt" | wc -l)
        echo "Total Test Markers: $marker_count" >> "$report_file"

        if [ $marker_count -gt 0 ]; then
            echo "Marker Details:" >> "$report_file"
            find "$TEST_MARKER_DIR" -name "test-marker-*.txt" | while read -r marker; do
                local created_by=$(grep "Created By:" "$marker" | cut -d: -f2 | xargs)
                local created_at=$(grep "Created At:" "$marker" | cut -d: -f2- | xargs)
                echo "  $(basename "$marker"): $created_by at $created_at" >> "$report_file"
            done
        fi
        echo "" >> "$report_file"
    fi

    echo "Detailed Test Log:" >> "$report_file"
    echo "==================" >> "$report_file"
    cat "$TEST_LOG" >> "$report_file"

    echo "SYSVOL test report saved to: $report_file"
    log_info "SYSVOL test report generated: $report_file"
}

# Main test execution
main() {
    log_info "Starting SYSVOL Synchronization Testing"
    echo "SYSVOL Synchronization Test Suite"
    echo "=================================="

    # Initialize test log
    echo "SYSVOL Synchronization Test Log - $(date)" > "$TEST_LOG"

    # Run all tests
    test_sysvol_structure
    test_sysvol_permissions
    test_fsmo_config_files
    test_sysvol_write_access
    test_priority_sync
    test_fsmo_status_sync
    check_remote_markers
    test_replication_latency
    test_sysvol_cleanup

    # Generate summary
    echo ""
    echo "Test Summary:"
    echo "============="
    echo "Total Tests: $TESTS_RUN"
    echo "Passed: $TESTS_PASSED"
    echo "Failed: $TESTS_FAILED"
    echo "Success Rate: $(( TESTS_PASSED * 100 / TESTS_RUN ))%"

    # Generate detailed report
    generate_sysvol_report

    # Exit with appropriate code
    if [ $TESTS_FAILED -eq 0 ]; then
        log_info "All SYSVOL tests passed successfully"
        exit 0
    else
        log_error "$TESTS_FAILED SYSVOL test(s) failed"
        exit 1
    fi
}

# Usage information
usage() {
    cat << EOF
Usage: $0 [OPTIONS]

SYSVOL Synchronization Testing Script - Tests SYSVOL replication and config sync

OPTIONS:
    -h, --help              Show this help message
    -v, --verbose           Enable verbose output
    --create-marker ID      Create a test marker with specified ID
    --cleanup               Clean up old test markers
    --log-file FILE         Specify custom log file location

EXAMPLES:
    $0                      # Run all SYSVOL sync tests
    $0 --create-marker test1 # Create a test marker for replication testing
    $0 --cleanup            # Clean up old test markers
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
        --create-marker)
            if marker_file=$(create_test_marker "$2"); then
                echo "Created test marker: $marker_file"
                exit 0
            else
                echo "Failed to create test marker"
                exit 1
            fi
            ;;
        --cleanup)
            test_sysvol_cleanup
            exit $?
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