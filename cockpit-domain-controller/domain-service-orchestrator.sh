#!/bin/bash
# Domain Service Orchestrator
# Centralized management of domain services based on SYSVOL configurations
# Manages NTP, DHCP, and other domain services based on FSMO roles and PDC availability

set -e

SCRIPT_NAME="domain-service-orchestrator"
LOG_TAG="$SCRIPT_NAME"
LOCK_FILE="/var/run/domain-service-orchestrator.lock"

# Find domain name from SYSVOL structure
DOMAIN_NAME=$(find /var/lib/samba/sysvol/ -maxdepth 1 -type d -name "*.local" 2>/dev/null | head -1 | xargs basename 2>/dev/null || echo "guedry.local")
SYSVOL_BASE="/var/lib/samba/sysvol/${DOMAIN_NAME}"

# SYSVOL configuration directories
NTP_CONFIG_DIR="${SYSVOL_BASE}/ntp-configs"
DHCP_CONFIG_DIR="${SYSVOL_BASE}/dhcp-configs"
SERVICE_CONFIG_DIR="${SYSVOL_BASE}/service-configs"

# Local service configuration files
CHRONY_CONFIG="/etc/chrony/chrony.conf"
DHCP_CONFIG="/etc/dhcp/dhcpd.conf"

# Service status tracking
SERVICES_STATUS_FILE="${SERVICE_CONFIG_DIR}/services-status.conf"

# Logging functions
log_info() {
    logger -t "$LOG_TAG" -p info "$1"
    echo "[INFO] $(date '+%Y-%m-%d %H:%M:%S') $1"
}

log_error() {
    logger -t "$LOG_TAG" -p err "$1"
    echo "[ERROR] $(date '+%Y-%m-%d %H:%M:%S') $1" >&2
}

log_debug() {
    logger -t "$LOG_TAG" -p debug "$1"
    echo "[DEBUG] $(date '+%Y-%m-%d %H:%M:%S') $1"
}

# Lock management
acquire_lock() {
    if [ -f "$LOCK_FILE" ]; then
        local pid=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            log_debug "Another instance is running (PID: $pid)"
            exit 0
        else
            log_info "Removing stale lock file"
            rm -f "$LOCK_FILE"
        fi
    fi
    echo $$ > "$LOCK_FILE"
    trap 'release_lock; exit' INT TERM EXIT
}

release_lock() {
    rm -f "$LOCK_FILE"
}

# Initialize SYSVOL directories
init_sysvol_structure() {
    log_info "Initializing SYSVOL directory structure"
    
    for dir in "$NTP_CONFIG_DIR" "$DHCP_CONFIG_DIR" "$SERVICE_CONFIG_DIR"; do
        if [ ! -d "$dir" ]; then
            log_info "Creating directory: $dir"
            mkdir -p "$dir" || {
                log_error "Failed to create directory: $dir"
                exit 1
            }
        fi
    done
    
    # Create services status file if it doesn't exist
    if [ ! -f "$SERVICES_STATUS_FILE" ]; then
        cat > "$SERVICES_STATUS_FILE" << 'EOF'
# Domain Services Status Configuration
# This file tracks the status and configuration of domain services
# Format: SERVICE=STATUS:LAST_UPDATE:FSMO_ROLE:PDC_HOST

NTP=stopped:$(date '+%Y-%m-%d_%H:%M:%S'):unknown:unknown
DHCP=stopped:$(date '+%Y-%m-%d_%H:%M:%S'):unknown:unknown
DNS=stopped:$(date '+%Y-%m-%d_%H:%M:%S'):unknown:unknown
SAMBA=stopped:$(date '+%Y-%m-%d_%H:%M:%S'):unknown:unknown
EOF
        log_info "Created services status file: $SERVICES_STATUS_FILE"
    fi
}

