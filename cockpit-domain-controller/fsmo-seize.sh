#!/bin/bash
# FSMO Role Seizure Script
# Seizes FSMO roles from a failed domain controller
# Part of cockpit-domain-controller package

set -e

SCRIPT_NAME="fsmo-seize"
LOG_TAG="$SCRIPT_NAME"

# Logging functions
log_info() {
    logger -t "$LOG_TAG" -p info "$1"
    echo "[INFO] $1"
}

log_error() {
    logger -t "$LOG_TAG" -p err "$1"
    echo "[ERROR] $1" >&2
}

log_debug() {
    logger -t "$LOG_TAG" -p debug "$1"
    echo "[DEBUG] $1"
}

# Check if this server can connect to the domain
check_domain_connectivity() {
    log_info "Checking domain connectivity..."
    
    if ! samba-tool domain info 2>/dev/null | grep -q "Domain"; then
        log_error "Cannot connect to domain - this server may not be properly joined"
        return 1
    fi
    
    log_info "Domain connectivity confirmed"
    return 0
}

# Check current FSMO role holders
check_fsmo_status() {
    log_info "Checking current FSMO role status..."
    
    local fsmo_output
    if ! fsmo_output=$(samba-tool fsmo show 2>/dev/null); then
        log_error "Failed to query FSMO roles"
        return 1
    fi
    
    echo "Current FSMO roles:"
    echo "$fsmo_output"
    return 0
}

# Test connectivity to current FSMO role holders
test_fsmo_connectivity() {
    local failed_dcs=""
    local fsmo_output
    
    log_info "Testing connectivity to FSMO role holders..."
    
    if ! fsmo_output=$(samba-tool fsmo show 2>/dev/null); then
        log_error "Failed to query FSMO roles"
        return 1
    fi
    
    # Extract unique server names from FSMO output
    local servers=$(echo "$fsmo_output" | grep -o 'CN=[^,]*' | sed 's/CN=//' | sort -u)
    
    for server in $servers; do
        log_debug "Testing connectivity to $server..."
        
        # Try to ping the server
        if ! ping -c 1 -W 3 "$server" >/dev/null 2>&1; then
            log_error "Cannot reach FSMO role holder: $server"
            failed_dcs="$failed_dcs $server"
        else
            log_info "Successfully reached: $server"
        fi
    done
    
    if [ -n "$failed_dcs" ]; then
        log_error "Failed to reach FSMO role holders:$failed_dcs"
        return 1
    fi
    
    log_info "All FSMO role holders are reachable"
    return 0
}

# Seize FSMO roles from failed DCs
seize_fsmo_roles() {
    log_info "Starting FSMO role seizure process..."
    
    local roles=(
        "schema"
        "naming"
        "pdc"
        "rid"
        "infrastructure"
    )
    
    local seized_count=0
    local failed_count=0
    
    for role in "${roles[@]}"; do
        log_info "Attempting to seize $role master role..."
        
        if samba-tool fsmo seize --role="$role" --force 2>/dev/null; then
            log_info "Successfully seized $role master role"
            ((seized_count++))
        else
            log_error "Failed to seize $role master role"
            ((failed_count++))
        fi
    done
    
    log_info "FSMO seizure completed: $seized_count succeeded, $failed_count failed"
    
    if [ $seized_count -gt 0 ]; then
        log_info "Verifying new FSMO role assignments..."
        samba-tool fsmo show
        return 0
    else
        log_error "No FSMO roles were successfully seized"
        return 1
    fi
}

# Force seize all FSMO roles (for emergency situations)
force_seize_all() {
    log_info "FORCE SEIZING ALL FSMO ROLES - This should only be done if the original PDC is permanently offline!"
    
    local roles=(
        "schema"
        "naming" 
        "pdc"
        "rid"
        "infrastructure"
    )
    
    for role in "${roles[@]}"; do
        log_info "Force seizing $role master role..."
        samba-tool fsmo seize --role="$role" --force 2>&1 | while read line; do
            log_debug "$role: $line"
        done
    done
    
    log_info "Verifying seized roles..."
    samba-tool fsmo show
}

