#!/bin/bash
# FSMO Role Orchestrator
# Comprehensive management of all FSMO roles and their associated services
# Extends domain-service-orchestrator.sh with complete FSMO role management

set -e

SCRIPT_NAME="fsmo-orchestrator"
LOG_TAG="$SCRIPT_NAME"
LOCK_FILE="/var/run/fsmo-orchestrator.lock"

# Find domain name from SYSVOL structure
DOMAIN_NAME=$(find /var/lib/samba/sysvol/ -maxdepth 1 -type d -name "*.local" 2>/dev/null | head -1 | xargs basename 2>/dev/null || echo "guedry.local")
SYSVOL_BASE="/var/lib/samba/sysvol/${DOMAIN_NAME}"

# SYSVOL configuration directories
FSMO_CONFIG_DIR="${SYSVOL_BASE}/fsmo-configs"
NTP_CONFIG_DIR="${SYSVOL_BASE}/ntp-configs"
DHCP_CONFIG_DIR="${SYSVOL_BASE}/dhcp-configs"
DNS_CONFIG_DIR="${SYSVOL_BASE}/dns-configs"
SERVICE_CONFIG_DIR="${SYSVOL_BASE}/service-configs"

# FSMO role status file
FSMO_STATUS_FILE="${FSMO_CONFIG_DIR}/fsmo-roles.conf"
FSMO_SERVICES_FILE="${FSMO_CONFIG_DIR}/fsmo-services.conf"

# Service configuration files
BIND_CONFIG="/etc/bind/named.conf.local"
SAMBA_CONFIG="/etc/samba/smb.conf"

# FSMO Roles and their responsibilities
declare -A FSMO_ROLES=(
    ["PDC"]="Time synchronization, Account lockouts, Password changes, GPO management"
    ["RID"]="Relative ID allocation, SID generation"
    ["INFRASTRUCTURE"]="Cross-domain object references, Phantom object cleanup"
    ["SCHEMA"]="Schema modifications, Forest-wide schema changes"
    ["DOMAIN_NAMING"]="Domain creation/deletion, Forest-wide naming"
)

# Services managed per FSMO role
declare -A FSMO_SERVICES=(
    ["PDC"]="chrony,isc-dhcp-server,samba-ad-dc"
    ["RID"]="samba-ad-dc"
    ["INFRASTRUCTURE"]="samba-ad-dc,bind9"
    ["SCHEMA"]="samba-ad-dc"
    ["DOMAIN_NAMING"]="samba-ad-dc,bind9"
)

# Auto-seizure configuration
AUTO_SEIZE_CONFIG="${FSMO_CONFIG_DIR}/auto-seize.conf"
AUTO_SEIZE_ENABLED=true
SEIZURE_TIMEOUT=180  # seconds to wait before seizing roles from unreachable DC
CONNECTIVITY_TESTS=3 # number of failed tests before considering DC unreachable

# Multi-DC coordination
DC_PRIORITY_FILE="${FSMO_CONFIG_DIR}/dc-priority.conf"           # Local DC config
DOMAIN_PRIORITIES_FILE="${FSMO_CONFIG_DIR}/domain-dc-priorities.conf"  # Shared SYSVOL config
SEIZURE_COORDINATION_FILE="${FSMO_CONFIG_DIR}/seizure-coordination.conf"
SEIZURE_LOCK_TIMEOUT=300  # seconds to hold seizure coordination lock

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

# Initialize SYSVOL structure for all FSMO roles
init_fsmo_sysvol() {
    log_info "Initializing FSMO SYSVOL structure"

    local directories=(
        "$FSMO_CONFIG_DIR"
        "$NTP_CONFIG_DIR"
        "$DHCP_CONFIG_DIR"
        "$DNS_CONFIG_DIR"
        "$SERVICE_CONFIG_DIR"
    )

    for dir in "${directories[@]}"; do
        if [ ! -d "$dir" ]; then
            log_info "Creating directory: $dir"
            mkdir -p "$dir" || {
                log_error "Failed to create directory: $dir"
                exit 1
            }
        fi
    done

    # Initialize FSMO roles configuration
    if [ ! -f "$FSMO_STATUS_FILE" ]; then
        local init_timestamp=$(date '+%Y-%m-%d_%H:%M:%S')
        cat > "$FSMO_STATUS_FILE" << EOF
# FSMO Roles Status Configuration
# Format: ROLE=HOLDER:LAST_CHECK:STATUS:SERVICES
# Status: ACTIVE, INACTIVE, SEIZED, UNKNOWN

PDC=unknown:${init_timestamp}:UNKNOWN:chrony,isc-dhcp-server,samba-ad-dc
RID=unknown:${init_timestamp}:UNKNOWN:samba-ad-dc
INFRASTRUCTURE=unknown:${init_timestamp}:UNKNOWN:samba-ad-dc,bind9
SCHEMA=unknown:${init_timestamp}:UNKNOWN:samba-ad-dc
DOMAIN_NAMING=unknown:${init_timestamp}:UNKNOWN:samba-ad-dc,bind9
EOF
        log_info "Created FSMO status file: $FSMO_STATUS_FILE"
    fi

    # Initialize FSMO services configuration
    if [ ! -f "$FSMO_SERVICES_FILE" ]; then
        cat > "$FSMO_SERVICES_FILE" << 'EOF'
# FSMO Services Configuration
# Defines which services should be active based on FSMO role ownership

# PDC Emulator Services
[PDC]
NTP_ROLE=external_sources
DHCP_SERVICE=active
TIME_SERVER=true
PASSWORD_POLICY=primary

# RID Master Services
[RID]
SID_ALLOCATION=primary
RID_POOL_MANAGEMENT=active

# Infrastructure Master Services
[INFRASTRUCTURE]
CROSS_DOMAIN_REFS=active
PHANTOM_CLEANUP=active
DNS_INFRASTRUCTURE=primary

# Schema Master Services
[SCHEMA]
SCHEMA_UPDATES=primary
FOREST_SCHEMA=owner

# Domain Naming Master Services
[DOMAIN_NAMING]
DOMAIN_OPERATIONS=primary
FOREST_DOMAINS=owner
DNS_FOREST_ZONES=primary
EOF
        log_info "Created FSMO services file: $FSMO_SERVICES_FILE"
    fi
}