# Check FSMO roles
check_fsmo_roles() {
    log_debug "Checking FSMO roles"
    
    local fsmo_output
    fsmo_output=$(samba-tool fsmo show 2>/dev/null || echo "FSMO_QUERY_FAILED")
    
    if [ "$fsmo_output" = "FSMO_QUERY_FAILED" ]; then
        log_error "Failed to query FSMO roles"
        return 1
    fi
    
    # Extract PDC Emulator role owner
    local pdc_owner
    pdc_owner=$(echo "$fsmo_output" | grep -i "PdcRole" | sed 's/.*CN=\([^,]*\).*/\1/' | tr '[:upper:]' '[:lower:]')
    
    # Get this server's hostname
    local this_server
    this_server=$(hostname -s | tr '[:upper:]' '[:lower:]')
    
    echo "PDC_OWNER=$pdc_owner"
    echo "THIS_SERVER=$this_server"
    
    # Check if this server holds PDC Emulator role
    if echo "$pdc_owner" | grep -qi "$this_server" || echo "$this_server" | grep -qi "$pdc_owner"; then
        echo "PDC_ROLE=true"
        log_info "This server holds PDC Emulator role"
    else
        echo "PDC_ROLE=false"
        log_info "This server does not hold PDC Emulator role (PDC: $pdc_owner)"
    fi
}

# Check PDC availability
check_pdc_availability() {
    local pdc_host="$1"
    
    if [ -z "$pdc_host" ] || [ "$pdc_host" = "unknown" ]; then
        log_debug "PDC host unknown, cannot check availability"
        return 1
    fi
    
    log_debug "Checking PDC availability: $pdc_host"
    
    # Test multiple connectivity methods
    local tests_passed=0
    
    # Test 1: Ping
    if ping -c 1 -W 2 "$pdc_host" >/dev/null 2>&1; then
        ((tests_passed++))
        log_debug "PDC ping test passed"
    else
        log_debug "PDC ping test failed"
    fi
    
    # Test 2: Samba port (445)
    if nc -z -w 2 "$pdc_host" 445 2>/dev/null; then
        ((tests_passed++))
        log_debug "PDC Samba port test passed"
    else
        log_debug "PDC Samba port test failed"
    fi
    
    # Test 3: NTP port (123) - for NTP service
    if nc -z -u -w 2 "$pdc_host" 123 2>/dev/null; then
        ((tests_passed++))
        log_debug "PDC NTP port test passed"
    else
        log_debug "PDC NTP port test failed"
    fi
    
    # PDC is considered available if at least 2/3 tests pass
    if [ $tests_passed -ge 2 ]; then
        log_info "PDC $pdc_host is available ($tests_passed/3 tests passed)"
        return 0
    else
        log_info "PDC $pdc_host is not available ($tests_passed/3 tests passed)"
        return 1
    fi
}

# Generate NTP configuration from SYSVOL
generate_ntp_config() {
    local role="$1"  # "pdc" or "dc"
    local pdc_host="$2"
    
    log_info "Generating NTP configuration for role: $role"
    
    # Read base chrony configuration template
    local base_config
    if [ -f "/usr/share/chrony/chrony.conf" ]; then
        base_config=$(cat /usr/share/chrony/chrony.conf)
    else
        # Fallback basic configuration
        base_config="# Basic chrony configuration
confdir /etc/chrony/conf.d
keyfile /etc/chrony/chrony.keys
driftfile /var/lib/chrony/chrony.drift
rtcsync
makestep 1 3
leapsectz right/UTC"
    fi
    
    # Create SYSVOL NTP configuration based on role
    local ntp_config_file
    if [ "$role" = "pdc" ]; then
        ntp_config_file="${NTP_CONFIG_DIR}/chrony.conf.pdc"
        cat > "$ntp_config_file" << EOF
$base_config

# NTP configuration for PDC Emulator (generated by domain-service-orchestrator)
# External NTP sources for PDC Emulator role
pool time.windows.com iburst
pool pool.ntp.org iburst  
pool time.google.com iburst
pool time.cloudflare.com iburst
pool time.nist.gov iburst

# Allow time serving to domain clients
allow all

# Serve time even if not synchronized to external sources
local stratum 10
EOF
        log_info "Generated PDC NTP configuration in SYSVOL"
    else
        ntp_config_file="${NTP_CONFIG_DIR}/chrony.conf.dc"
        cat > "$ntp_config_file" << EOF
$base_config

# NTP configuration for Additional DC (generated by domain-service-orchestrator)
# Sync with PDC Emulator for domain time consistency
$(if [ -n "$pdc_host" ] && [ "$pdc_host" != "unknown" ]; then
    echo "server $pdc_host iburst prefer"
    echo "# Fallback external sources if PDC is unavailable"
    echo "pool time.windows.com iburst"
    echo "pool pool.ntp.org iburst"
else
    echo "# PDC unavailable - using external sources"
    echo "pool time.windows.com iburst"
    echo "pool pool.ntp.org iburst"
    echo "pool time.google.com iburst"
fi)

# Allow time serving to domain clients
allow all

# Higher stratum since we're not the PDC
local stratum 11
EOF
        log_info "Generated Additional DC NTP configuration in SYSVOL"
    fi
    
    # Store configuration metadata
    cat > "${NTP_CONFIG_DIR}/ntp-settings.conf" << EOF
# NTP Configuration Metadata
ROLE=$role
PDC_HOST=$pdc_host
GENERATED=$(date '+%Y-%m-%d %H:%M:%S')
GENERATED_BY=$(hostname)
CONFIG_FILE=$(basename "$ntp_config_file")
EOF
    
    echo "$ntp_config_file"
}

