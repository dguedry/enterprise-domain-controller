#!/bin/bash
# Auto FSMO Seizure Script  
# Automatically seizes FSMO roles when the current holder is unreachable
# Should be run as root via systemd service

set -e

SCRIPT_NAME="auto-fsmo-seize"
LOG_TAG="$SCRIPT_NAME"
LOCK_FILE="/var/run/auto-fsmo-seize.lock"

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

# Lock management
acquire_lock() {
    if [ -f "$LOCK_FILE" ]; then
        local pid=$(cat "$LOCK_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            log_debug "Another instance is running (PID: $pid)"
            exit 0
        else
            log_info "Removing stale lock file"
            rm -f "$LOCK_FILE"
        fi
    fi
    echo $$ > "$LOCK_FILE"
}

release_lock() {
    rm -f "$LOCK_FILE"
}

cleanup() {
    release_lock
}
trap cleanup EXIT

# Check if we can query FSMO roles
check_fsmo_access() {
    if samba-tool fsmo show >/dev/null 2>&1; then
        return 0
    else
        log_error "Cannot access FSMO roles - may need to run as root"
        return 1
    fi
}

# Get current PDC emulator holder
get_pdc_holder() {
    local fsmo_output
    if fsmo_output=$(samba-tool fsmo show 2>/dev/null); then
        echo "$fsmo_output" | grep "PdcEmulationMasterRole owner:" | cut -d: -f2 | xargs
    else
        return 1
    fi
}

# Test if a DC is reachable
test_dc_connectivity() {
    local dc_name="$1"
    
    # Extract server name from CN format
    local server_name=$(echo "$dc_name" | sed 's/.*CN=\([^,]*\).*/\1/' | tr '[:upper:]' '[:lower:]')
    
    log_debug "Testing connectivity to DC: $server_name"
    
    # Try multiple connectivity tests
    if ping -c 2 -W 3 "$server_name" >/dev/null 2>&1; then
        log_debug "Ping successful to $server_name"
        return 0
    fi
    
    # Try LDAP connection
    if ldapsearch -x -H "ldap://$server_name" -b "" -s base >/dev/null 2>&1; then
        log_debug "LDAP connection successful to $server_name"
        return 0
    fi
    
    log_debug "No connectivity to $server_name"
    return 1
}

# Seize PDC emulator role
seize_pdc_role() {
    log_info "Seizing PDC Emulator role..."
    
    if samba-tool fsmo seize --role=pdc --force 2>/dev/null; then
        log_info "Successfully seized PDC Emulator role"
        
        # Trigger FSMO orchestration to reconfigure all services for new roles
        if [ -f "/usr/local/bin/fsmo-orchestrator.sh" ]; then
            log_info "Triggering FSMO orchestration for new role configuration"
            /usr/local/bin/fsmo-orchestrator.sh --orchestrate >/dev/null 2>&1 || true
        elif [ -f "/usr/local/bin/domain-service-orchestrator.sh" ]; then
            log_info "Triggering domain service orchestration for new role configuration"
            /usr/local/bin/domain-service-orchestrator.sh --orchestrate >/dev/null 2>&1 || true
        else
            # Fallback to old managers if orchestrators not available
            if [ -f "/usr/local/bin/ntp-fsmo-manager.sh" ]; then
                log_info "Updating NTP configuration for new PDC role (fallback)"
                /usr/local/bin/ntp-fsmo-manager.sh >/dev/null 2>&1 || true
            fi
            
            if [ -f "/usr/local/bin/dhcp-fsmo-manager.sh" ]; then
                log_info "Updating DHCP configuration for new PDC role (fallback)"
                /usr/local/bin/dhcp-fsmo-manager.sh >/dev/null 2>&1 || true
            fi
        fi
        
        return 0
    else
        log_error "Failed to seize PDC Emulator role"
        return 1
    fi
}

# Main seizure logic
main() {
    log_info "Starting automatic FSMO seizure check"
    
    acquire_lock
    
    # Check if we have access to FSMO roles
    if ! check_fsmo_access; then
        log_error "Cannot access FSMO - exiting"
        exit 1
    fi
    
    # Get current PDC holder
    local pdc_holder
    if ! pdc_holder=$(get_pdc_holder); then
        log_error "Cannot determine PDC holder - exiting"
        exit 1
    fi
    
    log_debug "Current PDC holder: $pdc_holder"
    
    # Test connectivity to PDC
    if test_dc_connectivity "$pdc_holder"; then
        log_debug "PDC is reachable - no seizure needed"
        exit 0
    fi
    
    log_error "PDC Emulator $pdc_holder is unreachable"
    
    # Wait a bit and test again to avoid false positives
    log_info "Waiting 30 seconds before retry..."
    sleep 30
    
    if test_dc_connectivity "$pdc_holder"; then
        log_info "PDC is now reachable - seizure cancelled"
        exit 0
    fi
    
    log_error "PDC still unreachable after retry - initiating seizure"
    
    # Seize PDC role
    if seize_pdc_role; then
        log_info "FSMO seizure completed successfully"
    else
        log_error "FSMO seizure failed"
        exit 1
    fi
}

# Show usage
show_usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Automatic FSMO Role Seizure Script

OPTIONS:
    -h, --help          Show this help message
    -f, --force         Force immediate seizure without connectivity tests
    -t, --test          Test connectivity only, don't seize

DESCRIPTION:
    This script automatically seizes the PDC Emulator role when the current
    holder becomes unreachable. It should be run as root via systemd timer.

EOF
}

case "${1:-}" in
    -h|--help)
        show_usage
        exit 0
        ;;
    -f|--force)
        log_info "Force seizing PDC Emulator role"
        acquire_lock
        check_fsmo_access && seize_pdc_role
        exit $?
        ;;
    -t|--test)
        acquire_lock
        check_fsmo_access || exit 1
        pdc_holder=$(get_pdc_holder) || exit 1
        echo "Current PDC: $pdc_holder"
        if test_dc_connectivity "$pdc_holder"; then
            echo "PDC is reachable"
            exit 0
        else
            echo "PDC is NOT reachable"
            exit 1
        fi
        ;;
    "")
        main
        ;;
    *)
        echo "Unknown option: $1"
        show_usage
        exit 1
        ;;
esac