# Query current FSMO role holders
query_fsmo_roles() {
    log_debug "Querying current FSMO role holders" >&2

    local fsmo_output
    fsmo_output=$(sudo samba-tool fsmo show 2>/dev/null || echo "FSMO_QUERY_FAILED")

    if [ "$fsmo_output" = "FSMO_QUERY_FAILED" ]; then
        log_error "Failed to query FSMO roles" >&2
        return 1
    fi

    # Parse FSMO output and extract role holders
    local pdc_owner rid_owner infra_owner schema_owner naming_owner
    local this_server
    this_server=$(hostname -s | tr '[:upper:]' '[:lower:]')

    # Extract role owners from samba-tool output
    pdc_owner=$(echo "$fsmo_output" | grep -i "PdcRole" | sed 's/.*CN=\([^,]*\).*/\1/' | tr '[:upper:]' '[:lower:]' || echo "unknown")
    rid_owner=$(echo "$fsmo_output" | grep -i "RidAllocationMasterRole" | sed 's/.*CN=\([^,]*\).*/\1/' | tr '[:upper:]' '[:lower:]' || echo "unknown")
    infra_owner=$(echo "$fsmo_output" | grep -i "InfrastructureMasterRole" | sed 's/.*CN=\([^,]*\).*/\1/' | tr '[:upper:]' '[:lower:]' || echo "unknown")
    schema_owner=$(echo "$fsmo_output" | grep -i "SchemaMasterRole" | sed 's/.*CN=\([^,]*\).*/\1/' | tr '[:upper:]' '[:lower:]' || echo "unknown")
    naming_owner=$(echo "$fsmo_output" | grep -i "DomainNamingMasterRole" | sed 's/.*CN=\([^,]*\).*/\1/' | tr '[:upper:]' '[:lower:]' || echo "unknown")

    # Determine which roles this server holds
    local held_roles=()

    if echo "$pdc_owner" | grep -qi "$this_server" || echo "$this_server" | grep -qi "$pdc_owner"; then
        held_roles+=("PDC")
    fi

    if echo "$rid_owner" | grep -qi "$this_server" || echo "$this_server" | grep -qi "$rid_owner"; then
        held_roles+=("RID")
    fi

    if echo "$infra_owner" | grep -qi "$this_server" || echo "$this_server" | grep -qi "$infra_owner"; then
        held_roles+=("INFRASTRUCTURE")
    fi

    if echo "$schema_owner" | grep -qi "$this_server" || echo "$this_server" | grep -qi "$schema_owner"; then
        held_roles+=("SCHEMA")
    fi

    if echo "$naming_owner" | grep -qi "$this_server" || echo "$this_server" | grep -qi "$naming_owner"; then
        held_roles+=("DOMAIN_NAMING")
    fi

    # Output results
    echo "THIS_SERVER=$this_server"
    echo "PDC_OWNER=$pdc_owner"
    echo "RID_OWNER=$rid_owner"
    echo "INFRA_OWNER=$infra_owner"
    echo "SCHEMA_OWNER=$schema_owner"
    echo "NAMING_OWNER=$naming_owner"
    echo "HELD_ROLES=${held_roles[*]}"

    log_info "FSMO Roles - This server holds: ${held_roles[*]:-none}" >&2
}

# Update FSMO status in SYSVOL
update_fsmo_status() {
    local role="$1"
    local holder="$2"
    local status="$3"
    local services="$4"

    local timestamp=$(date '+%Y-%m-%d_%H:%M:%S')
    local temp_file="${FSMO_STATUS_FILE}.tmp"

    # Update the specific role status
    if [ -f "$FSMO_STATUS_FILE" ]; then
        grep -v "^${role}=" "$FSMO_STATUS_FILE" > "$temp_file" 2>/dev/null || true
    else
        touch "$temp_file"
    fi

    echo "${role}=${holder}:${timestamp}:${status}:${services}" >> "$temp_file"
    mv "$temp_file" "$FSMO_STATUS_FILE"

    log_debug "Updated FSMO status: $role=$status (holder: $holder)"
}

# Configure services for PDC Emulator role
configure_pdc_services() {
    log_info "Configuring services for PDC Emulator role"

    # Use existing domain-service-orchestrator for NTP and DHCP
    if command -v domain-service-orchestrator.sh >/dev/null 2>&1; then
        domain-service-orchestrator.sh --orchestrate
    else
        log_error "domain-service-orchestrator.sh not found"
        return 1
    fi

    # Additional PDC-specific configurations
    configure_pdc_time_service
    configure_pdc_password_policy

    update_fsmo_status "PDC" "$(hostname -s)" "ACTIVE" "chrony,isc-dhcp-server,samba-ad-dc"
}

# Configure time service for PDC
configure_pdc_time_service() {
    log_info "Configuring authoritative time service for PDC"

    # Ensure chrony is configured as authoritative time server
    local time_config_file="${NTP_CONFIG_DIR}/pdc-time-authority.conf"

    cat > "$time_config_file" << 'EOF'
# PDC Emulator Time Authority Configuration
# This configuration makes the PDC the authoritative time source for the domain

# External time sources for PDC
pool time.windows.com iburst
pool pool.ntp.org iburst
pool time.google.com iburst
pool time.cloudflare.com iburst

# Allow time serving to all domain clients
allow all

# Act as authoritative time server even if not synchronized
local stratum 8
orphan stratum 9

# Enable NTP serving
port 123
EOF

    log_info "PDC time authority configuration created: $time_config_file"
}

