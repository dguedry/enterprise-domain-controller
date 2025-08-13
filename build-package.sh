#!/bin/bash

# Cockpit Domain Controller Package Update Script
# This script automates the process of updating the debian package with the latest files

set -e  # Exit on any error

# Show help
show_help() {
    cat << EOF
Cockpit Domain Controller Package Update Script

USAGE:
    $0 [OPTIONS]

OPTIONS:
    -h, --help          Show this help message
    -q, --quiet         Suppress output (except errors)
    -y, --yes           Automatically install the package after building
    -n, --no-install    Don't offer to install the package
    -s, --services-only Install/update FSMO orchestration services only
    --production-ready  Apply production hardening and operational setup
    --install-deps      Install all required dependencies first

DESCRIPTION:
    This script automates the process of updating the debian package with the latest
    files from the cockpit domain controller development directory.

    The script will:
    1. Copy the latest files from cockpit-domain-controller/
    2. Update the package version based on manifest.json
    3. Build a new .deb package
    4. Optionally install the package

EXAMPLES:
    $0                           # Interactive mode
    $0 -y                        # Auto-install after building
    $0 -q -n                     # Quiet mode, no install prompt
    $0 -s                        # Install/update FSMO services only
    $0 -y --production-ready     # Auto-install with production hardening
    $0 --install-deps -y         # Install dependencies first, then auto-install package

EOF
}

# Parse command line arguments
QUIET=false
AUTO_INSTALL=false
NO_INSTALL=false
SERVICES_ONLY=false
PRODUCTION_READY=false
INSTALL_DEPS=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_help
            exit 0
            ;;
        -q|--quiet)
            QUIET=true
            shift
            ;;
        -y|--yes)
            AUTO_INSTALL=true
            shift
            ;;
        -n|--no-install)
            NO_INSTALL=true
            shift
            ;;
        -s|--services-only)
            SERVICES_ONLY=true
            shift
            ;;
        --production-ready)
            PRODUCTION_READY=true
            shift
            ;;
        --install-deps)
            INSTALL_DEPS=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print colored output
print_status() {
    if [ "$QUIET" = false ]; then
        echo -e "${BLUE}[INFO]${NC} $1"
    fi
}

print_success() {
    if [ "$QUIET" = false ]; then
        echo -e "${GREEN}[SUCCESS]${NC} $1"
    fi
}

