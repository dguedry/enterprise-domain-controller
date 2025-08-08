#!/bin/bash
# Standalone Time Service Conflict Resolution Script
# Resolves conflicts between chrony and systemd-timesyncd

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

print_status "Domain Controller Time Service Conflict Resolution"
print_status "=================================================="

# Check if running as root
if [[ $EUID -ne 0 ]]; then
    print_error "This script must be run as root (use sudo)"
    exit 1
fi

# Remove conflicting time-daemon services
remove_conflicting_time_services() {
    print_status "Checking for conflicting time-daemon services..."
    
    local conflicts_found=false
    local services_to_remove=()
    
    # Check for systemd-timesyncd (conflicts with chrony)
    # Check both installed (ii) and removed-but-configured (rc) states
    if dpkg -l 2>/dev/null | grep -q "^[ir][ic].*systemd-timesyncd"; then
        local status=$(dpkg -l 2>/dev/null | grep "systemd-timesyncd" | awk '{print $1}' || echo "unknown")
        print_status "Found conflicting service: systemd-timesyncd (status: $status)"
        services_to_remove+=("systemd-timesyncd")
        conflicts_found=true
    fi
    
    # Check for ntp (also conflicts with chrony)
    if dpkg -l 2>/dev/null | grep -q "^ii.*ntp[[:space:]]"; then
        print_status "Found conflicting service: ntp"
        services_to_remove+=("ntp")
        conflicts_found=true
    fi
    
    # Check for openntpd (also conflicts with chrony)
    if dpkg -l 2>/dev/null | grep -q "^ii.*openntpd"; then
        print_status "Found conflicting service: openntpd"
        services_to_remove+=("openntpd")
        conflicts_found=true
    fi
    
    if [ "$conflicts_found" = true ]; then
        print_status "Removing conflicting time-daemon services..."
        
        for service in "${services_to_remove[@]}"; do
            print_status "Processing $service..."
            
            # Stop service if running
            if systemctl is-active --quiet "$service" 2>/dev/null; then
                print_status "Stopping $service service..."
                systemctl stop "$service" 2>/dev/null || true
                sleep 2
            fi
            
            # Disable service if enabled
            if systemctl is-enabled --quiet "$service" 2>/dev/null; then
                print_status "Disabling $service service..."
                systemctl disable "$service" 2>/dev/null || true
            fi
            
            # Purge package completely (remove + config files)
            print_status "Purging $service package..."
            if apt-get purge -y "$service" 2>/dev/null; then
                print_success "Successfully purged $service"
            elif dpkg --purge "$service" 2>/dev/null; then
                print_success "Successfully purged $service (via dpkg)"
            else
                print_warning "Failed to purge $service - may need manual removal"
                # Try to remove any remaining configuration
                dpkg --purge "$service" 2>/dev/null || true
            fi
        done
        
        # Update package database after removals
        print_status "Updating package database..."
        apt-get update >/dev/null 2>&1 || true
        
        # Clean up any remaining issues
        print_status "Cleaning up package dependencies..."
        apt-get autoremove -y >/dev/null 2>&1 || true
        apt-get autoclean >/dev/null 2>&1 || true
        
        print_success "Conflicting time services removed successfully"
    else
        print_status "No conflicting time services found"
    fi
}

# Show current status
show_current_status() {
    print_status "Current time-related packages:"
    if dpkg -l 2>/dev/null | grep -E "(systemd-timesyncd|ntp|chrony|openntpd)"; then
        dpkg -l 2>/dev/null | grep -E "(systemd-timesyncd|ntp|chrony|openntpd)" | while read line; do
            echo "  $line"
        done
    else
        echo "  No time-related packages found"
    fi
    echo ""
}

# Main execution
print_status "Analyzing current system state..."
show_current_status

# Remove conflicts
remove_conflicting_time_services

print_status "Final system state:"
show_current_status

print_success "Time service conflict resolution completed!"
print_status ""
print_status "You can now install the domain controller package:"
print_status "  sudo dpkg -i cockpit-domain-controller_*.deb"
print_status "  sudo apt-get install -f  # if needed"
print_status ""
print_status "Or use the build script:"
print_status "  sudo ./build-package.sh -y"

exit 0