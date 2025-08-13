#!/bin/bash
# Comprehensive Domain Controller Test Runner
# Runs all test suites and generates comprehensive reports for multi-DC environment testing
# Automatically discovers all domain controllers via DNS SRV records

echo "DEBUG: Script starting with $# arguments: $*" >&2

set -e

SCRIPT_NAME="run-all-tests"
LOG_TAG="$SCRIPT_NAME"
MASTER_LOG="/tmp/dc-comprehensive-test.log"

# Test configuration
TEST_BASE_DIR="cockpit-domain-controller/tests"
REPORTS_DIR="$TEST_BASE_DIR/reports"
DOMAIN_NAME=$(find /var/lib/samba/sysvol/ -maxdepth 1 -type d -name "*.local" 2>/dev/null | head -1 | xargs basename 2>/dev/null || echo "guedry.local")

# Test suite definitions
declare -A TEST_SUITES=(
    ["fsmo"]="$TEST_BASE_DIR/fsmo/test-fsmo-failover.sh"
    ["sysvol"]="$TEST_BASE_DIR/sysvol/test-sysvol-sync.sh"
    ["coordination"]="$TEST_BASE_DIR/coordination/test-multi-dc-coordination.sh"
    ["services"]="$TEST_BASE_DIR/services/test-service-failover.sh"
    ["network"]="$TEST_BASE_DIR/network/test-network-connectivity.sh"
)

# Test results tracking
TOTAL_SUITES=0
PASSED_SUITES=0
FAILED_SUITES=0
declare -A SUITE_RESULTS=()

# Test execution modes
RUN_QUICK=false
RUN_PARALLEL=false
VERBOSE=false
GENERATE_HTML=false

# Logging functions
log_info() {
    local msg="$1"
    echo "[INFO] $(date '+%Y-%m-%d %H:%M:%S') $msg" | tee -a "$MASTER_LOG"
    logger -t "$LOG_TAG" -p info "$msg"
}

log_error() {
    local msg="$1"
    echo "[ERROR] $(date '+%Y-%m-%d %H:%M:%S') $msg" | tee -a "$MASTER_LOG"
    logger -t "$LOG_TAG" -p err "$msg"
}

log_success() {
    local msg="$1"
    echo "[SUCCESS] $(date '+%Y-%m-%d %H:%M:%S') $msg" | tee -a "$MASTER_LOG"
    logger -t "$LOG_TAG" -p info "SUCCESS: $msg"
}