print_warning() {
    if [ "$QUIET" = false ]; then
        echo -e "${YELLOW}[WARNING]${NC} $1"
    fi
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Remove conflicting time-daemon services
remove_conflicting_time_services() {
    print_status "Checking for conflicting time-daemon services..."
    
    local conflicts_found=false
    local services_to_remove=()
    
    # Check for systemd-timesyncd (conflicts with chrony)
    # Check both installed (ii) and removed-but-configured (rc) states
    if dpkg -l | grep -q "^[ir][ic].*systemd-timesyncd"; then
        local status=$(dpkg -l | grep "systemd-timesyncd" | awk '{print $1}')
        print_status "Found conflicting service: systemd-timesyncd (status: $status)"
        services_to_remove+=("systemd-timesyncd")
        conflicts_found=true
    fi
    
    # Check for ntp (also conflicts with chrony)
    if dpkg -l | grep -q "^ii.*ntp[[:space:]]"; then
        print_status "Found conflicting service: ntp"
        services_to_remove+=("ntp")
        conflicts_found=true
    fi
    
    # Check for openntpd (also conflicts with chrony)
    if dpkg -l | grep -q "^ii.*openntpd"; then
        print_status "Found conflicting service: openntpd"
        services_to_remove+=("openntpd")
        conflicts_found=true
    fi
    
    if [ "$conflicts_found" = true ]; then
        print_status "Removing conflicting time-daemon services before chrony installation..."
        
        for service in "${services_to_remove[@]}"; do
            print_status "Removing $service..."
            
            # Stop service if running
            if systemctl is-active --quiet "$service" 2>/dev/null; then
                print_status "Stopping $service service..."
                sudo systemctl stop "$service" 2>/dev/null || true
            fi
            
            # Disable service if enabled
            if systemctl is-enabled --quiet "$service" 2>/dev/null; then
                print_status "Disabling $service service..."
                sudo systemctl disable "$service" 2>/dev/null || true
            fi
            
            # Purge package completely (remove + config files)
            if sudo apt-get purge -y "$service" >/dev/null 2>&1; then
                print_success "Successfully purged $service"
            else
                print_warning "Failed to purge $service - continuing anyway"
            fi
        done
        
        # Update package database after removals
        print_status "Updating package database..."
        sudo apt-get update >/dev/null 2>&1 || true
        
        print_success "Conflicting time services removed successfully"
    else
        print_status "No conflicting time services found"
    fi
}

# Configure DNS for Samba AD-DC
configure_samba_dns() {
    print_status "Configuring DNS for Samba AD-DC..."
    
    # Check if Samba AD-DC is running
    if ! systemctl is-active --quiet samba-ad-dc; then
        print_warning "Samba AD-DC is not running - DNS configuration skipped"
        return 0
    fi
    
    # Detect domain name
    local domain_name
    domain_name=$(find /var/lib/samba/sysvol/ -maxdepth 1 -type d -name "*.local" 2>/dev/null | head -1 | xargs basename 2>/dev/null || echo "")
    
    if [[ -z "$domain_name" ]]; then
        domain_name=$(hostname -d 2>/dev/null || echo "")
    fi
    
    if [[ -z "$domain_name" ]]; then
        print_warning "Could not detect domain name - DNS configuration skipped"
        return 0
    fi
    
    # Get the primary network interface
    local primary_interface
    primary_interface=$(ip route | grep default | head -1 | awk '{print $5}')
    
    if [[ -z "$primary_interface" ]]; then
        print_warning "Could not detect primary network interface - DNS configuration skipped"
        return 0
    fi
    
    print_status "Detected domain: $domain_name"
    print_status "Primary interface: $primary_interface"
    
    # Configure systemd-resolved for Samba AD-DC
    # This sets up DNS forwarding: internal domain queries go to Samba (127.0.0.1), external queries go to public DNS
    if command -v resolvectl >/dev/null 2>&1; then
        print_status "Configuring systemd-resolved for Samba AD-DC..."
        
        # Set DNS servers: Samba first (127.0.0.1), then public DNS (8.8.8.8, 8.8.4.4)
        if sudo resolvectl dns "$primary_interface" 127.0.0.1 8.8.8.8 8.8.4.4; then
            print_status "DNS servers configured: 127.0.0.1 (Samba), 8.8.8.8, 8.8.4.4"
        else
            print_warning "Failed to configure DNS servers"
        fi
        
        # Configure domain routing - internal domain queries go to Samba
        if sudo resolvectl domain "$primary_interface" "$domain_name" "~$domain_name"; then
            print_status "Domain routing configured for: $domain_name"
        else
            print_warning "Failed to configure domain routing"
        fi
        
        # Verify configuration
        print_status "DNS Configuration:"
        resolvectl status "$primary_interface" | grep -E "(DNS Servers|DNS Domain)" || true
        
    else
        print_warning "resolvectl not found - manual DNS configuration required"
        print_status "Manual DNS configuration steps:"
        print_status "  1. Edit /etc/systemd/resolved.conf to add:"
        print_status "     DNS=127.0.0.1 8.8.8.8 8.8.4.4"
        print_status "     Domains=~$domain_name"
        print_status "  2. Restart systemd-resolved: sudo systemctl restart systemd-resolved"
    fi
    
    # Add DNS forwarders to Samba configuration if not already present
    local smb_conf="/etc/samba/smb.conf"
    if [[ -f "$smb_conf" ]]; then
        if ! grep -q "dns forwarder" "$smb_conf"; then
            print_status "Adding DNS forwarders to Samba configuration..."
            if sudo sed -i '/^\[global\]/,/^\[/ { /^[[:space:]]*workgroup[[:space:]]*=/a\
\tdns forwarder = 8.8.8.8 8.8.4.4
}' "$smb_conf"; then
                print_status "DNS forwarders added to smb.conf"
                
                # Restart Samba to apply changes
                print_status "Restarting Samba AD-DC to apply DNS configuration..."
                if sudo systemctl restart samba-ad-dc; then
                    print_status "Samba AD-DC restarted successfully"
                    sleep 3  # Give Samba time to start up
                else
                    print_warning "Failed to restart Samba AD-DC"
                fi
            else
                print_warning "Failed to add DNS forwarders to smb.conf"
            fi
        else
            print_status "DNS forwarders already configured in smb.conf"
        fi
    else
        print_warning "Samba configuration file not found at $smb_conf"
    fi
    
    # Test DNS resolution
    print_status "Testing DNS resolution..."
    if nslookup google.com >/dev/null 2>&1; then
        print_success "External DNS resolution: OK"
    else
        print_warning "External DNS resolution: FAILED"
    fi
    
    if nslookup "$domain_name" >/dev/null 2>&1; then
        print_success "Internal domain resolution: OK"
    else
        print_warning "Internal domain resolution: FAILED (may take time to propagate)"
    fi
    
    print_success "DNS configuration completed!"
    
    # Generate domain-integrated DHCP configuration
    generate_domain_dhcp_config "$domain_name" "$primary_interface"
}