# Apply NTP configuration from SYSVOL
apply_ntp_config() {
    local role="$1"
    local pdc_host="$2"
    
    log_info "Applying NTP configuration for role: $role"
    
    # Generate SYSVOL configuration
    local sysvol_config
    sysvol_config=$(generate_ntp_config "$role" "$pdc_host")
    
    if [ ! -f "$sysvol_config" ]; then
        log_error "Failed to generate SYSVOL NTP configuration"
        return 1
    fi
    
    # Backup current configuration
    if [ -f "$CHRONY_CONFIG" ]; then
        cp "$CHRONY_CONFIG" "${CHRONY_CONFIG}.backup.$(date +%Y%m%d-%H%M%S)" || {
            log_error "Failed to backup current chrony configuration"
            return 1
        }
    fi
    
    # Apply SYSVOL configuration to local system
    cp "$sysvol_config" "$CHRONY_CONFIG" || {
        log_error "Failed to apply NTP configuration from SYSVOL"
        return 1
    }
    
    # Restart chrony service
    systemctl restart chrony || {
        log_error "Failed to restart chrony service"
        return 1
    }
    
    log_info "NTP configuration applied successfully from SYSVOL"
    
    # Update services status
    update_service_status "NTP" "running" "$role" "$pdc_host"
}

# Generate DHCP configuration from SYSVOL
generate_dhcp_config() {
    local role="$1"  # "pdc" or "dc"
    
    log_info "Generating DHCP configuration for role: $role"
    
    if [ "$role" = "pdc" ]; then
        # PDC should run DHCP service
        local dhcp_config_file="${DHCP_CONFIG_DIR}/dhcpd.conf.active"
        
        # Check if we have existing DHCP configuration in SYSVOL
        if [ -f "${DHCP_CONFIG_DIR}/dhcp-settings.conf" ]; then
            source "${DHCP_CONFIG_DIR}/dhcp-settings.conf"
        fi
        
        # Generate DHCP configuration (use existing if available, or create basic one)
        if [ ! -f "$dhcp_config_file" ]; then
            cat > "$dhcp_config_file" << 'EOF'
# DHCP Configuration for PDC Emulator (generated by domain-service-orchestrator)
default-lease-time 600;
max-lease-time 7200;
authoritative;

# DNS settings for domain
option domain-name "guedry.local";
option domain-name-servers 192.168.1.10, 192.168.1.11;

# Network configuration
subnet 192.168.1.0 netmask 255.255.255.0 {
    range 192.168.1.100 192.168.1.200;
    option routers 192.168.1.1;
    option broadcast-address 192.168.1.255;
}
EOF
            log_info "Generated basic DHCP configuration in SYSVOL"
        fi
        
        echo "$dhcp_config_file"
    else
        # Additional DCs should not run DHCP
        log_info "Additional DC - DHCP service should be stopped"
        return 1
    fi
}

