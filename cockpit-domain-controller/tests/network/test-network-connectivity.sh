#!/bin/bash
# Network Connectivity Testing Script
# Tests network connectivity, DNS resolution, and AD service accessibility

set -e

SCRIPT_NAME="test-network-connectivity"
LOG_TAG="$SCRIPT_NAME"
TEST_LOG="/tmp/network-connectivity-test.log"

# Test configuration
DOMAIN_NAME=$(find /var/lib/samba/sysvol/ -maxdepth 1 -type d -name "*.local" 2>/dev/null | head -1 | xargs basename 2>/dev/null || echo "guedry.local")

# Network test parameters
TIMEOUT_PING=3
TIMEOUT_TCP=5
TIMEOUT_DNS=3

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

# Discover domain controllers
discover_domain_controllers() {
    local domain_name=$(hostname -d)
    local discovered_dcs=()
    
    # Method 1: DNS SRV record lookup
    if command -v dig >/dev/null 2>&1; then
        local srv_records
        if srv_records=$(dig +short _ldap._tcp."$domain_name" SRV 2>/dev/null); then
            while IFS= read -r srv_line; do
                if [[ -n "$srv_line" ]]; then
                    local dc_fqdn=$(echo "$srv_line" | awk '{print $4}' | sed 's/\.$//')
                    local dc_name=$(echo "$dc_fqdn" | cut -d. -f1 | tr '[:upper:]' '[:lower:]')
                    if [[ ! " ${discovered_dcs[*]} " =~ " ${dc_name} " ]]; then
                        discovered_dcs+=("$dc_name")
                    fi
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

# Test basic network interface configuration
test_network_interfaces() {
    start_test "Network Interface Configuration"
    
    # Get primary network interface
    local primary_interface=$(ip route | grep default | awk '{print $5}' | head -1)
    
    if [ -n "$primary_interface" ]; then
        log_info "Primary network interface: $primary_interface"
        
        # Check interface status
        if ip link show "$primary_interface" | grep -q "state UP"; then
            log_info "Interface $primary_interface is UP"
            
            # Get IP address
            local ip_address=$(ip addr show "$primary_interface" | grep "inet " | awk '{print $2}' | cut -d/ -f1 | head -1)
            
            if [ -n "$ip_address" ]; then
                log_info "Interface IP address: $ip_address"
                
                # Check if it's a static IP (not in common DHCP ranges)
                if [[ ! "$ip_address" =~ ^169\.254\. ]]; then
                    log_info "IP address appears to be properly configured"
                    pass_test "Network Interface Configuration"
                    return 0
                else
                    fail_test "Network Interface Configuration" "Interface has link-local address"
                    return 1
                fi
            else
                fail_test "Network Interface Configuration" "No IP address assigned"
                return 1
            fi
        else
            fail_test "Network Interface Configuration" "Interface is DOWN"
            return 1
        fi
    else
        fail_test "Network Interface Configuration" "No primary interface found"
        return 1
    fi
}

# Test DNS resolution
test_dns_resolution() {
    start_test "DNS Resolution"
    
    local domain_name=$(hostname -d)
    local this_hostname=$(hostname -f)
    
    # Test 1: Resolve this server's hostname
    if nslookup "$this_hostname" >/dev/null 2>&1; then
        log_info "Successfully resolved this server: $this_hostname"
        
        # Test 2: Resolve domain name
        if nslookup "$domain_name" >/dev/null 2>&1; then
            log_info "Successfully resolved domain: $domain_name"
            
            # Test 3: Reverse DNS lookup
            local ip_address=$(hostname -I | awk '{print $1}')
            if nslookup "$ip_address" >/dev/null 2>&1; then
                log_info "Reverse DNS lookup successful for: $ip_address"
            else
                log_info "Reverse DNS lookup failed (not critical)"
            fi
            
            # Test 4: SRV record resolution
            if nslookup -type=SRV "_ldap._tcp.$domain_name" >/dev/null 2>&1; then
                log_info "SRV record resolution successful"
                pass_test "DNS Resolution"
                return 0
            else
                log_info "SRV record resolution failed (may be normal)"
                pass_test "DNS Resolution"
                return 0
            fi
        else
            fail_test "DNS Resolution" "Cannot resolve domain name"
            return 1
        fi
    else
        fail_test "DNS Resolution" "Cannot resolve this server's hostname"
        return 1
    fi
}

# Test external connectivity
test_external_connectivity() {
    start_test "External Connectivity"
    
    # Test connectivity to common external hosts
    local external_hosts=("8.8.8.8" "1.1.1.1" "google.com")
    local successful_tests=0
    
    for host in "${external_hosts[@]}"; do
        if ping -c 1 -W $TIMEOUT_PING "$host" >/dev/null 2>&1; then
            log_info "Successfully reached external host: $host"
            ((successful_tests++))
        else
            log_info "Failed to reach external host: $host"
        fi
    done
    
    if [ $successful_tests -gt 0 ]; then
        log_info "External connectivity: $successful_tests/${#external_hosts[@]} hosts reachable"
        pass_test "External Connectivity"
        return 0
    else
        fail_test "External Connectivity" "No external hosts reachable"
        return 1
    fi
}

# Test AD service ports
test_ad_service_ports() {
    start_test "AD Service Ports"
    
    local this_server=$(hostname -f)
    local ad_ports=(
        "53:DNS"
        "88:Kerberos"
        "389:LDAP"
        "445:SMB"
        "464:Kerberos Password Change"
        "636:LDAPS"
        "3268:Global Catalog"
        "3269:Global Catalog SSL"
    )
    
    local open_ports=0
    local total_ports=${#ad_ports[@]}
    
    for port_info in "${ad_ports[@]}"; do
        local port=$(echo "$port_info" | cut -d: -f1)
        local service=$(echo "$port_info" | cut -d: -f2)
        
        if nc -z -w $TIMEOUT_TCP "$this_server" "$port" 2>/dev/null; then
            log_info "Port $port ($service) is open"
            ((open_ports++))
        else
            log_info "Port $port ($service) is closed or filtered"
        fi
    done
    
    if [ $open_ports -ge 4 ]; then
        log_info "AD service ports: $open_ports/$total_ports ports accessible"
        pass_test "AD Service Ports"
        return 0
    else
        fail_test "AD Service Ports" "Too few AD ports accessible ($open_ports/$total_ports)"
        return 1
    fi
}

# Test inter-DC connectivity
test_inter_dc_connectivity() {
    start_test "Inter-DC Connectivity"
    
    local discovered_dcs
    mapfile -t discovered_dcs < <(discover_domain_controllers)
    local this_server=$(hostname -s | tr '[:upper:]' '[:lower:]')
    
    if [ ${#discovered_dcs[@]} -le 1 ]; then
        log_info "Single DC environment - skipping inter-DC connectivity test"
        pass_test "Inter-DC Connectivity"
        return 0
    fi
    
    log_info "Testing connectivity to ${#discovered_dcs[@]} discovered DCs"
    
    local reachable_dcs=0
    local unreachable_dcs=()
    
    for dc in "${discovered_dcs[@]}"; do
        if [[ "$dc" == "$this_server" ]]; then
            log_info "Skipping self: $dc"
            continue
        fi
        
        # Test ping connectivity
        if ping -c 1 -W $TIMEOUT_PING "$dc" >/dev/null 2>&1; then
            log_info "DC $dc is reachable via ping"
            
            # Test key AD ports
            local dc_ad_ports=("389" "445" "88")
            local dc_open_ports=0
            
            for port in "${dc_ad_ports[@]}"; do
                if nc -z -w $TIMEOUT_TCP "$dc" "$port" 2>/dev/null; then
                    ((dc_open_ports++))
                fi
            done
            
            if [ $dc_open_ports -ge 2 ]; then
                log_info "DC $dc has $dc_open_ports/3 key AD ports accessible"
                ((reachable_dcs++))
            else
                log_info "DC $dc ping OK but AD ports not accessible"
                unreachable_dcs+=("$dc (ports)")
            fi
        else
            log_info "DC $dc is not reachable via ping"
            unreachable_dcs+=("$dc (ping)")
        fi
    done
    
    local remote_dc_count=$((${#discovered_dcs[@]} - 1))
    
    if [ $reachable_dcs -gt 0 ]; then
        log_info "Inter-DC connectivity: $reachable_dcs/$remote_dc_count DCs fully reachable"
        if [ ${#unreachable_dcs[@]} -gt 0 ]; then
            log_info "Unreachable DCs: ${unreachable_dcs[*]}"
        fi
        pass_test "Inter-DC Connectivity"
        return 0
    else
        fail_test "Inter-DC Connectivity" "No remote DCs reachable"
        return 1
    fi
}

# Test NTP connectivity
test_ntp_connectivity() {
    start_test "NTP Connectivity"
    
    # Check if chrony is running and configured
    if systemctl is-active chrony >/dev/null 2>&1; then
        log_info "Chrony service is active"
        
        # Check chrony sources
        if chronyc sources >/dev/null 2>&1; then
            local source_count=$(chronyc sources 2>/dev/null | grep -c "^\^" || echo "0")
            local reachable_sources=$(chronyc sources 2>/dev/null | grep -c "\*\|\+" || echo "0")
            
            log_info "NTP sources: $source_count configured, $reachable_sources reachable"
            
            # Check tracking information
            if chronyc tracking >/dev/null 2>&1; then
                local stratum=$(chronyc tracking 2>/dev/null | grep "Stratum" | awk '{print $3}')
                local offset=$(chronyc tracking 2>/dev/null | grep "Last offset" | awk '{print $4}')
                
                log_info "Time sync status - Stratum: $stratum, Offset: $offset"
                
                if [ "$stratum" != "0" ] && [ "$stratum" != "16" ]; then
                    log_info "Time synchronization is working correctly"
                    pass_test "NTP Connectivity"
                    return 0
                else
                    fail_test "NTP Connectivity" "Time synchronization not working (stratum $stratum)"
                    return 1
                fi
            else
                fail_test "NTP Connectivity" "Cannot get chrony tracking information"
                return 1
            fi
        else
            fail_test "NTP Connectivity" "Cannot query chrony sources"
            return 1
        fi
    else
        fail_test "NTP Connectivity" "Chrony service not active"
        return 1
    fi
}

# Test DHCP network configuration
test_dhcp_network() {
    start_test "DHCP Network Configuration"
    
    # Check if DHCP server is configured and potentially running
    if [ -f "/etc/dhcp/dhcpd.conf" ]; then
        log_info "DHCP configuration file exists"
        
        # Check for basic DHCP configuration
        if grep -q "subnet\|range" "/etc/dhcp/dhcpd.conf" 2>/dev/null; then
            local subnet_count=$(grep -c "subnet" "/etc/dhcp/dhcpd.conf" 2>/dev/null || echo "0")
            log_info "DHCP configured with $subnet_count subnet(s)"
            
            # Check DHCP service status
            local dhcp_status=$(systemctl is-active isc-dhcp-server 2>/dev/null || echo "inactive")
            log_info "DHCP service status: $dhcp_status"
            
            if [ "$dhcp_status" = "active" ]; then
                # Test DHCP port accessibility
                if nc -z -u -w $TIMEOUT_TCP localhost 67 2>/dev/null; then
                    log_info "DHCP port 67 is accessible"
                else
                    log_info "DHCP port 67 not accessible (may be normal)"
                fi
            fi
            
            pass_test "DHCP Network Configuration"
            return 0
        else
            fail_test "DHCP Network Configuration" "DHCP configuration appears incomplete"
            return 1
        fi
    else
        log_info "DHCP configuration file not found (may not be DHCP server)"
        pass_test "DHCP Network Configuration"
        return 0
    fi
}

# Test network latency to other DCs
test_network_latency() {
    start_test "Network Latency"
    
    local discovered_dcs
    mapfile -t discovered_dcs < <(discover_domain_controllers)
    local this_server=$(hostname -s | tr '[:upper:]' '[:lower:]')
    
    if [ ${#discovered_dcs[@]} -le 1 ]; then
        log_info "Single DC environment - skipping latency test"
        pass_test "Network Latency"
        return 0
    fi
    
    local total_latency=0
    local tested_dcs=0
    local high_latency_dcs=()
    
    for dc in "${discovered_dcs[@]}"; do
        if [[ "$dc" == "$this_server" ]]; then
            continue
        fi
        
        # Ping with multiple packets to get average
        local ping_result
        if ping_result=$(ping -c 3 -W $TIMEOUT_PING "$dc" 2>/dev/null); then
            local avg_latency=$(echo "$ping_result" | grep "rtt min/avg/max" | cut -d'/' -f5)
            
            if [ -n "$avg_latency" ]; then
                log_info "Latency to $dc: ${avg_latency}ms"
                
                # Check if latency is reasonable for AD (< 100ms is good, < 500ms acceptable)
                local latency_int=$(echo "$avg_latency" | cut -d'.' -f1)
                if [ "$latency_int" -gt 500 ]; then
                    high_latency_dcs+=("$dc:${avg_latency}ms")
                fi
                
                total_latency=$(echo "$total_latency + $avg_latency" | bc 2>/dev/null || echo "$total_latency")
                ((tested_dcs++))
            fi
        else
            log_info "Cannot measure latency to $dc (unreachable)"
        fi
    done
    
    if [ $tested_dcs -gt 0 ]; then
        if [ ${#high_latency_dcs[@]} -gt 0 ]; then
            log_info "High latency DCs detected: ${high_latency_dcs[*]}"
        fi
        
        log_info "Network latency test completed for $tested_dcs DCs"
        pass_test "Network Latency"
        return 0
    else
        log_info "No remote DCs available for latency testing"
        pass_test "Network Latency"
        return 0
    fi
}

# Test firewall configuration
test_firewall_configuration() {
    start_test "Firewall Configuration"
    
    # Check if firewalld is running
    if systemctl is-active firewalld >/dev/null 2>&1; then
        log_info "Firewalld is active"
        
        # Check current zone
        local active_zone=$(firewall-cmd --get-active-zones 2>/dev/null | head -1)
        log_info "Active firewall zone: $active_zone"
        
        # Check for AD-related services/ports
        local ad_services=("samba" "dns" "ldap" "kerberos")
        local allowed_services=0
        
        for service in "${ad_services[@]}"; do
            if firewall-cmd --list-services 2>/dev/null | grep -q "$service"; then
                log_info "Firewall allows $service service"
                ((allowed_services++))
            fi
        done
        
        # Check for specific ports
        local ad_ports=("53/tcp" "53/udp" "88/tcp" "389/tcp" "445/tcp")
        local allowed_ports=0
        
        for port in "${ad_ports[@]}"; do
            if firewall-cmd --list-ports 2>/dev/null | grep -q "$port"; then
                log_info "Firewall allows port $port"
                ((allowed_ports++))
            fi
        done
        
        local total_allowed=$((allowed_services + allowed_ports))
        
        if [ $total_allowed -gt 0 ]; then
            log_info "Firewall configuration: $allowed_services services + $allowed_ports ports allowed"
            pass_test "Firewall Configuration"
            return 0
        else
            fail_test "Firewall Configuration" "No AD services/ports allowed through firewall"
            return 1
        fi
    else
        log_info "Firewalld not active - assuming no firewall restrictions"
        pass_test "Firewall Configuration"
        return 0
    fi
}

# Generate network connectivity report
generate_network_report() {
    local report_file="/home/dguedry/Documents/ad-server/cockpit-domain-controller/tests/reports/network-connectivity-test-$(date +%Y%m%d-%H%M%S).txt"
    
    cat > "$report_file" << EOF
Network Connectivity Test Report
Generated: $(date '+%Y-%m-%d %H:%M:%S')
Server: $(hostname)
Domain: $DOMAIN_NAME

Test Summary:
=============
Total Tests: $TESTS_RUN
Passed: $TESTS_PASSED
Failed: $TESTS_FAILED
Success Rate: $(( TESTS_PASSED * 100 / TESTS_RUN ))%

Network Configuration Analysis:
===============================
EOF
    
    # Add network interface information
    local primary_interface=$(ip route | grep default | awk '{print $5}' | head -1)
    if [ -n "$primary_interface" ]; then
        local ip_address=$(ip addr show "$primary_interface" | grep "inet " | awk '{print $2}' | cut -d/ -f1 | head -1)
        local interface_status=$(ip link show "$primary_interface" | grep -o "state [A-Z]*" | awk '{print $2}')
        
        cat >> "$report_file" << EOF
Primary Interface: $primary_interface
Interface Status: $interface_status
IP Address: $ip_address
Gateway: $(ip route | grep default | awk '{print $3}' | head -1)

EOF
    fi
    
    # Add DNS configuration
    echo "DNS Configuration:" >> "$report_file"
    if [ -f "/etc/resolv.conf" ]; then
        local nameservers=$(grep "nameserver" /etc/resolv.conf | awk '{print $2}' | tr '\n' ' ')
        echo "Nameservers: $nameservers" >> "$report_file"
        local search_domains=$(grep "search\|domain" /etc/resolv.conf | awk '{$1=""; print $0}' | xargs)
        echo "Search Domains: $search_domains" >> "$report_file"
    else
        echo "DNS configuration file not found" >> "$report_file"
    fi
    echo "" >> "$report_file"
    
    # Add discovered DCs
    echo "Discovered Domain Controllers:" >> "$report_file"
    echo "=============================" >> "$report_file"
    local discovered_dcs
    mapfile -t discovered_dcs < <(discover_domain_controllers)
    
    local this_server=$(hostname -s | tr '[:upper:]' '[:lower:]')
    for dc in "${discovered_dcs[@]}"; do
        if [[ "$dc" == "$this_server" ]]; then
            echo "  🏠 $dc (this server)" >> "$report_file"
        elif ping -c 1 -W $TIMEOUT_PING "$dc" >/dev/null 2>&1; then
            echo "  ✅ $dc (reachable)" >> "$report_file"
        else
            echo "  ❌ $dc (unreachable)" >> "$report_file"
        fi
    done
    echo "" >> "$report_file"
    
    # Add service port status
    echo "AD Service Port Status:" >> "$report_file"
    echo "======================" >> "$report_file"
    local this_server_fqdn=$(hostname -f)
    local ad_ports=("53:DNS" "88:Kerberos" "389:LDAP" "445:SMB" "636:LDAPS" "3268:GC")
    
    for port_info in "${ad_ports[@]}"; do
        local port=$(echo "$port_info" | cut -d: -f1)
        local service=$(echo "$port_info" | cut -d: -f2)
        
        if nc -z -w $TIMEOUT_TCP "$this_server_fqdn" "$port" 2>/dev/null; then
            echo "  ✅ Port $port ($service): Open" >> "$report_file"
        else
            echo "  ❌ Port $port ($service): Closed/Filtered" >> "$report_file"
        fi
    done
    echo "" >> "$report_file"
    
    echo "Detailed Test Log:" >> "$report_file"
    echo "==================" >> "$report_file"
    cat "$TEST_LOG" >> "$report_file"
    
    echo "Network connectivity test report saved to: $report_file"
    log_info "Network connectivity test report generated: $report_file"
}

# Main test execution
main() {
    log_info "Starting Network Connectivity Testing"
    echo "Network Connectivity Test Suite"
    echo "================================"
    
    # Initialize test log
    echo "Network Connectivity Test Log - $(date)" > "$TEST_LOG"
    
    # Run all tests
    test_network_interfaces
    test_dns_resolution
    test_external_connectivity
    test_ad_service_ports
    test_inter_dc_connectivity
    test_ntp_connectivity
    test_dhcp_network
    test_network_latency
    test_firewall_configuration
    
    # Generate summary
    echo ""
    echo "Test Summary:"
    echo "============="
    echo "Total Tests: $TESTS_RUN"
    echo "Passed: $TESTS_PASSED"
    echo "Failed: $TESTS_FAILED"
    echo "Success Rate: $(( TESTS_PASSED * 100 / TESTS_RUN ))%"
    
    # Generate detailed report
    generate_network_report
    
    # Exit with appropriate code
    if [ $TESTS_FAILED -eq 0 ]; then
        log_info "All network connectivity tests passed successfully"
        exit 0
    else
        log_error "$TESTS_FAILED network connectivity test(s) failed"
        exit 1
    fi
}

# Usage information
usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Network Connectivity Testing Script - Tests network connectivity and AD services

OPTIONS:
    -h, --help              Show this help message
    -v, --verbose           Enable verbose output
    --quick                 Run quick connectivity tests only
    --latency               Test network latency only
    --ports                 Test AD service ports only
    --log-file FILE         Specify custom log file location

EXAMPLES:
    $0                      # Run all network connectivity tests
    $0 --quick              # Run basic connectivity tests only
    $0 --latency            # Test network latency to other DCs
    $0 --ports              # Test AD service port accessibility
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
        --quick)
            test_network_interfaces
            test_dns_resolution
            test_external_connectivity
            echo "Quick network tests completed"
            exit $?
            ;;
        --latency)
            test_network_latency
            exit $?
            ;;
        --ports)
            test_ad_service_ports
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