# Generate domain-integrated DHCP configuration
generate_domain_dhcp_config() {
    local domain_name="$1"
    local interface="$2"
    
    print_status "Generating domain-integrated DHCP configuration..."
    
    # Get network information
    local dc_ip=$(ip addr show "$interface" | grep "inet " | head -1 | awk '{print $2}' | cut -d'/' -f1)
    local network_base=$(echo "$dc_ip" | cut -d'.' -f1-3)
    local gateway=$(ip route | grep default | head -1 | awk '{print $3}')
    local mac_address=$(ip link show "$interface" | grep ether | awk '{print $2}')
    local hostname=$(hostname -f)
    local dc_name=$(hostname -s)
    
    if [[ -z "$dc_ip" || -z "$gateway" ]]; then
        print_warning "Could not detect network configuration - DHCP configuration skipped"
        return 0
    fi
    
    print_status "Network detected: ${network_base}.0/24, Gateway: $gateway, DC: $dc_ip"
    
    # Create domain-integrated DHCP configuration
    local dhcp_config_dir="/var/lib/samba/sysvol/$domain_name/dhcp-configs"
    local dhcp_config="$dhcp_config_dir/dhcpd.conf.active"
    
    # Ensure DHCP configs directory exists
    if [[ ! -d "$dhcp_config_dir" ]]; then
        if sudo mkdir -p "$dhcp_config_dir"; then
            print_status "Created DHCP configs directory in SYSVOL"
        else
            print_warning "Could not create DHCP configs directory"
            return 0
        fi
    fi
    
    # Generate DHCP configuration
    local temp_config="/tmp/dhcpd.conf.domain-integrated"
    cat > "$temp_config" << EOF
# Domain-Integrated DHCP Configuration for $domain_name
# Auto-generated based on domain controller properties
# This configuration is replicated via SYSVOL across all domain controllers

# Basic DHCP settings
default-lease-time 3600;
max-lease-time 86400;
ddns-update-style none;
authoritative;

# Domain-specific options
option domain-name "$domain_name";
option domain-name-servers $dc_ip, 8.8.8.8, 8.8.4.4;

# Network subnet configuration (auto-detected from DC network interface)
subnet ${network_base}.0 netmask 255.255.255.0 {
    # DHCP pool range (avoiding DC static IPs and common static ranges)
    range ${network_base}.100 ${network_base}.200;
    
    # Network settings
    option routers $gateway;
    option broadcast-address ${network_base}.255;
    
    # Domain controller as primary DNS
    option domain-name-servers $dc_ip, 8.8.8.8;
    option domain-name "$domain_name";
    
    # NTP server (this DC)
    option ntp-servers $dc_ip;
    
    # NetBIOS settings for Windows clients
    option netbios-name-servers $dc_ip;
    option netbios-node-type 8;
}

# Host reservations for domain controllers (replicated via SYSVOL)
host ${dc_name}-$(echo $domain_name | sed 's/\./-/g') {
    hardware ethernet $mac_address;
    fixed-address $dc_ip;
    option host-name "$hostname";
}

# Log configuration
log-facility local7;

# Configuration metadata
# Generated: $(date)
# Domain: $domain_name
# Primary DC: $hostname ($dc_ip)
# Network: ${network_base}.0/24
# Gateway: $gateway
# Interface: $interface ($mac_address)
EOF
    
    # Deploy configuration
    if sudo cp "$temp_config" "$dhcp_config"; then
        print_status "DHCP configuration stored in SYSVOL: $dhcp_config"
    else
        print_warning "Could not store DHCP configuration in SYSVOL"
    fi
    
    # Deploy to local DHCP server
    if sudo cp "$temp_config" /etc/dhcp/dhcpd.conf; then
        print_status "DHCP configuration deployed to local server"
        
        # Test configuration
        if sudo dhcpd -t -cf /etc/dhcp/dhcpd.conf >/dev/null 2>&1; then
            print_status "DHCP configuration syntax validated"
            
            # Restart DHCP service
            if sudo systemctl restart isc-dhcp-server >/dev/null 2>&1; then
                print_success "DHCP service restarted with domain-integrated configuration"
            else
                print_warning "DHCP service restart failed - may need manual configuration"
            fi
        else
            print_warning "DHCP configuration has syntax errors"
        fi
    else
        print_warning "Could not deploy DHCP configuration to local server"
    fi
    
    # Clean up
    rm -f "$temp_config"
    
    print_success "Domain-integrated DHCP configuration completed!"
}

