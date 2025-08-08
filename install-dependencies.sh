#!/bin/bash
# Domain Controller Dependencies Installation Script
# Installs all required dependencies before package installation

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_status "Domain Controller Dependencies Installation"
print_status "=========================================="

# Check if running as root
if [[ $EUID -ne 0 ]]; then
    print_error "This script must be run as root (use sudo)"
    exit 1
fi

# Remove conflicting time services first
remove_time_conflicts() {
    print_status "Removing conflicting time services..."
    
    # Stop and remove systemd-timesyncd if present
    if systemctl is-active --quiet systemd-timesyncd 2>/dev/null; then
        systemctl stop systemd-timesyncd
    fi
    if systemctl is-enabled --quiet systemd-timesyncd 2>/dev/null; then
        systemctl disable systemd-timesyncd
    fi
    
    # Purge conflicting packages
    apt-get purge -y systemd-timesyncd ntp openntpd 2>/dev/null || true
    
    print_success "Time service conflicts resolved"
}

# Update package database
print_status "Updating package database..."
apt-get update

# Remove time conflicts first
remove_time_conflicts

# Install all required dependencies
print_status "Installing dependencies..."

# Core Cockpit packages
print_status "Installing Cockpit packages..."
apt-get install -y \
    cockpit \
    cockpit-ws \
    cockpit-system \
    cockpit-networkmanager \
    cockpit-packagekit \
    cockpit-storaged

# Samba Active Directory packages
print_status "Installing Samba AD packages..."
apt-get install -y \
    samba \
    samba-dsdb-modules \
    samba-vfs-modules \
    winbind \
    libpam-winbind \
    libnss-winbind \
    python3-samba

# Kerberos packages
print_status "Installing Kerberos packages..."
apt-get install -y \
    krb5-user \
    krb5-config

# Network and system utilities
print_status "Installing system utilities..."
apt-get install -y \
    dnsutils \
    net-tools \
    acl \
    attr

# Time synchronization (install chrony last to avoid conflicts)
print_status "Installing chrony for time synchronization..."
apt-get install -y chrony

# DHCP server
print_status "Installing DHCP server..."
apt-get install -y isc-dhcp-server

# Firewall
print_status "Installing firewall..."
apt-get install -y ufw

# Optional but recommended packages
print_status "Installing recommended packages..."
apt-get install -y \
    rsync \
    wget \
    curl \
    vim \
    htop \
    tree \
    lsof

print_success "All dependencies installed successfully!"

# Enable and start essential services
print_status "Enabling essential services..."

# Enable Cockpit
systemctl enable --now cockpit.socket
print_success "Cockpit enabled and started"

# Enable chrony (but don't start yet to avoid conflicts)
systemctl enable chrony
print_success "Chrony enabled"

# Don't start samba-ad-dc yet (will be configured during domain setup)
print_status "Samba AD-DC will be configured during domain provisioning"

# Don't start DHCP yet (needs configuration)
print_status "DHCP server will be configured automatically"

print_success "Dependencies installation completed!"
print_status ""
print_status "Next steps:"
print_status "1. Install the domain controller package:"
print_status "   sudo dpkg -i cockpit-domain-controller_*.deb"
print_status ""
print_status "2. Access Cockpit web interface:"
print_status "   https://$(hostname -I | awk '{print $1}'):9090"
print_status ""
print_status "3. Configure your domain controller through the web interface"

exit 0