# Configure password policy for PDC
configure_pdc_password_policy() {
    log_info "Configuring domain password policy for PDC"

    local policy_file="${FSMO_CONFIG_DIR}/password-policy.conf"

    cat > "$policy_file" << 'EOF'
# Domain Password Policy Configuration (PDC Emulator)
# This file tracks password policy settings for the domain

MINIMUM_PASSWORD_LENGTH=8
PASSWORD_COMPLEXITY=enabled
MAXIMUM_PASSWORD_AGE=90
MINIMUM_PASSWORD_AGE=1
PASSWORD_HISTORY=12
ACCOUNT_LOCKOUT_THRESHOLD=5
ACCOUNT_LOCKOUT_DURATION=30
LAST_UPDATED=$(date '+%Y-%m-%d %H:%M:%S')
MANAGED_BY=$(hostname)
EOF

    log_info "Password policy configuration created: $policy_file"
}

# Configure services for Infrastructure Master role
configure_infrastructure_services() {
    log_info "Configuring services for Infrastructure Master role"

    # Configure cross-domain reference management
    configure_cross_domain_refs

    # Configure phantom object cleanup
    configure_phantom_cleanup

    # Configure DNS infrastructure management
    configure_dns_infrastructure

    update_fsmo_status "INFRASTRUCTURE" "$(hostname -s)" "ACTIVE" "samba-ad-dc,bind9"
}

# Configure cross-domain reference management
configure_cross_domain_refs() {
    log_info "Configuring cross-domain reference management"

    local refs_config="${FSMO_CONFIG_DIR}/cross-domain-refs.conf"

    cat > "$refs_config" << 'EOF'
# Cross-Domain Reference Management Configuration
# Infrastructure Master manages references to objects in other domains

CLEANUP_INTERVAL=daily
PHANTOM_CLEANUP=enabled
REFERENCE_VALIDATION=enabled
CROSS_DOMAIN_MOVE_SUPPORT=enabled
LAST_CLEANUP=$(date '+%Y-%m-%d %H:%M:%S')
MANAGED_BY=$(hostname)
EOF

    log_info "Cross-domain reference configuration created: $refs_config"
}

# Configure phantom object cleanup
configure_phantom_cleanup() {
    log_info "Configuring phantom object cleanup"

    # Create cleanup script
    local cleanup_script="${FSMO_CONFIG_DIR}/phantom-cleanup.sh"

    cat > "$cleanup_script" << 'EOF'
#!/bin/bash
# Phantom Object Cleanup Script
# Run by Infrastructure Master to clean up orphaned references

LOG_FILE="/var/log/samba/phantom-cleanup.log"

log_cleanup() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

log_cleanup "Starting phantom object cleanup"

# Perform cleanup using samba-tool (example - customize based on needs)
sudo samba-tool domain backup rename-clone --new-domain-name=temp-cleanup-domain --new-netbios-name=TEMPCLEANUP --ignore-errors 2>/dev/null || true

log_cleanup "Phantom object cleanup completed"
EOF

    chmod +x "$cleanup_script"
    log_info "Phantom cleanup script created: $cleanup_script"
}

# Configure DNS infrastructure
configure_dns_infrastructure() {
    log_info "Configuring DNS infrastructure management"

    local dns_config="${DNS_CONFIG_DIR}/infrastructure-dns.conf"

    cat > "$dns_config" << 'EOF'
# DNS Infrastructure Management Configuration
# Infrastructure Master manages DNS infrastructure records

FOREST_DNS_ZONES=enabled
DOMAIN_DNS_ZONES=enabled
CONDITIONAL_FORWARDERS=managed
DNS_SCAVENGING=enabled
ZONE_TRANSFER_SECURITY=enabled
DYNAMIC_UPDATES=secure_only
LAST_UPDATED=$(date '+%Y-%m-%d %H:%M:%S')
MANAGED_BY=$(hostname)
EOF

    log_info "DNS infrastructure configuration created: $dns_config"
}

# Configure services for RID Master role
configure_rid_services() {
    log_info "Configuring services for RID Master role"

    # Configure RID pool management
    configure_rid_management

    update_fsmo_status "RID" "$(hostname -s)" "ACTIVE" "samba-ad-dc"
}

# Configure RID pool management
configure_rid_management() {
    log_info "Configuring RID pool management"

    local rid_config="${FSMO_CONFIG_DIR}/rid-management.conf"

    cat > "$rid_config" << 'EOF'
# RID Pool Management Configuration
# RID Master manages relative ID allocation

RID_POOL_SIZE=5000
RID_POOL_WARNING_THRESHOLD=1000
RID_ALLOCATION_MONITORING=enabled
AUTOMATIC_POOL_EXTENSION=enabled
POOL_EXHAUSTION_ALERTS=enabled
SID_GENERATION=managed
LAST_UPDATED=$(date '+%Y-%m-%d %H:%M:%S')
MANAGED_BY=$(hostname)
EOF

    log_info "RID management configuration created: $rid_config"
}

# Configure services for Schema Master role
configure_schema_services() {
    log_info "Configuring services for Schema Master role"

    # Configure schema management
    configure_schema_management

    update_fsmo_status "SCHEMA" "$(hostname -s)" "ACTIVE" "samba-ad-dc"
}

# Configure schema management
configure_schema_management() {
    log_info "Configuring schema management"

    local schema_config="${FSMO_CONFIG_DIR}/schema-management.conf"

    cat > "$schema_config" << 'EOF'
# Schema Management Configuration
# Schema Master manages forest-wide schema changes

SCHEMA_UPDATES=controlled
SCHEMA_EXTENSIONS=logged
SCHEMA_REPLICATION=monitored
EMERGENCY_SCHEMA_CHANGES=restricted
SCHEMA_VERSION_TRACKING=enabled
SCHEMA_CONFLICTS=monitored
LAST_UPDATED=$(date '+%Y-%m-%d %H:%M:%S')
MANAGED_BY=$(hostname)
EOF

    log_info "Schema management configuration created: $schema_config"
}