# Install all required dependencies
install_dependencies() {
    print_status "Installing domain controller dependencies..."
    
    # Remove conflicting time services first
    remove_conflicting_time_services
    
    # Update package database
    print_status "Updating package database..."
    sudo apt-get update
    
    # Install core Cockpit packages
    print_status "Installing Cockpit packages..."
    sudo apt-get install -y \
        cockpit \
        cockpit-ws \
        cockpit-system \
        cockpit-networkmanager \
        cockpit-packagekit \
        cockpit-storaged >/dev/null 2>&1 || {
            print_warning "Some optional Cockpit packages failed to install"
            # Install just the essential ones
            sudo apt-get install -y cockpit cockpit-ws cockpit-system
        }
    
    # Install Samba Active Directory packages
    print_status "Installing Samba AD packages..."
    sudo apt-get install -y \
        samba \
        samba-dsdb-modules \
        samba-vfs-modules \
        winbind \
        libpam-winbind \
        libnss-winbind \
        python3-samba
    
    # Install Kerberos packages
    print_status "Installing Kerberos packages..."
    sudo apt-get install -y \
        krb5-user \
        krb5-config
    
    # Install network and system utilities
    print_status "Installing system utilities..."
    sudo apt-get install -y \
        dnsutils \
        net-tools \
        acl \
        attr
    
    # Install chrony (after removing conflicts)
    print_status "Installing chrony for time synchronization..."
    sudo apt-get install -y chrony
    
    # Install DHCP server
    print_status "Installing DHCP server..."
    sudo apt-get install -y isc-dhcp-server
    
    # Install firewall
    print_status "Installing firewall..."
    sudo apt-get install -y ufw
    
    # Install optional but recommended packages
    print_status "Installing recommended packages..."
    sudo apt-get install -y \
        rsync \
        wget \
        curl \
        vim \
        htop \
        tree \
        lsof >/dev/null 2>&1 || {
            print_warning "Some optional packages failed to install"
        }
    
    # Enable essential services
    print_status "Enabling essential services..."
    
    # Enable Cockpit
    sudo systemctl enable --now cockpit.socket
    print_status "Cockpit enabled and started"
    
    # Enable chrony
    sudo systemctl enable chrony
    print_status "Chrony enabled"
    
    print_success "All dependencies installed successfully!"
}

# Production hardening and operational setup
setup_production_environment() {
    print_status "Setting up production environment..."
    
    # Set up log rotation
    setup_log_rotation
    
    # Configure SSL certificates
    setup_ssl_certificates
    
    # Apply security hardening
    apply_security_hardening
    
    # Set up backup directory structure
    setup_backup_structure
    
    # Configure service monitoring
    setup_service_monitoring
    
    # Validate DNS resolution
    validate_dns_resolution
    
    # Run comprehensive tests
    run_production_tests
    
    print_success "Production environment setup completed!"
}

# Configure log rotation for all services
setup_log_rotation() {
    print_status "Configuring log rotation..."
    
    # Create logrotate config for Samba AD-DC
    sudo tee /etc/logrotate.d/samba-ad-dc > /dev/null << 'EOF'
/var/log/samba/*.log {
    weekly
    missingok
    rotate 52
    compress
    delaycompress
    notifempty
    create 644 root root
    postrotate
        systemctl reload samba-ad-dc >/dev/null 2>&1 || true
    endscript
}
EOF
    
    # Create logrotate config for FSMO services
    sudo tee /etc/logrotate.d/fsmo-services > /dev/null << 'EOF'
/var/log/fsmo-*.log {
    weekly
    missingok
    rotate 26
    compress
    delaycompress
    notifempty
    create 644 root root
}
EOF
    
    # Create logrotate config for DHCP
    sudo tee /etc/logrotate.d/isc-dhcp-server > /dev/null << 'EOF'
/var/log/dhcp.log {
    weekly
    missingok
    rotate 52
    compress
    delaycompress
    notifempty
    create 644 dhcpd dhcpd
    postrotate
        systemctl reload isc-dhcp-server >/dev/null 2>&1 || true
    endscript
}
EOF
    
    print_success "Log rotation configured"
}

# Set up SSL certificates for Cockpit
setup_ssl_certificates() {
    print_status "Setting up SSL certificates for Cockpit..."
    
    local cert_dir="/etc/cockpit/ws-certs.d"
    local hostname=$(hostname -f)
    
    # Create certificate directory if it doesn't exist
    sudo mkdir -p "$cert_dir"
    
    # Check if custom certificates exist
    if [[ -f "$cert_dir/server.crt" && -f "$cert_dir/server.key" ]]; then
        print_status "Custom SSL certificates already installed"
        return 0
    fi
    
    # Generate self-signed certificate for development/testing
    print_status "Generating self-signed SSL certificate for development..."
    sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "$cert_dir/server.key" \
        -out "$cert_dir/server.crt" \
        -subj "/C=US/ST=State/L=City/O=Organization/CN=$hostname" \
        >/dev/null 2>&1
    
    if [[ $? -eq 0 ]]; then
        sudo chmod 600 "$cert_dir/server.key"
        sudo chmod 644 "$cert_dir/server.crt"
        print_success "Self-signed SSL certificate created"
        print_warning "For production, replace with CA-signed certificates in $cert_dir"
    else
        print_warning "SSL certificate generation failed"
    fi
}

# Apply security hardening measures
apply_security_hardening() {
    print_status "Applying security hardening..."
    
    # Set proper permissions on sensitive directories
    sudo chmod 750 /var/lib/samba/private 2>/dev/null || true
    sudo chmod 755 /var/lib/samba/sysvol 2>/dev/null || true
    sudo chmod -R 644 /var/lib/samba/sysvol/*/*.conf 2>/dev/null || true
    
    # Configure systemd security for custom services
    local systemd_dir="/etc/systemd/system"
    
    # Add security hardening to FSMO orchestrator service
    if [[ -f "$systemd_dir/fsmo-orchestrator.service" ]]; then
        if ! grep -q "NoNewPrivileges=yes" "$systemd_dir/fsmo-orchestrator.service"; then
            sudo sed -i '/\[Service\]/a NoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes' \
                "$systemd_dir/fsmo-orchestrator.service"
            print_status "Security hardening applied to FSMO orchestrator service"
        fi
    fi
    
    # Configure fail2ban for SSH if available
    if command -v fail2ban-server >/dev/null 2>&1; then
        sudo systemctl enable fail2ban >/dev/null 2>&1 || true
        sudo systemctl start fail2ban >/dev/null 2>&1 || true
        print_status "Fail2ban enabled for SSH protection"
    fi
    
    # Set up audit logging if available
    if command -v auditd >/dev/null 2>&1; then
        sudo systemctl enable auditd >/dev/null 2>&1 || true
        print_status "Audit logging enabled"
    fi
    
    print_success "Security hardening applied"
}