# Apply DHCP configuration from SYSVOL
apply_dhcp_config() {
    local role="$1"
    
    log_info "Applying DHCP configuration for role: $role"
    
    if [ "$role" = "pdc" ]; then
        # Generate SYSVOL configuration
        local sysvol_config
        sysvol_config=$(generate_dhcp_config "$role")
        
        if [ ! -f "$sysvol_config" ]; then
            log_error "Failed to generate SYSVOL DHCP configuration"
            return 1
        fi
        
        # Backup current configuration
        if [ -f "$DHCP_CONFIG" ]; then
            cp "$DHCP_CONFIG" "${DHCP_CONFIG}.backup.$(date +%Y%m%d-%H%M%S)" || {
                log_error "Failed to backup current DHCP configuration"
                return 1
            }
        fi
        
        # Apply SYSVOL configuration to local system
        cp "$sysvol_config" "$DHCP_CONFIG" || {
            log_error "Failed to apply DHCP configuration from SYSVOL"
            return 1
        }
        
        # Start/restart DHCP service
        systemctl enable isc-dhcp-server 2>/dev/null || systemctl enable dhcpd 2>/dev/null || true
        systemctl restart isc-dhcp-server 2>/dev/null || systemctl restart dhcpd 2>/dev/null || {
            log_error "Failed to restart DHCP service"
            return 1
        }
        
        log_info "DHCP configuration applied successfully from SYSVOL"
        update_service_status "DHCP" "running" "$role" "$(hostname)"
    else
        # Additional DCs should stop DHCP
        log_info "Stopping DHCP service on additional DC"
        systemctl stop isc-dhcp-server 2>/dev/null || systemctl stop dhcpd 2>/dev/null || true
        systemctl disable isc-dhcp-server 2>/dev/null || systemctl disable dhcpd 2>/dev/null || true
        update_service_status "DHCP" "stopped" "$role" "n/a"
    fi
}

# Update service status in SYSVOL
update_service_status() {
    local service="$1"
    local status="$2" 
    local role="$3"
    local host="$4"
    
    local timestamp=$(date '+%Y-%m-%d_%H:%M:%S')
    local this_host=$(hostname)
    
    # Update or add service status
    if [ -f "$SERVICES_STATUS_FILE" ]; then
        # Remove existing line for this service from this host
        grep -v "^${service}.*:${this_host}$" "$SERVICES_STATUS_FILE" > "${SERVICES_STATUS_FILE}.tmp" 2>/dev/null || true
        mv "${SERVICES_STATUS_FILE}.tmp" "$SERVICES_STATUS_FILE"
    fi
    
    # Add updated status
    echo "${service}=${status}:${timestamp}:${role}:${host}:${this_host}" >> "$SERVICES_STATUS_FILE"
    
    log_debug "Updated service status: $service=$status"
}

# Orchestrate all domain services
orchestrate_services() {
    log_info "Starting domain services orchestration"
    
    # Initialize SYSVOL structure
    init_sysvol_structure
    
    # Check FSMO roles
    local fsmo_info
    fsmo_info=$(check_fsmo_roles)
    
    if [ $? -ne 0 ]; then
        log_error "Failed to determine FSMO roles"
        return 1
    fi
    
    # Extract role information
    local pdc_owner pdc_role this_server
    eval "$fsmo_info"
    
    log_info "FSMO Status - PDC Owner: $pdc_owner, This Server: $this_server, PDC Role: $pdc_role"
    
    if [ "$pdc_role" = "true" ]; then
        # This server is PDC Emulator
        log_info "Configuring services as PDC Emulator"
        
        # Configure NTP for PDC role
        apply_ntp_config "pdc" ""
        
        # Configure DHCP for PDC role  
        apply_dhcp_config "pdc"
        
    else
        # This server is Additional DC
        log_info "Configuring services as Additional DC"
        
        # Check PDC availability
        local pdc_available=false
        if check_pdc_availability "$pdc_owner"; then
            pdc_available=true
        fi
        
        # Configure NTP for Additional DC role
        if [ "$pdc_available" = "true" ]; then
            apply_ntp_config "dc" "$pdc_owner"
        else
            log_info "PDC unavailable - configuring NTP with external sources"
            apply_ntp_config "pdc" ""  # Fallback to external sources
        fi
        
        # Configure DHCP for Additional DC role (stop service)
        apply_dhcp_config "dc"
    fi
    
    log_info "Domain services orchestration completed"
}