# Initialize test environment
initialize_test_environment() {
    log_info "Initializing comprehensive DC test environment"

    # Ensure reports directory exists
    mkdir -p "$REPORTS_DIR"

    # Discover all domain controllers
    local discovered_dcs
    mapfile -t discovered_dcs < <(discover_domain_controllers)
    local dc_count=${#discovered_dcs[@]}

    log_info "Discovered $dc_count domain controllers via DNS: ${discovered_dcs[*]}"

    # Initialize master log
    cat > "$MASTER_LOG" << EOF
Domain Controller Comprehensive Test Suite
==========================================
Started: $(date '+%Y-%m-%d %H:%M:%S')
Server: $(hostname)
Domain: $DOMAIN_NAME
Test Base Directory: $TEST_BASE_DIR
Discovered DCs: $dc_count (${discovered_dcs[*]})

Environment Information:
========================
EOF

    # Add system information
    echo "Hostname: $(hostname -f)" >> "$MASTER_LOG"
    echo "IP Address: $(hostname -I | awk '{print $1}')" >> "$MASTER_LOG"
    echo "OS: $(cat /etc/os-release | grep "PRETTY_NAME" | cut -d'"' -f2)" >> "$MASTER_LOG"
    echo "Kernel: $(uname -r)" >> "$MASTER_LOG"
    echo "Uptime: $(uptime | cut -d',' -f1 | cut -d' ' -f4-)" >> "$MASTER_LOG"

    # Add Samba information
    if command -v samba-tool >/dev/null 2>&1; then
        echo "Samba Version: $(samba-tool --version 2>/dev/null || echo 'Unknown')" >> "$MASTER_LOG"
        if samba-tool domain level show >/dev/null 2>&1; then
            echo "Domain Level: $(samba-tool domain level show 2>/dev/null | grep "Domain function level" | awk '{print $NF}')" >> "$MASTER_LOG"
        fi
    fi

    echo "" >> "$MASTER_LOG"
    log_info "Test environment initialized"
}

# Run individual test suite
run_test_suite() {
    local suite_name="$1"
    local suite_script="$2"
    local start_time=$(date +%s)

    log_info "Starting test suite: $suite_name"
    echo "═══════════════════════════════════════════════"
    echo "Running Test Suite: $(echo "$suite_name" | tr '[:lower:]' '[:upper:]')"
    echo "═══════════════════════════════════════════════"

    ((TOTAL_SUITES++))

    if [ -x "$suite_script" ]; then
        local suite_log="/tmp/${suite_name}-test-$(date +%s).log"

        # Run the test suite
        if $VERBOSE; then
            "$suite_script" --verbose 2>&1 | tee "$suite_log"
            local exit_code=${PIPESTATUS[0]}
        else
            "$suite_script" 2>&1 | tee "$suite_log"
            local exit_code=${PIPESTATUS[0]}
        fi

        local end_time=$(date +%s)
        local duration=$((end_time - start_time))

        if [ $exit_code -eq 0 ]; then
            log_success "Test suite $suite_name completed successfully (${duration}s)"
            SUITE_RESULTS["$suite_name"]="PASSED:$duration"
            ((PASSED_SUITES++))
        else
            log_error "Test suite $suite_name failed (${duration}s)"
            SUITE_RESULTS["$suite_name"]="FAILED:$duration"
            ((FAILED_SUITES++))
        fi

        # Append suite log to master log
        echo "" >> "$MASTER_LOG"
        echo "Test Suite: $suite_name (Exit Code: $exit_code, Duration: ${duration}s)" >> "$MASTER_LOG"
        echo "================================================================" >> "$MASTER_LOG"
        cat "$suite_log" >> "$MASTER_LOG"
        echo "" >> "$MASTER_LOG"

        # Clean up temporary log
        rm -f "$suite_log"

    else
        log_error "Test suite script not found or not executable: $suite_script"
        SUITE_RESULTS["$suite_name"]="ERROR:0"
        ((FAILED_SUITES++))
    fi

    echo ""
}

# Run test suites in parallel
run_parallel_tests() {
    log_info "Running test suites in parallel mode"

    local pids=()
    local suite_logs=()

    # Start all test suites in background
    for suite_name in "${!TEST_SUITES[@]}"; do
        local suite_script="${TEST_SUITES[$suite_name]}"
        local suite_log="/tmp/${suite_name}-parallel-$(date +%s).log"
        suite_logs+=("$suite_name:$suite_log")

        if [ -x "$suite_script" ]; then
            log_info "Starting parallel test suite: $suite_name"

            if $VERBOSE; then
                "$suite_script" --verbose > "$suite_log" 2>&1 &
            else
                "$suite_script" > "$suite_log" 2>&1 &
            fi

            pids+=("$!:$suite_name:$suite_log")
        else
            log_error "Test suite script not executable: $suite_script"
            SUITE_RESULTS["$suite_name"]="ERROR:0"
            ((FAILED_SUITES++))
        fi
    done

    # Wait for all tests to complete and collect results
    for pid_info in "${pids[@]}"; do
        local pid=$(echo "$pid_info" | cut -d: -f1)
        local suite_name=$(echo "$pid_info" | cut -d: -f2)
        local suite_log=$(echo "$pid_info" | cut -d: -f3)

        log_info "Waiting for test suite: $suite_name (PID: $pid)"

        local start_time=$(date +%s)
        wait "$pid"
        local exit_code=$?
        local end_time=$(date +%s)
        local duration=$((end_time - start_time))

        ((TOTAL_SUITES++))

        if [ $exit_code -eq 0 ]; then
            log_success "Parallel test suite $suite_name completed successfully (${duration}s)"
            SUITE_RESULTS["$suite_name"]="PASSED:$duration"
            ((PASSED_SUITES++))
        else
            log_error "Parallel test suite $suite_name failed (${duration}s)"
            SUITE_RESULTS["$suite_name"]="FAILED:$duration"
            ((FAILED_SUITES++))
        fi

        # Append results to master log
        echo "" >> "$MASTER_LOG"
        echo "Parallel Test Suite: $suite_name (Exit Code: $exit_code, Duration: ${duration}s)" >> "$MASTER_LOG"
        echo "================================================================" >> "$MASTER_LOG"
        cat "$suite_log" >> "$MASTER_LOG"
        echo "" >> "$MASTER_LOG"

        # Clean up
        rm -f "$suite_log"
    done
}

# Generate comprehensive summary report
generate_summary_report() {
    local report_file="$REPORTS_DIR/comprehensive-test-summary-$(date +%Y%m%d-%H%M%S).txt"
    local html_report=""

    if $GENERATE_HTML; then
        html_report="$REPORTS_DIR/comprehensive-test-summary-$(date +%Y%m%d-%H%M%S).html"
    fi

    log_info "Generating comprehensive test summary report"

    # Text report
    cat > "$report_file" << EOF
Domain Controller Comprehensive Test Summary
===========================================
Generated: $(date '+%Y-%m-%d %H:%M:%S')
Server: $(hostname -f)
Domain: $DOMAIN_NAME

Overall Test Results:
====================
Total Test Suites: $TOTAL_SUITES
Passed: $PASSED_SUITES
Failed: $FAILED_SUITES
Success Rate: $(( PASSED_SUITES * 100 / TOTAL_SUITES ))%

Test Suite Results:
==================
EOF

    # Add individual suite results
    for suite_name in "${!SUITE_RESULTS[@]}"; do
        local result_info="${SUITE_RESULTS[$suite_name]}"
        local status=$(echo "$result_info" | cut -d: -f1)
        local duration=$(echo "$result_info" | cut -d: -f2)

        if [ "$status" = "PASSED" ]; then
            echo "✅ $suite_name: PASSED (${duration}s)" >> "$report_file"
        else
            echo "❌ $suite_name: $status (${duration}s)" >> "$report_file"
        fi
    done

    echo "" >> "$report_file"

    # Add environment analysis
    cat >> "$report_file" << EOF
Environment Analysis:
====================
$(discover_environment_info)

Recommendations:
===============
$(generate_recommendations)

Individual Test Reports:
=======================
The following individual test reports were generated:
EOF

    # List individual reports
    find "$REPORTS_DIR" -name "*test-$(date +%Y%m%d)*" -newer "$report_file" 2>/dev/null | while read -r report; do
        echo "- $(basename "$report")" >> "$report_file"
    done

    echo "" >> "$report_file"
    echo "Complete Test Log:" >> "$report_file"
    echo "==================" >> "$report_file"
    cat "$MASTER_LOG" >> "$report_file"

    log_info "Text report generated: $report_file"

    # Generate HTML report if requested
    if $GENERATE_HTML; then
        generate_html_report "$html_report"
        log_info "HTML report generated: $html_report"
    fi

    echo "Comprehensive test summary saved to: $report_file"
    if $GENERATE_HTML; then
        echo "HTML report saved to: $html_report"
    fi
}

# Discover environment information
discover_environment_info() {
    cat << EOF
Domain Controllers Discovery:
$(discover_domain_controllers | while read -r dc; do echo "  - $dc"; done)

Current FSMO Role Holders:
$(get_current_fsmo_roles)

Service Status:
$(get_service_status_summary)

Network Configuration:
  Primary Interface: $(ip route | grep default | awk '{print $5}' | head -1)
  IP Address: $(hostname -I | awk '{print $1}')
  Domain: $DOMAIN_NAME
EOF
}

# Get current FSMO roles
get_current_fsmo_roles() {
    if command -v samba-tool >/dev/null 2>&1; then
        local fsmo_output
        if fsmo_output=$(sudo samba-tool fsmo show 2>/dev/null); then
            echo "$fsmo_output" | grep -E "(PdcRole|RidAllocationMasterRole|InfrastructureMasterRole|SchemaMasterRole|DomainNamingMasterRole)" | while read -r line; do
                local role=$(echo "$line" | sed 's/.*Role.*CN=\([^,]*\).*/\1/')
                local role_type=$(echo "$line" | sed 's/\(.*Role\).*/\1/')
                echo "  $role_type: $role"
            done
        else
            echo "  Unable to query FSMO roles"
        fi
    else
        echo "  Samba tools not available"
    fi
}

# Get service status summary
get_service_status_summary() {
    local services=("samba-ad-dc" "chrony" "isc-dhcp-server" "fsmo-orchestrator.timer")

    for service in "${services[@]}"; do
        local status=$(systemctl is-active "$service" 2>/dev/null || echo "inactive")
        echo "  $service: $status"
    done
}

# Discover domain controllers (simplified version)
discover_domain_controllers() {
    local domain_name=$DOMAIN_NAME
    local discovered_dcs=()

    if command -v dig >/dev/null 2>&1; then
        mapfile -t discovered_dcs < <(dig +short _ldap._tcp."$domain_name" SRV 2>/dev/null | awk '{print $4}' | sed 's/\.$//' | cut -d. -f1 | tr '[:upper:]' '[:lower:]' | sort -u)
    elif command -v nslookup >/dev/null 2>&1; then
        mapfile -t discovered_dcs < <(nslookup -type=SRV _ldap._tcp."$domain_name" 2>/dev/null | grep "service = " | awk '{print $NF}' | sed 's/\.$//' | cut -d. -f1 | tr '[:upper:]' '[:lower:]' | sort -u)
    fi

    # Always include current hostname as fallback
    local current_hostname=$(hostname -s | tr '[:upper:]' '[:lower:]')
    if [[ ${#discovered_dcs[@]} -eq 0 || ! " ${discovered_dcs[*]} " =~ " ${current_hostname} " ]]; then
        discovered_dcs+=("$current_hostname")
    fi

    printf '%s\n' "${discovered_dcs[@]}" | sort -u
}

# Generate recommendations based on test results
generate_recommendations() {
    local recommendations=()

    # Check for failed suites and provide recommendations
    for suite_name in "${!SUITE_RESULTS[@]}"; do
        local result_info="${SUITE_RESULTS[$suite_name]}"
        local status=$(echo "$result_info" | cut -d: -f1)

        case "$suite_name:$status" in
            "fsmo:FAILED")
                recommendations+=("- FSMO tests failed: Check FSMO role assignments and orchestration service")
                ;;
            "sysvol:FAILED")
                recommendations+=("- SYSVOL tests failed: Verify SYSVOL replication and permissions")
                ;;
            "coordination:FAILED")
                recommendations+=("- Multi-DC coordination failed: Check priority configuration and seizure locks")
                ;;
            "services:FAILED")
                recommendations+=("- Service failover tests failed: Check DHCP, NTP, and service orchestration")
                ;;
            "network:FAILED")
                recommendations+=("- Network tests failed: Check connectivity, DNS, and firewall configuration")
                ;;
        esac
    done

    # General recommendations
    if [ $FAILED_SUITES -gt 0 ]; then
        recommendations+=("- Review individual test reports for detailed failure analysis")
        recommendations+=("- Run failed test suites individually with --verbose for more information")
    fi

    if [ $PASSED_SUITES -eq $TOTAL_SUITES ]; then
        recommendations+=("- All tests passed! Your domain controller setup appears to be working correctly")
        recommendations+=("- Consider running these tests regularly to monitor DC health")
        recommendations+=("- Test failover capabilities by temporarily stopping services on other DCs")
    fi

    # Output recommendations
    if [ ${#recommendations[@]} -gt 0 ]; then
        printf '%s\n' "${recommendations[@]}"
    else
        echo "- No specific recommendations at this time"
    fi
}

# Generate HTML report
generate_html_report() {
    local html_file="$1"

    cat > "$html_file" << 'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Domain Controller Test Report</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background-color: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .header { text-align: center; border-bottom: 2px solid #333; padding-bottom: 20px; margin-bottom: 30px; }
        .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: #f8f9fa; padding: 20px; border-radius: 6px; text-align: center; border-left: 4px solid #007bff; }
        .stat-card.success { border-left-color: #28a745; }
        .stat-card.danger { border-left-color: #dc3545; }
        .test-results { margin-bottom: 30px; }
        .test-item { display: flex; justify-content: space-between; align-items: center; padding: 10px; margin: 5px 0; border-radius: 4px; }
        .test-item.passed { background-color: #d4edda; border-left: 4px solid #28a745; }
        .test-item.failed { background-color: #f8d7da; border-left: 4px solid #dc3545; }
        .recommendations { background: #fff3cd; padding: 20px; border-radius: 6px; border-left: 4px solid #ffc107; }
        .timestamp { color: #666; font-size: 0.9em; }
        h1, h2 { color: #333; }
        .badge { padding: 4px 8px; border-radius: 4px; color: white; font-size: 0.8em; }
        .badge.success { background-color: #28a745; }
        .badge.danger { background-color: #dc3545; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Domain Controller Test Report</h1>
            <p class="timestamp">Generated: $(date '+%Y-%m-%d %H:%M:%S')</p>
            <p>Server: $(hostname -f) | Domain: $DOMAIN_NAME</p>
        </div>

        <div class="summary">
            <div class="stat-card">
                <h3>Total Suites</h3>
                <div style="font-size: 2em; font-weight: bold;">$TOTAL_SUITES</div>
            </div>
            <div class="stat-card success">
                <h3>Passed</h3>
                <div style="font-size: 2em; font-weight: bold; color: #28a745;">$PASSED_SUITES</div>
            </div>
            <div class="stat-card danger">
                <h3>Failed</h3>
                <div style="font-size: 2em; font-weight: bold; color: #dc3545;">$FAILED_SUITES</div>
            </div>
            <div class="stat-card">
                <h3>Success Rate</h3>
                <div style="font-size: 2em; font-weight: bold;">$(( PASSED_SUITES * 100 / TOTAL_SUITES ))%</div>
            </div>
        </div>

        <div class="test-results">
            <h2>Test Suite Results</h2>
EOF

    # Add test results
    for suite_name in "${!SUITE_RESULTS[@]}"; do
        local result_info="${SUITE_RESULTS[$suite_name]}"
        local status=$(echo "$result_info" | cut -d: -f1)
        local duration=$(echo "$result_info" | cut -d: -f2)

        if [ "$status" = "PASSED" ]; then
            cat >> "$html_file" << EOF
            <div class="test-item passed">
                <span><strong>$(echo "$suite_name" | tr '[:lower:]' '[:upper:]')</strong></span>
                <span><span class="badge success">PASSED</span> ${duration}s</span>
            </div>
EOF
        else
            cat >> "$html_file" << EOF
            <div class="test-item failed">
                <span><strong>$(echo "$suite_name" | tr '[:lower:]' '[:upper:]')</strong></span>
                <span><span class="badge danger">$status</span> ${duration}s</span>
            </div>
EOF
        fi
    done

    cat >> "$html_file" << EOF
        </div>

        <div class="recommendations">
            <h2>Recommendations</h2>
            <ul>
$(generate_recommendations | sed 's/^- /                <li>/' | sed 's/$/<\/li>/')
            </ul>
        </div>
    </div>
</body>
</html>
EOF
}

# Create test summary for multiple DCs
create_multi_dc_summary() {
    local summary_file="$REPORTS_DIR/multi-dc-test-summary-$(date +%Y%m%d-%H%M%S).txt"
    local discovered_dcs
    mapfile -t discovered_dcs < <(discover_domain_controllers)
    local dc_count=${#discovered_dcs[@]}

    cat > "$summary_file" << EOF
Multi-DC Environment Test Summary
=================================
Generated: $(date '+%Y-%m-%d %H:%M:%S')
This Server: $(hostname -f)
Domain: $DOMAIN_NAME
Discovered DCs: $dc_count (${discovered_dcs[*]})

Instructions for Multi-DC Testing:
==================================
1. Run this test suite on all $dc_count domain controllers
2. Compare results to identify inconsistencies across DCs
3. Test failover by stopping services on primary DC
4. Verify SYSVOL replication between all $dc_count DCs
5. Check priority-based coordination during failures

Test Commands for Each DC:
=========================
# Run comprehensive tests
./run-all-tests.sh

# Run specific test suites
./run-all-tests.sh --suite fsmo
./run-all-tests.sh --suite coordination

# Quick connectivity test
./run-all-tests.sh --quick

# Simulate failover (run on secondary DC while primary is stopped)
./run-all-tests.sh --simulate-failover

Coordination Testing Steps:
==========================
1. Verify all DCs can discover each other
2. Check priority configuration on all DCs
3. Test seizure coordination by simulating DC failure
4. Verify service failover works correctly
5. Check SYSVOL synchronization timing

Expected Results for Healthy Multi-DC Environment:
===================================================
- All $dc_count DCs should discover each other via DNS SRV records
- FSMO roles should be properly assigned (all 5 roles)
- Service failover should work within 5-10 minutes
- SYSVOL should replicate configurations across all $dc_count DCs
- Priority-based coordination should prevent conflicts regardless of DC count

Current Test Results from $(hostname -f):
$(cat "$report_file" | grep -A 20 "Test Suite Results:")
EOF

    echo "Multi-DC test summary created: $summary_file"
    log_info "Multi-DC test summary generated: $summary_file"
}

# Display real-time test progress
show_progress() {
    local current=$1
    local total=$2
    local suite_name=$3

    local percent=$((current * 100 / total))
    local filled=$((percent / 5))
    local empty=$((20 - filled))

    printf "\rProgress: ["
    printf "%*s" $filled | tr ' ' '='
    printf "%*s" $empty | tr ' ' '-'
    printf "] %d%% (%d/%d) - %s" $percent $current $total "$suite_name"
}

# Main execution function
main() {
    local start_time=$(date +%s)

    # Discover DCs first for display
    local discovered_dcs
    mapfile -t discovered_dcs < <(discover_domain_controllers)
    local dc_count=${#discovered_dcs[@]}

    echo "Domain Controller Comprehensive Test Suite"
    echo "=========================================="
    echo "Server: $(hostname -f)"
    echo "Domain: $DOMAIN_NAME"
    echo "Discovered DCs: $dc_count (${discovered_dcs[*]})"
    echo "Started: $(date '+%Y-%m-%d %H:%M:%S')"
    echo ""

    # Initialize environment
    initialize_test_environment

    log_info "Starting test suite execution phase"

    # Run test suites
    if $RUN_PARALLEL; then
        run_parallel_tests
    else
        log_info "Running test suites sequentially (count: ${#TEST_SUITES[@]})"
        local current=0
        for suite_name in "${!TEST_SUITES[@]}"; do
            log_info "Processing suite: $suite_name"
            ((current++))
            log_info "About to check verbose flag: VERBOSE=$VERBOSE"
            if ! $VERBOSE; then
                log_info "Calling show_progress $current ${#TEST_SUITES[@]} $suite_name"
                show_progress $current ${#TEST_SUITES[@]} "$suite_name"
                echo ""
                log_info "show_progress completed"
            fi
            log_info "Executing test suite: $suite_name"
            run_test_suite "$suite_name" "${TEST_SUITES[$suite_name]}"
            log_info "Completed test suite: $suite_name"
        done
        log_info "All test suites completed"
    fi

    local end_time=$(date +%s)
    local total_duration=$((end_time - start_time))

    # Generate final summary
    echo ""
    echo "═══════════════════════════════════════════════"
    echo "COMPREHENSIVE TEST RESULTS SUMMARY"
    echo "═══════════════════════════════════════════════"
    echo "Total Test Suites: $TOTAL_SUITES"
    echo "Passed: $PASSED_SUITES"
    echo "Failed: $FAILED_SUITES"
    echo "Success Rate: $(( PASSED_SUITES * 100 / TOTAL_SUITES ))%"
    echo "Total Duration: ${total_duration}s"
    echo ""

    # Show individual results
    echo "Individual Results:"
    for suite_name in "${!SUITE_RESULTS[@]}"; do
        local result_info="${SUITE_RESULTS[$suite_name]}"
        local status=$(echo "$result_info" | cut -d: -f1)
        local duration=$(echo "$result_info" | cut -d: -f2)

        if [ "$status" = "PASSED" ]; then
            echo "  ✅ $(printf "%-15s" "$suite_name"): PASSED (${duration}s)"
        else
            echo "  ❌ $(printf "%-15s" "$suite_name"): $status (${duration}s)"
        fi
    done

    echo ""

    # Generate reports
    generate_summary_report
    create_multi_dc_summary

    # Final recommendations
    echo "Next Steps:"
    if [ $FAILED_SUITES -eq 0 ]; then
        echo "  ✅ All tests passed! Your DC setup is healthy."
        echo "  📋 Review the comprehensive report for detailed analysis"
        if [ $dc_count -gt 1 ]; then
            echo "  🔄 Run these tests on your other $((dc_count - 1)) DCs for complete validation"
        fi
        echo "  🧪 Consider testing failover scenarios manually"
    else
        echo "  ⚠️  $FAILED_SUITES test suite(s) failed - review individual reports"
        echo "  🔍 Run failed tests with --verbose for detailed debugging"
        echo "  📞 Check logs and service status for failed components"
        echo "  🔧 Fix issues before proceeding with multi-DC testing"
    fi

    echo ""
    echo "Test reports saved in: $REPORTS_DIR"

    # Ask user if they want to view the detailed report
    echo ""
    if [ -f "$MASTER_LOG" ]; then
        read -p "Would you like to view the detailed test report? (y/N): " -n 1 -r view_report
        echo ""
        if [[ $view_report =~ ^[Yy]$ ]]; then
            echo "Opening detailed test report..."
            if command -v less >/dev/null 2>&1; then
                less "$MASTER_LOG"
            elif command -v more >/dev/null 2>&1; then
                more "$MASTER_LOG"
            else
                cat "$MASTER_LOG"
            fi
        fi

        # Offer to view HTML report if generated
        local html_report="$REPORTS_DIR/comprehensive-test-report-$(date +%Y%m%d-%H%M%S).html"
        if [ -f "$html_report" ]; then
            read -p "Would you like to open the HTML report in your browser? (y/N): " -n 1 -r view_html
            echo ""
            if [[ $view_html =~ ^[Yy]$ ]]; then
                if command -v xdg-open >/dev/null 2>&1; then
                    xdg-open "$html_report"
                elif command -v firefox >/dev/null 2>&1; then
                    firefox "$html_report" &
                elif command -v chromium-browser >/dev/null 2>&1; then
                    chromium-browser "$html_report" &
                else
                    echo "HTML report available at: $html_report"
                fi
            fi
        fi
    fi

    # Exit with appropriate code
    if [ $FAILED_SUITES -eq 0 ]; then
        log_success "All comprehensive tests completed successfully"
        exit 0
    else
        log_error "Some test suites failed - review reports for details"
        exit 1
    fi
}

# Usage information
usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Comprehensive Domain Controller Test Runner - Tests all aspects of DC functionality

OPTIONS:
    -h, --help              Show this help message
    -v, --verbose           Enable verbose output for all tests
    -p, --parallel          Run test suites in parallel (faster but less detailed output)
    -q, --quick             Run only quick tests (network, basic connectivity)
    --suite SUITE           Run specific test suite only (fsmo, sysvol, coordination, services, network)
    --html                  Generate HTML report in addition to text report
    --simulate-failover     Run tests in failover simulation mode
    --multi-dc-summary      Generate multi-DC testing summary
    --log-file FILE         Specify custom master log file location

EXAMPLES:
    $0                      # Run all test suites sequentially
    $0 --parallel           # Run all test suites in parallel
    $0 --quick              # Run quick connectivity tests only
    $0 --suite fsmo         # Run FSMO failover tests only
    $0 --verbose --html     # Run with verbose output and generate HTML report
    $0 --simulate-failover  # Test failover capabilities

MULTI-DC TESTING:
    For multi-DC environment testing:
    1. Run this script on each DC: $0
    2. Suite automatically discovers all DCs via DNS SRV records
    3. Compare results across all discovered DCs
    4. Test failover: Stop primary DC, run: $0 --simulate-failover
    5. Verify SYSVOL sync: $0 --suite sysvol
    6. Check coordination: $0 --suite coordination

INDIVIDUAL TEST SUITES:
    fsmo         - FSMO role failover and management
    sysvol       - SYSVOL synchronization and replication
    coordination - Multi-DC coordination and priority management
    services     - Service failover (DHCP, NTP, Samba)
    network      - Network connectivity and DNS resolution

EOF
}

# Parse command line arguments
echo "DEBUG: Starting argument parsing with $# arguments: $*" >&2
while [[ $# -gt 0 ]]; do
    echo "DEBUG: Processing argument: '$1' (remaining: $#)" >&2
    case $1 in
        -h|--help)
            usage
            exit 0
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -p|--parallel)
            RUN_PARALLEL=true
            shift
            ;;
        -q|--quick)
            RUN_QUICK=true
            shift
            ;;
        --suite)
            if [[ $# -lt 2 ]]; then
                echo "Error: --suite requires an argument"
                echo "Available suites: ${!TEST_SUITES[*]}"
                exit 1
            fi
            suite_arg="$2"
            if [[ -n "${TEST_SUITES[$suite_arg]}" ]]; then
                # Run only the specified suite
                declare -A TEMP_SUITES=()
                TEMP_SUITES["$suite_arg"]="${TEST_SUITES[$suite_arg]}"
                TEST_SUITES=()
                for key in "${!TEMP_SUITES[@]}"; do
                    TEST_SUITES["$key"]="${TEMP_SUITES[$key]}"
                done
                shift 2
            else
                echo "Unknown test suite: $suite_arg"
                echo "Available suites: ${!TEST_SUITES[*]}"
                exit 1
            fi
            ;;
        --html)
            GENERATE_HTML=true
            shift
            ;;
        --simulate-failover)
            # Add failover flags to test suites
            log_info "Running in failover simulation mode"
            shift
            ;;
        --multi-dc-summary)
            initialize_test_environment
            create_multi_dc_summary
            exit 0
            ;;
        --log-file)
            MASTER_LOG="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            usage
            exit 1
            ;;
    esac
done

# Handle quick mode
if $RUN_QUICK; then
    log_info "Running in quick mode - network and basic connectivity only"
    declare -A QUICK_SUITES=(
        ["network"]="${TEST_SUITES[network]}"
    )
    TEST_SUITES=()
    for key in "${!QUICK_SUITES[@]}"; do
        TEST_SUITES["$key"]="${QUICK_SUITES[$key]}"
    done
fi

# Verify test scripts exist
missing_scripts=()
for suite_name in "${!TEST_SUITES[@]}"; do
    if [[ ! -x "${TEST_SUITES[$suite_name]}" ]]; then
        missing_scripts+=("$suite_name: ${TEST_SUITES[$suite_name]}")
    fi
done

if [[ ${#missing_scripts[@]} -gt 0 ]]; then
    echo "Error: The following test scripts are missing or not executable:"
    printf '  %s\n' "${missing_scripts[@]}"
    echo ""
    echo "Please ensure all test scripts are present and executable."
    exit 1
fi

# Run main execution
echo "DEBUG: About to call main with $# arguments: $*" >&2
main "$@"