# Configure services for Domain Naming Master role
configure_domain_naming_services() {
    log_info "Configuring services for Domain Naming Master role"

    # Configure domain naming management
    configure_domain_naming_management

    update_fsmo_status "DOMAIN_NAMING" "$(hostname -s)" "ACTIVE" "samba-ad-dc,bind9"
}

# Configure domain naming management
configure_domain_naming_management() {
    log_info "Configuring domain naming management"

    local naming_config="${FSMO_CONFIG_DIR}/domain-naming.conf"

    cat > "$naming_config" << 'EOF'
# Domain Naming Management Configuration
# Domain Naming Master manages forest domain operations

DOMAIN_CREATION=controlled
DOMAIN_DELETION=controlled
FOREST_TRUST_MANAGEMENT=enabled
DOMAIN_RENAME_OPERATIONS=managed
FOREST_DNS_MANAGEMENT=primary
TRUST_RELATIONSHIP_MANAGEMENT=enabled
LAST_UPDATED=$(date '+%Y-%m-%d %H:%M:%S')
MANAGED_BY=$(hostname)
EOF

    log_info "Domain naming management configuration created: $naming_config"
}

# Orchestrate all FSMO role services
orchestrate_fsmo_roles() {
    log_info "Starting comprehensive FSMO role orchestration"

    # Initialize SYSVOL structure
    init_fsmo_sysvol

    # Query current FSMO role assignments
    local fsmo_info
    fsmo_info=$(query_fsmo_roles)

    if [ $? -ne 0 ]; then
        log_error "Failed to query FSMO roles"
        return 1
    fi

    # Extract role information
    eval "$fsmo_info"

    log_info "FSMO Orchestration - Server: $THIS_SERVER, Held Roles: $HELD_ROLES"

    # Configure services based on held roles
    for role in $HELD_ROLES; do
        case "$role" in
            "PDC")
                configure_pdc_services
                ;;
            "RID")
                configure_rid_services
                ;;
            "INFRASTRUCTURE")
                configure_infrastructure_services
                ;;
            "SCHEMA")
                configure_schema_services
                ;;
            "DOMAIN_NAMING")
                configure_domain_naming_services
                ;;
        esac
    done

    # Mark roles this server doesn't hold as inactive
    local all_roles=("PDC" "RID" "INFRASTRUCTURE" "SCHEMA" "DOMAIN_NAMING")
    for role in "${all_roles[@]}"; do
        if [[ ! " $HELD_ROLES " =~ " $role " ]]; then
            update_fsmo_status "$role" "other" "INACTIVE" "none"
        fi
    done

    log_info "FSMO role orchestration completed"
}

# Test connectivity to a domain controller
test_dc_connectivity() {
    local dc_host="$1"
    local tests_passed=0

    if [ -z "$dc_host" ] || [ "$dc_host" = "unknown" ]; then
        return 1
    fi

    log_debug "Testing connectivity to DC: $dc_host"

    # Test 1: Ping
    if ping -c 1 -W 2 "$dc_host" >/dev/null 2>&1; then
        ((tests_passed++))
    fi

    # Test 2: Samba port (445)
    if nc -z -w 2 "$dc_host" 445 2>/dev/null; then
        ((tests_passed++))
    fi

    # Test 3: LDAP port (389)
    if nc -z -w 2 "$dc_host" 389 2>/dev/null; then
        ((tests_passed++))
    fi

    log_debug "DC connectivity tests: $tests_passed/$CONNECTIVITY_TESTS passed"

    # DC is reachable if majority of tests pass
    [ $tests_passed -ge 2 ]
}

# Check if auto-seizure is enabled
is_auto_seize_enabled() {
    [ "$AUTO_SEIZE_ENABLED" = "true" ] || [ "$AUTO_SEIZE_ENABLED" = "1" ]
}

# Initialize auto-seizure configuration
init_auto_seize_config() {
    if [ ! -f "$AUTO_SEIZE_CONFIG" ]; then
        cat > "$AUTO_SEIZE_CONFIG" << EOF
# Auto-Seizure Configuration
# Controls automatic FSMO role seizure behavior

# Enable/disable auto-seizure (true/false)
AUTO_SEIZE_ENABLED=true

# Timeout before seizing roles from unreachable DC (seconds)
SEIZURE_TIMEOUT=180

# Number of connectivity tests that must fail before considering DC unreachable
CONNECTIVITY_TESTS=3

# Roles to automatically seize (comma-separated)
# Options: PDC,RID,INFRASTRUCTURE,SCHEMA,DOMAIN_NAMING
AUTO_SEIZE_ROLES=PDC,RID,INFRASTRUCTURE

# Minimum interval between seizure attempts (seconds)
SEIZURE_COOLDOWN=3600

# Last seizure attempt timestamp
LAST_SEIZURE_ATTEMPT=0

# Log seizure events
LOG_SEIZURES=true
EOF
        log_info "Created auto-seizure configuration: $AUTO_SEIZE_CONFIG"
    fi

    # Source configuration
    if [ -f "$AUTO_SEIZE_CONFIG" ]; then
        source "$AUTO_SEIZE_CONFIG"
    fi
}