# Set up backup directory structure
setup_backup_structure() {
    print_status "Setting up backup directory structure..."
    
    local backup_base="/var/backups/domain-controller"
    
    # Create backup directories
    sudo mkdir -p "$backup_base"/{ad-database,sysvol,dhcp-configs,certificates,logs}
    
    # Set proper permissions
    sudo chmod 750 "$backup_base"
    sudo chown root:backup "$backup_base" 2>/dev/null || sudo chown root:root "$backup_base"
    
    # Create backup script template
    sudo tee "$backup_base/backup-template.sh" > /dev/null << 'EOF'
#!/bin/bash
# Domain Controller Backup Script Template
# Customize this script for your backup requirements

BACKUP_BASE="/var/backups/domain-controller"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Backup Samba AD database
echo "Backing up AD database..."
samba-tool domain backup offline --targetdir="$BACKUP_BASE/ad-database/$TIMESTAMP" >/dev/null 2>&1

# Backup SYSVOL
echo "Backing up SYSVOL..."
rsync -av /var/lib/samba/sysvol/ "$BACKUP_BASE/sysvol/$TIMESTAMP/" >/dev/null 2>&1

# Backup DHCP configurations  
echo "Backing up DHCP configs..."
cp -r /etc/dhcp "$BACKUP_BASE/dhcp-configs/$TIMESTAMP/" 2>/dev/null

# Backup SSL certificates
echo "Backing up certificates..."
cp -r /etc/cockpit/ws-certs.d "$BACKUP_BASE/certificates/$TIMESTAMP/" 2>/dev/null

echo "Backup completed: $TIMESTAMP"
EOF
    
    sudo chmod +x "$backup_base/backup-template.sh"
    
    print_success "Backup directory structure created at $backup_base"
    print_warning "Customize $backup_base/backup-template.sh for your backup needs"
}

# Set up service monitoring
setup_service_monitoring() {
    print_status "Setting up service monitoring..."
    
    # Create monitoring script
    local monitor_script="/usr/local/bin/domain-controller-monitor.sh"
    
    sudo tee "$monitor_script" > /dev/null << 'EOF'
#!/bin/bash
# Domain Controller Service Monitor

SERVICES=("samba-ad-dc" "cockpit.socket" "chrony" "isc-dhcp-server")
LOG_FILE="/var/log/dc-monitor.log"

log_message() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" >> "$LOG_FILE"
}

for service in "${SERVICES[@]}"; do
    if systemctl is-active --quiet "$service"; then
        log_message "✓ $service is running"
    else
        log_message "✗ $service is not running - attempting restart"
        systemctl restart "$service" >/dev/null 2>&1
        if systemctl is-active --quiet "$service"; then
            log_message "✓ $service restarted successfully"
        else
            log_message "✗ $service restart failed"
        fi
    fi
done

# Check FSMO orchestration
if systemctl is-active --quiet fsmo-orchestration.target; then
    log_message "✓ FSMO orchestration is active"
else
    log_message "✗ FSMO orchestration is not active"
fi
EOF
    
    sudo chmod +x "$monitor_script"
    
    # Create systemd timer for monitoring
    sudo tee /etc/systemd/system/dc-monitor.service > /dev/null << EOF
[Unit]
Description=Domain Controller Service Monitor
After=multi-user.target

[Service]
Type=oneshot
ExecStart=$monitor_script
User=root
EOF
    
    sudo tee /etc/systemd/system/dc-monitor.timer > /dev/null << 'EOF'
[Unit]
Description=Domain Controller Service Monitor Timer
Requires=dc-monitor.service

[Timer]
OnCalendar=*:0/10
Persistent=true

[Install]
WantedBy=timers.target
EOF
    
    # Enable monitoring
    sudo systemctl daemon-reload
    sudo systemctl enable dc-monitor.timer >/dev/null 2>&1 || true
    sudo systemctl start dc-monitor.timer >/dev/null 2>&1 || true
    
    print_success "Service monitoring configured (runs every 10 minutes)"
}