# Show current service status
show_status() {
    log_info "Current Domain Services Status:"
    echo "======================================"
    
    if [ -f "$SERVICES_STATUS_FILE" ]; then
        while IFS= read -r line; do
            if [[ $line == \#* ]] || [[ -z $line ]]; then
                continue
            fi
            echo "$line"
        done < "$SERVICES_STATUS_FILE"
    else
        echo "No status file found"
    fi
    
    echo "======================================"
    echo "NTP Status:"
    systemctl status chrony --no-pager -l 2>/dev/null || echo "Chrony status unavailable"
    
    echo "======================================"
    echo "DHCP Status:" 
    systemctl status isc-dhcp-server --no-pager -l 2>/dev/null || systemctl status dhcpd --no-pager -l 2>/dev/null || echo "DHCP status unavailable"
}

# Usage information
usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Domain Service Orchestrator - Manages domain services based on SYSVOL configurations

OPTIONS:
    -h, --help          Show this help message
    -o, --orchestrate   Orchestrate all domain services (default)
    -s, --status        Show current service status
    -i, --init          Initialize SYSVOL structure only
    -n, --ntp-only      Configure NTP service only
    -d, --dhcp-only     Configure DHCP service only
    -f, --force-pdc     Force PDC configuration regardless of FSMO role
    -v, --verbose       Enable verbose logging

DESCRIPTION:
    This script orchestrates domain services (NTP, DHCP) based on FSMO roles
    and PDC availability. All configurations are stored in SYSVOL and synchronized
    across domain controllers.

EXAMPLES:
    $0                      # Orchestrate all services
    $0 --status             # Show service status
    $0 --ntp-only           # Configure NTP only
    $0 --init               # Initialize SYSVOL structure

EOF
}

# Main execution
main() {
    local action="orchestrate"
    local verbose=false
    local force_pdc=false
    
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            -h|--help)
                usage
                exit 0
                ;;
            -o|--orchestrate)
                action="orchestrate"
                shift
                ;;
            -s|--status)
                action="status"
                shift
                ;;
            -i|--init)
                action="init"
                shift
                ;;
            -n|--ntp-only)
                action="ntp"
                shift
                ;;
            -d|--dhcp-only)
                action="dhcp"
                shift
                ;;
            -f|--force-pdc)
                force_pdc=true
                shift
                ;;
            -v|--verbose)
                verbose=true
                shift
                ;;
            *)
                echo "Unknown option: $1"
                usage
                exit 1
                ;;
        esac
    done
    
    # Acquire lock for all operations except status
    if [ "$action" != "status" ]; then
        acquire_lock
    fi
    
    # Execute requested action
    case $action in
        orchestrate)
            orchestrate_services
            ;;
        status)
            show_status
            ;;
        init)
            init_sysvol_structure
            ;;
        ntp)
            init_sysvol_structure
            local fsmo_info
            fsmo_info=$(check_fsmo_roles)
            eval "$fsmo_info"
            if [ "$pdc_role" = "true" ] || [ "$force_pdc" = "true" ]; then
                apply_ntp_config "pdc" ""
            else
                apply_ntp_config "dc" "$pdc_owner"
            fi
            ;;
        dhcp)
            init_sysvol_structure
            local fsmo_info
            fsmo_info=$(check_fsmo_roles)
            eval "$fsmo_info"
            if [ "$pdc_role" = "true" ] || [ "$force_pdc" = "true" ]; then
                apply_dhcp_config "pdc"
            else
                apply_dhcp_config "dc"
            fi
            ;;
    esac
}

# Run main function
main "$@"