# Initialize domain-wide DC priority configuration in SYSVOL
init_domain_priorities() {
    local this_server=$(hostname -s | tr '[:upper:]' '[:lower:]')

    # Create/update the domain-wide priorities file in SYSVOL
    if [ ! -f "$DOMAIN_PRIORITIES_FILE" ]; then
        log_info "Creating domain-wide DC priorities configuration in SYSVOL"
        cat > "$DOMAIN_PRIORITIES_FILE" << 'EOF'
# Domain-wide DC Priority Configuration (SHARED via SYSVOL)
# Lower priority numbers get preference for FSMO role seizure
# Format: DC_NAME:PRIORITY:PDC_PREF:RID_PREF:INFRA_PREF:SCHEMA_PREF:NAMING_PREF:LAST_SEEN
#
# Priority Scale: 0-100 (lower = higher priority)
# Role Preferences: 0-100 (lower = higher priority for that specific role)
#
# This file is automatically maintained by fsmo-orchestrator
# Manual edits are preserved but may be overwritten by auto-discovery

# Example entries:
# dc1:10:10:10:20:30:30:2024-08-04_16:30:00
# dc2:20:20:20:10:40:40:2024-08-04_16:30:00
# dc3:30:50:50:50:10:10:2024-08-04_16:30:00

EOF
    fi

    # Update this DC's entry in the shared file
    update_dc_priority_in_domain_config "$this_server"
}

# Update this DC's priority in the domain-wide configuration
update_dc_priority_in_domain_config() {
    local dc_name="$1"
    local current_time=$(date '+%Y-%m-%d_%H:%M:%S')

    # Calculate default priority based on hostname (consistent across runs)
    local hash_priority=$(echo "$dc_name" | md5sum | sed 's/[a-f]/5/g' | cut -c1-2)
    local default_priority=$((hash_priority % 90 + 10))  # Range 10-99

    # Check if DC already exists in the file
    if grep -q "^${dc_name}:" "$DOMAIN_PRIORITIES_FILE" 2>/dev/null; then
        # Update existing entry's last seen time
        sed -i "s/^${dc_name}:\([^:]*:[^:]*:[^:]*:[^:]*:[^:]*:[^:]*:\).*/${dc_name}:\1${current_time}/" "$DOMAIN_PRIORITIES_FILE"
        log_debug "Updated last seen time for DC $dc_name"
    else
        # Add new DC entry with calculated priority
        echo "${dc_name}:${default_priority}:${default_priority}:${default_priority}:${default_priority}:${default_priority}:${default_priority}:${current_time}" >> "$DOMAIN_PRIORITIES_FILE"
        log_info "Added DC $dc_name to domain priorities with default priority $default_priority"
    fi
}

# Get DC priority from domain-wide configuration
get_dc_priority_from_domain() {
    local dc_name="$1"
    local role="$2"
    local default_priority=50

    if [ ! -f "$DOMAIN_PRIORITIES_FILE" ]; then
        echo "$default_priority"
        return
    fi

    local dc_entry
    if dc_entry=$(grep "^${dc_name}:" "$DOMAIN_PRIORITIES_FILE" 2>/dev/null); then
        local priority_data=(${dc_entry//:/ })

        case "$role" in
            "PDC")
                echo "${priority_data[2]:-$default_priority}"
                ;;
            "RID")
                echo "${priority_data[3]:-$default_priority}"
                ;;
            "INFRASTRUCTURE")
                echo "${priority_data[4]:-$default_priority}"
                ;;
            "SCHEMA")
                echo "${priority_data[5]:-$default_priority}"
                ;;
            "DOMAIN_NAMING")
                echo "${priority_data[6]:-$default_priority}"
                ;;
            *)
                # General priority
                echo "${priority_data[1]:-$default_priority}"
                ;;
        esac
    else
        echo "$default_priority"
    fi
}