# Validate DNS resolution
validate_dns_resolution() {
    print_status "Validating DNS resolution..."
    
    local domain_name=$(hostname -d 2>/dev/null || echo "")
    local validation_passed=true
    
    # Test external DNS resolution
    if nslookup google.com >/dev/null 2>&1; then
        print_status "✓ External DNS resolution: OK"
    else
        print_warning "✗ External DNS resolution: FAILED"
        validation_passed=false
    fi
    
    # Test internal domain resolution
    if [[ -n "$domain_name" ]]; then
        if nslookup "$domain_name" >/dev/null 2>&1; then
            print_status "✓ Internal domain resolution ($domain_name): OK"
        else
            print_warning "✗ Internal domain resolution ($domain_name): FAILED"
            validation_passed=false
        fi
    fi
    
    # Test DC discovery
    if dig +short _ldap._tcp."$domain_name" SRV >/dev/null 2>&1; then
        print_status "✓ DC SRV record discovery: OK"
    else
        print_warning "✗ DC SRV record discovery: FAILED"
    fi
    
    if $validation_passed; then
        print_success "DNS resolution validation passed"
    else
        print_warning "DNS resolution has issues - check configuration"
    fi
}

# Run comprehensive production tests
run_production_tests() {
    print_status "Running comprehensive production tests..."
    
    local test_script="$SOURCE_DIR/tests/run-all-tests.sh"
    
    if [[ -x "$test_script" ]]; then
        print_status "Executing production test suite..."
        
        # Run critical tests
        if "$test_script" --suite network >/dev/null 2>&1; then
            print_status "✓ Network connectivity tests: PASSED"
        else
            print_warning "✗ Network connectivity tests: FAILED"
        fi
        
        if "$test_script" --suite fsmo >/dev/null 2>&1; then
            print_status "✓ FSMO role tests: PASSED"
        else
            print_warning "✗ FSMO role tests: FAILED"
        fi
        
        print_success "Production test suite completed"
    else
        print_warning "Test suite not found - skipping automated testing"
    fi
}

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/cockpit-domain-controller"
COCKPIT_DIR="$SCRIPT_DIR/cockpit-domain-controller"
PACKAGE_DIR="$SCRIPT_DIR/debian-package"

# Handle services-only installation
if [ "$SERVICES_ONLY" = true ]; then
    print_status "Installing/updating FSMO orchestration services only..."
    
    # Check if source directory exists
    if [ ! -d "$SOURCE_DIR" ]; then
        print_error "Source directory not found: $SOURCE_DIR"
        exit 1
    fi
    
    # Install FSMO orchestration services
    if [ -f "$SOURCE_DIR/install-fsmo-orchestrator.sh" ]; then
        print_status "Running FSMO orchestrator installation..."
        if sudo "$SOURCE_DIR/install-fsmo-orchestrator.sh"; then
            print_success "FSMO orchestration services installed successfully!"
        else
            print_error "FSMO orchestrator installation failed"
            exit 1
        fi
        
        # Run migration if old services exist
        if systemctl list-units --all | grep -q "dhcp-fsmo-monitor\|ntp-fsmo-monitor"; then
            print_status "Detected old FSMO services - running migration..."
            if [ -f "$SOURCE_DIR/migrate-to-orchestrators.sh" ]; then
                if sudo "$SOURCE_DIR/migrate-to-orchestrators.sh"; then
                    print_success "Migration to new orchestration system completed!"
                else
                    print_warning "Migration had issues - check logs"
                fi
            fi
        fi
        
        # Remove conflicting time services before DNS configuration
        remove_conflicting_time_services
        
        # Configure DNS for Samba AD-DC
        configure_samba_dns
        
        # Apply production hardening if requested
        if [ "$PRODUCTION_READY" = true ]; then
            setup_production_environment
        fi
        
        print_success "FSMO orchestration services update completed!"
        print_status ""
        print_status "Service Status:"
        print_status "  • Check status: sudo systemctl status fsmo-orchestration.target"
        print_status "  • View FSMO roles: sudo fsmo-orchestrator.sh --status"
        print_status "  • Multi-DC status: sudo fsmo-orchestrator.sh --multi-dc-status"
        print_status "  • Monitor logs: sudo journalctl -u fsmo-orchestrator.service -f"
        print_status ""
        print_status "Multi-DC Coordination:"
        print_status "  • SYSVOL-based priority system for 3+ domain controllers"
        print_status "  • Automatic coordination to prevent FSMO role conflicts"
        print_status ""
        
        if [ "$PRODUCTION_READY" = true ]; then
            print_status "Production Environment:"
            print_status "  • SSL certificates: /etc/cockpit/ws-certs.d/ (replace for production)"
            print_status "  • Log rotation: Configured for all services"
            print_status "  • Service monitoring: Every 10 minutes via systemd timer"
            print_status "  • Backup structure: /var/backups/domain-controller/"
            print_status "  • Security hardening: SystemD security features enabled"
            print_status "  • Monitor logs: tail -f /var/log/dc-monitor.log"
            print_status ""
        fi
        
        exit 0
    else
        print_error "FSMO orchestrator installer not found: $SOURCE_DIR/install-fsmo-orchestrator.sh"
        exit 1
    fi
fi

print_status "Starting Cockpit Domain Controller package update..."