# Check if current server should seize PDC role based on orchestrator status
should_seize_pdc() {
    # Check if FSMO orchestrator indicates this server should hold PDC role
    if [ -f "/usr/local/bin/fsmo-orchestrator.sh" ]; then
        local fsmo_status
        if fsmo_status=$(/usr/local/bin/fsmo-orchestrator.sh --query 2>/dev/null); then
            if echo "$fsmo_status" | grep -q "PDC_ROLE=true"; then
                log_info "FSMO orchestrator indicates this server should be PDC"
                return 0
            fi
        fi
    fi
    
    # Fallback: Check if DHCP FSMO manager thinks this should be the PDC (legacy)
    if [ -f "/usr/local/bin/dhcp-fsmo-manager.sh" ]; then
        if /usr/local/bin/dhcp-fsmo-manager.sh --check 2>/dev/null; then
            log_info "DHCP FSMO manager indicates this server should be PDC (legacy check)"
            return 0
        fi
    fi
    
    # Check if this server is configured as NTP master
    if grep -q "local stratum" /etc/chrony/chrony.conf 2>/dev/null; then
        log_info "This server appears to be configured as NTP master"
        return 0
    fi
    
    return 1
}

# Show usage
show_usage() {
    cat << EOF
Usage: $0 [OPTIONS]

FSMO Role Seizure Script for Samba AD-DC

OPTIONS:
    -h, --help          Show this help message
    -c, --check         Check current FSMO role status and connectivity
    -s, --seize         Seize FSMO roles from unreachable DCs
    -f, --force         Force seize ALL FSMO roles (DANGEROUS - use only if original PDC is permanently offline)
    -p, --pdc-only      Seize only PDC Emulator role
    -t, --test          Test connectivity to current FSMO role holders

DESCRIPTION:
    This script helps manage FSMO role seizure when domain controllers fail.
    Unlike Windows Server, Samba AD requires manual FSMO role seizure.
    
    IMPORTANT: Only seize FSMO roles if the original role holder is permanently offline!
    Seizing roles from a temporarily unreachable but still running DC can cause conflicts.

EXAMPLES:
    $0 --check          # Check current FSMO status
    $0 --test           # Test connectivity to FSMO role holders  
    $0 --seize          # Seize roles from unreachable DCs
    $0 --pdc-only       # Seize only PDC Emulator role
    $0 --force          # Emergency: seize all roles (DANGEROUS)

EOF
}

# Main function
main() {
    log_info "Starting FSMO management operations"
    
    # Check domain connectivity first
    if ! check_domain_connectivity; then
        log_error "Cannot proceed - domain connectivity check failed"
        exit 1
    fi
    
    case "${1:-}" in
        -c|--check)
            check_fsmo_status
            exit $?
            ;;
        -t|--test)
            test_fsmo_connectivity
            exit $?
            ;;
        -s|--seize)
            log_info "Testing connectivity before seizure..."
            if test_fsmo_connectivity; then
                log_error "All FSMO role holders are reachable - seizure not recommended"
                log_error "Use --force if you're certain the roles need to be seized"
                exit 1
            else
                seize_fsmo_roles
                exit $?
            fi
            ;;
        -p|--pdc-only)
            log_info "Seizing PDC Emulator role only..."
            if samba-tool fsmo seize --role=pdc --force; then
                log_info "Successfully seized PDC Emulator role"
                samba-tool fsmo show
            else
                log_error "Failed to seize PDC Emulator role"
                exit 1
            fi
            ;;
        -f|--force)
            echo "WARNING: This will force seize ALL FSMO roles!"
            echo "Only proceed if the original PDC is permanently offline."
            echo "Press Ctrl+C to cancel, or Enter to continue..."
            read -r
            force_seize_all
            ;;
        -h|--help)
            show_usage
            exit 0
            ;;
        "")
            # Default behavior - check status and recommend action
            log_info "Checking FSMO status and connectivity..."
            check_fsmo_status
            echo ""
            if test_fsmo_connectivity; then
                log_info "All FSMO role holders are reachable - no action needed"
            else
                log_error "Some FSMO role holders are unreachable!"
                echo ""
                echo "Recommended actions:"
                echo "  1. Verify the failed DC is permanently offline"
                echo "  2. Run: $0 --seize    (to seize roles from unreachable DCs)"
                echo "  3. Or:  $0 --pdc-only (to seize only PDC Emulator role)"
                echo ""
                echo "For emergency situations where original PDC is confirmed offline:"
                echo "  $0 --force"
            fi
            ;;
        *)
            echo "Unknown option: $1"
            show_usage
            exit 1
            ;;
    esac
}

# Run main function with all arguments
main "$@"