# Clean up stale DC entries (not seen in 24 hours)
cleanup_stale_dc_entries() {
    if [ ! -f "$DOMAIN_PRIORITIES_FILE" ]; then
        return
    fi

    local current_time=$(date '+%s')
    local stale_threshold=$((24 * 3600))  # 24 hours
    local temp_file="${DOMAIN_PRIORITIES_FILE}.tmp"

    # Process each line
    while IFS= read -r line; do
        if [[ $line == \#* ]] || [[ -z $line ]]; then
            echo "$line" >> "$temp_file"
            continue
        fi

        # Extract last seen time
        local last_seen=$(echo "$line" | cut -d: -f8)
        if [ -n "$last_seen" ]; then
            local last_seen_epoch
            if last_seen_epoch=$(date -d "${last_seen//_/ }" '+%s' 2>/dev/null); then
                local age=$((current_time - last_seen_epoch))
                if [ $age -lt $stale_threshold ]; then
                    echo "$line" >> "$temp_file"
                else
                    local dc_name=$(echo "$line" | cut -d: -f1)
                    log_info "Removing stale DC entry: $dc_name (last seen $((age / 3600))h ago)"
                fi
            else
                # Keep entries with invalid timestamps
                echo "$line" >> "$temp_file"
            fi
        else
            echo "$line" >> "$temp_file"
        fi
    done < "$DOMAIN_PRIORITIES_FILE"

    mv "$temp_file" "$DOMAIN_PRIORITIES_FILE"
}

# Discover other domain controllers in the domain
discover_domain_controllers() {
    log_debug "Discovering domain controllers in the domain"

    local domain_name=$(hostname -d)
    local discovered_dcs=()

    # Method 1: Query AD for domain controllers
    if command -v samba-tool >/dev/null 2>&1; then
        local dc_list
        if dc_list=$(sudo samba-tool computer list --filter="(userAccountControl:1.2.840.113556.1.4.803:=8192)" 2>/dev/null); then
            while IFS= read -r dc_line; do
                if [[ -n "$dc_line" && "$dc_line" != *"$"* ]]; then
                    local dc_name=$(echo "$dc_line" | tr '[:upper:]' '[:lower:]' | sed 's/\$$//g')
                    discovered_dcs+=("$dc_name")
                fi
            done <<< "$dc_list"
        fi
    fi

    # Method 2: DNS SRV record lookup for _ldap._tcp
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

    # Method 3: nslookup fallback
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

    log_debug "Discovered DCs: ${unique_dcs[*]}"
    printf '%s\n' "${unique_dcs[@]}"
}

# Get this DC's priority for a specific role (wrapper for backward compatibility)
get_dc_priority() {
    local role="$1"
    local this_server=$(hostname -s | tr '[:upper:]' '[:lower:]')

    get_dc_priority_from_domain "$this_server" "$role"
}

# Check if this DC should seize a specific role based on priority
should_seize_role() {
    local role="$1"
    local failed_dc="$2"

    init_dc_priority_config

    local this_server=$(hostname -s | tr '[:upper:]' '[:lower:]')
    local this_priority=$(get_dc_priority "$role")

    log_debug "Evaluating seizure for $role from $failed_dc (our priority: $this_priority)"

    # Discover other DCs
    local other_dcs
    mapfile -t other_dcs < <(discover_domain_controllers)

    # Check if any other DC has higher priority (lower number) and is reachable
    for dc in "${other_dcs[@]}"; do
        if [[ "$dc" == "$this_server" ]]; then
            continue
        fi

        log_debug "Checking DC: $dc"

        # Skip the failed DC
        if echo "$dc" | grep -qi "$failed_dc" || echo "$failed_dc" | grep -qi "$dc"; then
            log_debug "Skipping failed DC: $dc"
            continue
        fi

        # Test if this DC is reachable
        if test_dc_connectivity "$dc"; then
            # Get the other DC's priority from shared SYSVOL configuration
            local other_priority=$(get_dc_priority_from_domain "$dc" "$role")

            # Check if the other DC has higher priority
            if [ "$other_priority" -lt "$this_priority" ]; then
                log_info "DC $dc has higher priority ($other_priority vs $this_priority) for $role - deferring seizure"
                return 1
            fi
        else
            log_debug "DC $dc is not reachable"
        fi
    done

    log_info "This DC has highest priority for seizing $role role"
    return 0
}

# Acquire coordination lock for role seizure
acquire_seizure_lock() {
    local role="$1"
    local lock_file="${SEIZURE_COORDINATION_FILE}.$role.lock"
    local this_server=$(hostname -s)
    local current_time=$(date '+%s')

    # Check if lock exists and is still valid
    if [ -f "$lock_file" ]; then
        local lock_info
        if lock_info=$(cat "$lock_file" 2>/dev/null); then
            local lock_server=$(echo "$lock_info" | cut -d: -f1)
            local lock_time=$(echo "$lock_info" | cut -d: -f2)
            local lock_expiry=$((lock_time + SEIZURE_LOCK_TIMEOUT))

            if [ "$current_time" -lt "$lock_expiry" ]; then
                if [ "$lock_server" = "$this_server" ]; then
                    log_debug "We already hold the seizure lock for $role"
                    return 0
                else
                    log_debug "Another DC ($lock_server) holds seizure lock for $role"
                    return 1
                fi
            else
                log_debug "Seizure lock for $role has expired, removing"
                rm -f "$lock_file"
            fi
        fi
    fi

    # Try to acquire the lock
    echo "$this_server:$current_time" > "$lock_file.tmp"
    if mv "$lock_file.tmp" "$lock_file" 2>/dev/null; then
        log_info "Acquired seizure coordination lock for $role"
        return 0
    else
        log_debug "Failed to acquire seizure lock for $role"
        return 1
    fi
}

# Release coordination lock for role seizure
release_seizure_lock() {
    local role="$1"
    local lock_file="${SEIZURE_COORDINATION_FILE}.$role.lock"
    local this_server=$(hostname -s)

    if [ -f "$lock_file" ]; then
        local lock_info
        if lock_info=$(cat "$lock_file" 2>/dev/null); then
            local lock_server=$(echo "$lock_info" | cut -d: -f1)

            if [ "$lock_server" = "$this_server" ]; then
                rm -f "$lock_file"
                log_debug "Released seizure lock for $role"
            fi
        fi
    fi
}

# Record seizure attempt
record_seizure_attempt() {
    local role="$1"
    local result="$2"
    local timestamp=$(date '+%s')

    # Update last attempt time
    sed -i "s/^LAST_SEIZURE_ATTEMPT=.*/LAST_SEIZURE_ATTEMPT=$timestamp/" "$AUTO_SEIZE_CONFIG"

    # Log to seizure history
    local history_file="${FSMO_CONFIG_DIR}/seizure-history.log"
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$(hostname)] SEIZURE_ATTEMPT role=$role result=$result" >> "$history_file"

    log_info "Recorded seizure attempt: $role -> $result"
}

# Check if we're in seizure cooldown period
in_seizure_cooldown() {
    local current_time=$(date '+%s')
    local last_attempt=${LAST_SEIZURE_ATTEMPT:-0}
    local cooldown_end=$((last_attempt + SEIZURE_COOLDOWN))

    [ $current_time -lt $cooldown_end ]
}

# Seize FSMO roles from unreachable DCs
auto_seize_fsmo_roles() {
    log_info "Starting auto-seizure evaluation"

    # Initialize auto-seizure configuration
    init_auto_seize_config

    # Check if auto-seizure is enabled
    if ! is_auto_seize_enabled; then
        log_debug "Auto-seizure is disabled"
        return 0
    fi

    # Check cooldown period
    if in_seizure_cooldown; then
        log_debug "In seizure cooldown period - skipping"
        return 0
    fi

    # Query current FSMO role assignments
    local fsmo_info
    fsmo_info=$(query_fsmo_roles)

    if [ $? -ne 0 ]; then
        log_error "Failed to query FSMO roles for auto-seizure"
        return 1
    fi

    # Extract role information
    eval "$fsmo_info"

    # Check each role holder for connectivity
    local roles_to_seize=()
    local auto_seize_roles_array
    IFS=',' read -ra auto_seize_roles_array <<< "${AUTO_SEIZE_ROLES:-PDC,RID,INFRASTRUCTURE}"

    for role in "${auto_seize_roles_array[@]}"; do
        role=$(echo "$role" | xargs) # trim whitespace

        local role_owner=""
        case "$role" in
            "PDC")
                role_owner="$PDC_OWNER"
                ;;
            "RID")
                role_owner="$RID_OWNER"
                ;;
            "INFRASTRUCTURE")
                role_owner="$INFRA_OWNER"
                ;;
            "SCHEMA")
                role_owner="$SCHEMA_OWNER"
                ;;
            "DOMAIN_NAMING")
                role_owner="$NAMING_OWNER"
                ;;
        esac

        if [ -n "$role_owner" ] && [ "$role_owner" != "unknown" ]; then
            # Don't seize from ourselves
            if echo "$role_owner" | grep -qi "$THIS_SERVER" || echo "$THIS_SERVER" | grep -qi "$role_owner"; then
                log_debug "We already hold $role role"
                continue
            fi

            # Test connectivity to role owner
            if ! test_dc_connectivity "$role_owner"; then
                log_info "Role holder $role_owner for $role is unreachable"

                # Check if we should seize this role (priority-based)
                if should_seize_role "$role" "$role_owner"; then
                    # Try to acquire coordination lock
                    if acquire_seizure_lock "$role"; then
                        roles_to_seize+=("$role:$role_owner")
                    else
                        log_info "Another DC is already handling seizure of $role role"
                    fi
                else
                    log_info "Another DC has higher priority for seizing $role role"
                fi
            else
                log_debug "Role holder $role_owner for $role is reachable"
            fi
        fi
    done

    # Seize unreachable roles
    if [ ${#roles_to_seize[@]} -gt 0 ]; then
        log_info "Seizing roles from unreachable DCs: ${roles_to_seize[*]}"

        for role_info in "${roles_to_seize[@]}"; do
            local role="${role_info%:*}"
            local owner="${role_info#*:}"

            log_info "Attempting to seize $role role from unreachable DC: $owner"

            local samba_role=""
            case "$role" in
                "PDC")
                    samba_role="pdc"
                    ;;
                "RID")
                    samba_role="rid"
                    ;;
                "INFRASTRUCTURE")
                    samba_role="infrastructure"
                    ;;
                "SCHEMA")
                    samba_role="schema"
                    ;;
                "DOMAIN_NAMING")
                    samba_role="naming"
                    ;;
            esac

            if [ -n "$samba_role" ]; then
                if sudo samba-tool fsmo seize --role="$samba_role" --force 2>/dev/null; then
                    log_info "Successfully seized $role role from $owner"
                    record_seizure_attempt "$role" "SUCCESS"

                    # Update FSMO status
                    update_fsmo_status "$role" "$(hostname -s)" "ACTIVE" "${FSMO_SERVICES[$role]}"

                    # Release coordination lock after successful seizure
                    release_seizure_lock "$role"
                else
                    log_error "Failed to seize $role role from $owner"
                    record_seizure_attempt "$role" "FAILED"

                    # Release coordination lock after failed seizure
                    release_seizure_lock "$role"
                fi
            fi
        done

        # Trigger orchestration after successful seizures
        log_info "Triggering FSMO orchestration after role seizures"
        orchestrate_fsmo_roles

        return 0
    else
        log_debug "No unreachable FSMO role holders found"
        return 0
    fi
}