# Check if source directory exists
if [ ! -d "$SOURCE_DIR" ]; then
    print_error "Source directory not found: $SOURCE_DIR"
    exit 1
fi

# Check if manifest.json exists to get version
if [ ! -f "$SOURCE_DIR/manifest.json" ]; then
    print_error "manifest.json not found in source directory"
    exit 1
fi

# Auto-increment build number in manifest.json
MANIFEST_FILE="$SOURCE_DIR/manifest.json"
if [ -f "$MANIFEST_FILE" ]; then
    print_status "Auto-incrementing build number in manifest.json..."

    # Read current version
    VERSION=$(grep '"version"' "$MANIFEST_FILE" | sed 's/.*"version": "\([^"]*\)".*/\1/')

    # Increment the patch version number
    NEW_VERSION=$(echo "$VERSION" | awk -F. -v OFS=. '{$NF = $NF + 1;} 1')

    # Update the manifest.json file
    sed -i "s/\"version\": \"$VERSION\"/\"version\": \"$NEW_VERSION\"/" "$MANIFEST_FILE"

    print_success "Version incremented from $VERSION to $NEW_VERSION"
else
    print_warning "manifest.json not found, skipping version increment."
fi

# Get current version from manifest.json
CURRENT_VERSION=$(grep '"version"' "$SOURCE_DIR/manifest.json" | sed 's/.*"version": "\([^"]*\)".*/\1/')
if [ -z "$CURRENT_VERSION" ]; then
    print_error "Could not extract version from manifest.json"
    exit 1
fi

print_status "Current version: $CURRENT_VERSION"

# Source directory is already the working directory (no copy needed)
print_status "Using source files from: $SOURCE_DIR"

# Check if we need to update package directory
PACKAGE_NAME="cockpit-domain-controller_${CURRENT_VERSION}-1"

# Use the unversioned package directory as template or find the latest versioned one
TEMPLATE_PACKAGE="$PACKAGE_DIR/cockpit-domain-controller"
if [ ! -d "$TEMPLATE_PACKAGE" ]; then
    # Find the most recent versioned package directory
    TEMPLATE_PACKAGE=""
    for dir in "$PACKAGE_DIR"/cockpit-domain-controller_*; do
        if [ -d "$dir" ] && [[ "$dir" != *".deb" ]]; then
            TEMPLATE_PACKAGE="$dir"
        fi
    done
    
    if [ -z "$TEMPLATE_PACKAGE" ] || [ ! -d "$TEMPLATE_PACKAGE" ]; then
        print_error "No template package directory found"
        exit 1
    fi
fi

# Create or update the versioned package directory
if [ -d "$PACKAGE_DIR/$PACKAGE_NAME" ]; then
    print_status "Removing existing package directory: $PACKAGE_NAME"
    rm -rf "$PACKAGE_DIR/$PACKAGE_NAME"
fi

print_status "Creating package directory from template: $(basename "$TEMPLATE_PACKAGE")"
cp -r "$TEMPLATE_PACKAGE" "$PACKAGE_DIR/$PACKAGE_NAME"

# Update the package files
PACKAGE_PATH="$PACKAGE_DIR/$PACKAGE_NAME"
print_status "Updating package files in $PACKAGE_PATH"

# Copy files to package directory
cp -r "$SOURCE_DIR"/* "$PACKAGE_PATH/usr/share/cockpit/domain-controller/"

# Ensure test scripts are executable
print_status "Setting executable permissions on test scripts..."
find "$PACKAGE_PATH/usr/share/cockpit/domain-controller/tests" -name "*.sh" -type f -exec chmod +x {} \; 2>/dev/null || true

print_success "Package files updated (including comprehensive test suite)"

# Update control file with new version
CONTROL_FILE="$PACKAGE_PATH/DEBIAN/control"
print_status "Updating control file version..."
sed -i "s/^Version: .*/Version: ${CURRENT_VERSION}-1/" "$CONTROL_FILE"
print_success "Control file updated"

# Navigate to package directory
cd "$PACKAGE_DIR"

# Remove old .deb file with same version
print_status "Removing old .deb files for version ${CURRENT_VERSION}..."
rm -f "cockpit-domain-controller_${CURRENT_VERSION}-1.deb"

# Build the new package
print_status "Building debian package..."
dpkg-deb --build "$PACKAGE_NAME"