# Comprehensive orchestration with auto-seizure
orchestrate_with_auto_seize() {
    log_info "Starting comprehensive FSMO orchestration with auto-seizure"

    # First, perform auto-seizure evaluation
    auto_seize_fsmo_roles

    # Then, perform normal orchestration
    orchestrate_fsmo_roles

    log_info "Comprehensive FSMO orchestration with auto-seizure completed"
}

# Show comprehensive FSMO status
show_fsmo_status() {
    log_info "Current FSMO Roles and Services Status:"
    echo "=========================================="

    # Show FSMO role assignments
    echo "FSMO Role Assignments:"
    if [ -f "$FSMO_STATUS_FILE" ]; then
        while IFS= read -r line; do
            if [[ $line == \#* ]] || [[ -z $line ]]; then
                continue
            fi
            echo "  $line"
        done < "$FSMO_STATUS_FILE"
    else
        echo "  No FSMO status file found"
    fi

    echo ""
    echo "Service Status:"
    # Show key service status
    local services=("samba-ad-dc" "chrony" "isc-dhcp-server" "bind9")
    for service in "${services[@]}"; do
        if systemctl is-active "$service" >/dev/null 2>&1; then
            echo "  $service: ACTIVE"
        else
            echo "  $service: INACTIVE"
        fi
    done

    echo ""
    echo "SYSVOL Configuration Files:"
    if [ -d "$FSMO_CONFIG_DIR" ]; then
        find "$FSMO_CONFIG_DIR" -name "*.conf" -o -name "*.sh" | while read -r file; do
            echo "  $(basename "$file"): $(stat -c %y "$file" | cut -d' ' -f1)"
        done
    else
        echo "  No FSMO configuration directory found"
    fi
}

# Show multi-DC coordination status
show_multi_dc_status() {
    log_info "Multi-DC Coordination Status:"
    echo "======================================"

    init_dc_priority_config

    local this_server=$(hostname -s | tr '[:upper:]' '[:lower:]')
    echo "This DC: $this_server"
    echo "Priorities from shared SYSVOL:"
    echo "  General: $(get_dc_priority_from_domain "$this_server" "GENERAL")"
    echo "  PDC: $(get_dc_priority_from_domain "$this_server" "PDC")"
    echo "  RID: $(get_dc_priority_from_domain "$this_server" "RID")"
    echo "  Infrastructure: $(get_dc_priority_from_domain "$this_server" "INFRASTRUCTURE")"
    echo "  Schema: $(get_dc_priority_from_domain "$this_server" "SCHEMA")"
    echo "  Domain Naming: $(get_dc_priority_from_domain "$this_server" "DOMAIN_NAMING")"
    echo ""

    echo "Discovered Domain Controllers:"
    local discovered_dcs
    mapfile -t discovered_dcs < <(discover_domain_controllers)

    for dc in "${discovered_dcs[@]}"; do
        if test_dc_connectivity "$dc"; then
            echo "  ✅ $dc (reachable)"
        else
            echo "  ❌ $dc (unreachable)"
        fi
    done

    echo ""
    echo "Active Seizure Locks:"
    local lock_files=(${SEIZURE_COORDINATION_FILE}.*.lock)
    if [ -f "${lock_files[0]}" ] 2>/dev/null; then
        for lock_file in "${lock_files[@]}"; do
            if [ -f "$lock_file" ]; then
                local role=$(basename "$lock_file" | sed 's/.*\.\(.*\)\.lock/\1/')
                local lock_info=$(cat "$lock_file" 2>/dev/null || echo "unknown:0")
                local lock_server=$(echo "$lock_info" | cut -d: -f1)
                local lock_time=$(echo "$lock_info" | cut -d: -f2)
                local lock_age=$(($(date '+%s') - lock_time))
                echo "  $role: locked by $lock_server (${lock_age}s ago)"
            fi
        done
    else
        echo "  No active seizure locks"
    fi

    echo ""
    echo "Domain-wide DC Priority Configuration:"
    if [ -f "$DOMAIN_PRIORITIES_FILE" ]; then
        echo "  Format: DC_NAME:PRIORITY:PDC:RID:INFRA:SCHEMA:NAMING:LAST_SEEN"
        while IFS= read -r line; do
            if [[ ! $line == \#* ]] && [[ -n $line ]]; then
                local dc_name=$(echo "$line" | cut -d: -f1)
                local priorities=(${line//:/ })
                local last_seen=$(echo "$line" | cut -d: -f8)
                echo "  $dc_name: General=${priorities[1]:-50}, PDC=${priorities[2]:-50}, RID=${priorities[3]:-50}, INFRA=${priorities[4]:-50}, SCHEMA=${priorities[5]:-50}, NAMING=${priorities[6]:-50} (${last_seen:-unknown})"
            fi
        done < "$DOMAIN_PRIORITIES_FILE"
    else
        echo "  No shared priority configuration found - using local configuration"
        if [ -f "$DC_PRIORITY_FILE" ]; then
            grep -E "(PDC|RID|INFRASTRUCTURE|SCHEMA|DOMAIN_NAMING)_PREFERENCE" "$DC_PRIORITY_FILE" | sed 's/^/  /'
        else
            echo "  No priority configuration found"
        fi
    fi
}

# Usage information
usage() {
    cat << EOF
Usage: $0 [OPTIONS]

FSMO Role Orchestrator - Comprehensive management of all FSMO roles and services

OPTIONS:
    -h, --help              Show this help message
    -o, --orchestrate       Orchestrate all FSMO role services with auto-seizure (default)
    --orchestrate-only      Orchestrate services without auto-seizure check
    -a, --auto-seize        Perform auto-seizure evaluation only
    -s, --status            Show comprehensive FSMO status
    -i, --init              Initialize FSMO SYSVOL structure only
    -r, --role ROLE         Configure specific FSMO role services
                           Roles: PDC, RID, INFRASTRUCTURE, SCHEMA, DOMAIN_NAMING
    -q, --query             Query current FSMO role assignments
    --multi-dc-status       Show multi-DC coordination status
    -v, --verbose           Enable verbose logging

DESCRIPTION:
    This script provides comprehensive orchestration of all FSMO roles and their
    associated services. It extends the basic domain service orchestrator with
    full FSMO role management including:

    - PDC Emulator: Time synchronization, DHCP, Password policies
    - RID Master: SID allocation, RID pool management
    - Infrastructure Master: Cross-domain references, DNS infrastructure
    - Schema Master: Forest schema management
    - Domain Naming Master: Domain operations, Forest DNS

EXAMPLES:
    $0                          # Full FSMO orchestration with auto-seizure
    $0 --orchestrate-only       # Orchestration without auto-seizure
    $0 --auto-seize            # Auto-seizure evaluation only
    $0 --status                 # Show FSMO status
    $0 --role PDC               # Configure PDC services only
    $0 --query                  # Query FSMO assignments

EOF
}

# Main execution
main() {
    local action="orchestrate"
    local specific_role=""
    local verbose=false

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
            --orchestrate-only)
                action="orchestrate-only"
                shift
                ;;
            -a|--auto-seize)
                action="auto-seize"
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
            -r|--role)
                action="role"
                specific_role="$2"
                shift 2
                ;;
            -q|--query)
                action="query"
                shift
                ;;
            --multi-dc-status)
                action="multi-dc-status"
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

    # Acquire lock for all operations except status and query
    if [[ "$action" != "status" && "$action" != "query" ]]; then
        acquire_lock
    fi

    # Execute requested action
    case $action in
        orchestrate)
            orchestrate_with_auto_seize
            ;;
        orchestrate-only)
            orchestrate_fsmo_roles
            ;;
        auto-seize)
            auto_seize_fsmo_roles
            ;;
        status)
            show_fsmo_status
            ;;
        init)
            init_fsmo_sysvol
            ;;
        role)
            if [ -z "$specific_role" ]; then
                echo "Error: --role requires a role name"
                usage
                exit 1
            fi
            init_fsmo_sysvol
            case "$specific_role" in
                "PDC")
                    configure_pdc_services
                    ;;
                "RID")
                    configure_rid_services
                    ;;
                "INFRASTRUCTURE")
                    configure_infrastructure_services
                    ;;
                "SCHEMA")
                    configure_schema_services
                    ;;
                "DOMAIN_NAMING")
                    configure_domain_naming_services
                    ;;
                *)
                    echo "Error: Unknown role '$specific_role'"
                    echo "Valid roles: PDC, RID, INFRASTRUCTURE, SCHEMA, DOMAIN_NAMING"
                    exit 1
                    ;;
            esac
            ;;
        query)
            query_fsmo_roles
            ;;
        multi-dc-status)
            show_multi_dc_status
            ;;
    esac
}

# Run main function
main "$@"