if [ $? -eq 0 ]; then
    print_success "Package built successfully: ${PACKAGE_NAME}.deb"
    
    # Show package info
    print_status "Package information:"
    dpkg-deb --info "${PACKAGE_NAME}.deb" | grep -E "(Package|Version|Architecture|Description)"
    
    # Show file size
    PACKAGE_SIZE=$(du -h "${PACKAGE_NAME}.deb" | cut -f1)
    print_status "Package size: $PACKAGE_SIZE"
    
    # Show installation command
    print_status "To install the package, run:"
    echo "sudo dpkg -i $PACKAGE_DIR/${PACKAGE_NAME}.deb"
    
    # Handle installation
    if [ "$NO_INSTALL" = false ]; then
        if [ "$AUTO_INSTALL" = true ]; then
            INSTALL_REPLY="y"
        else
            read -p "Do you want to install the package now? (y/N): " -n 1 -r
            echo
            INSTALL_REPLY=$REPLY
        fi
        
        if [[ $INSTALL_REPLY =~ ^[Yy]$ ]]; then
            print_status "Installing package..."
            
            # Install dependencies if requested
            if [ "$INSTALL_DEPS" = true ]; then
                install_dependencies
            else
                # Just remove conflicting time services before package installation
                remove_conflicting_time_services
            fi
            
            if sudo dpkg -i "$PACKAGE_DIR/${PACKAGE_NAME}.deb"; then
                print_success "Package installed successfully!"
                
                # Install FSMO orchestration services
                print_status "Installing FSMO orchestration services..."
                if [ -f "$SOURCE_DIR/install-fsmo-orchestrator.sh" ]; then
                    print_status "Running FSMO orchestrator installation..."
                    if sudo "$SOURCE_DIR/install-fsmo-orchestrator.sh"; then
                        print_success "FSMO orchestration services installed successfully!"
                    else
                        print_warning "FSMO orchestrator installation had issues - check logs"
                    fi
                    
                    # Run migration if old services exist
                    if systemctl list-units --all | grep -q "dhcp-fsmo-monitor\|ntp-fsmo-monitor"; then
                        print_status "Detected old FSMO services - running migration..."
                        if [ -f "$SOURCE_DIR/migrate-to-orchestrators.sh" ]; then
                            if sudo "$SOURCE_DIR/migrate-to-orchestrators.sh"; then
                                print_success "Migration to new orchestration system completed!"
                            else
                                print_warning "Migration had issues - old services may still be active"
                            fi
                        fi
                    fi
                else
                    print_warning "FSMO orchestrator installer not found - services not installed"
                fi
                
                # Remove conflicting time services before DNS configuration
                remove_conflicting_time_services
                
                # Configure DNS for Samba AD-DC
                configure_samba_dns
                
                # Apply production hardening if requested
                if [ "$PRODUCTION_READY" = true ]; then
                    setup_production_environment
                fi
                
                print_success "Installation completed!"
                print_status "You can now access the Domain Controller interface through Cockpit"
                print_status ""
                print_status "FSMO Orchestration Services:"
                print_status "  • Check status: sudo systemctl status fsmo-orchestration.target"
                print_status "  • View FSMO roles: sudo fsmo-orchestrator.sh --status"
                print_status "  • Multi-DC status: sudo fsmo-orchestrator.sh --multi-dc-status"
                print_status "  • Monitor logs: sudo journalctl -u fsmo-orchestrator.service -f"
                print_status ""
                print_status "DNS Configuration:"
                print_status "  • Internal domain queries: Routed to Samba DNS (127.0.0.1)"
                print_status "  • External queries: Routed to public DNS (8.8.8.8, 8.8.4.4)"
                print_status "  • Test resolution: nslookup google.com && nslookup \$(hostname -d)"
                print_status ""
                print_status "DHCP Configuration:"
                print_status "  • Domain-integrated DHCP configuration auto-generated"
                print_status "  • Configuration stored in SYSVOL for multi-DC replication"
                print_status "  • DHCP pool configured based on detected network settings"
                print_status "  • Check status: systemctl status isc-dhcp-server"
                print_status ""
                print_status "Comprehensive Test Suite:"
                print_status "  • Run all tests: /usr/share/cockpit/domain-controller/tests/run-all-tests.sh"
                print_status "  • Quick connectivity test: /usr/share/cockpit/domain-controller/tests/run-all-tests.sh --quick"
                print_status "  • Individual tests: /usr/share/cockpit/domain-controller/tests/run-all-tests.sh --suite fsmo"
                print_status "  • Test documentation: /usr/share/cockpit/domain-controller/tests/README.md"
                print_status ""
                print_status "Multi-DC Coordination:"
                print_status "  • SYSVOL-based priority system for unlimited domain controllers"
                print_status "  • Automatic coordination to prevent FSMO role conflicts"
                print_status "  • Auto-discovery via DNS SRV records"
                print_status ""
                
                if [ "$PRODUCTION_READY" = true ]; then
                    print_status "Production Environment:"
                    print_status "  • SSL certificates: /etc/cockpit/ws-certs.d/ (replace for production)"
                    print_status "  • Log rotation: Configured for all services"
                    print_status "  • Service monitoring: Every 10 minutes via systemd timer"
                    print_status "  • Backup structure: /var/backups/domain-controller/"
                    print_status "  • Security hardening: SystemD security features enabled"
                    print_status "  • Monitor logs: tail -f /var/log/dc-monitor.log"
                    print_status ""
                fi
            else
                print_error "Package installation failed"
                exit 1
            fi
        fi
    fi
    
else
    print_error "Package build failed"
    exit 1
fi

print_success "Package update completed successfully!"