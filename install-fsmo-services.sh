#!/bin/bash
# Install FSMO Management Services
# Run this script as root to install FSMO seizure capabilities

set -e

if [ "$EUID" -ne 0 ]; then
    echo "This script must be run as root"
    exit 1
fi

INSTALL_DIR="/usr/local/bin"
SYSTEMD_DIR="/etc/systemd/system"
SOURCE_DIR="$(dirname "$0")/cockpit-domain-controller"

echo "Installing FSMO management scripts..."

# Copy scripts
cp "$SOURCE_DIR/auto-fsmo-seize.sh" "$INSTALL_DIR/"
cp "$SOURCE_DIR/fsmo-seize.sh" "$INSTALL_DIR/"
cp "$SOURCE_DIR/dhcp-fsmo-manager.sh" "$INSTALL_DIR/"
cp "$SOURCE_DIR/ntp-fsmo-manager.sh" "$INSTALL_DIR/"

# Make executable
chmod +x "$INSTALL_DIR/auto-fsmo-seize.sh"
chmod +x "$INSTALL_DIR/fsmo-seize.sh"
chmod +x "$INSTALL_DIR/dhcp-fsmo-manager.sh"
chmod +x "$INSTALL_DIR/ntp-fsmo-manager.sh"

echo "Installing systemd services..."

# Copy systemd files
cp "$SOURCE_DIR/auto-fsmo-seize.service" "$SYSTEMD_DIR/"
cp "$SOURCE_DIR/auto-fsmo-seize.timer" "$SYSTEMD_DIR/"
cp "$SOURCE_DIR/dhcp-fsmo-monitor.service" "$SYSTEMD_DIR/"
cp "$SOURCE_DIR/dhcp-fsmo-monitor.timer" "$SYSTEMD_DIR/"
cp "$SOURCE_DIR/ntp-fsmo-monitor.service" "$SYSTEMD_DIR/"
cp "$SOURCE_DIR/ntp-fsmo-monitor.timer" "$SYSTEMD_DIR/"

# Reload systemd
systemctl daemon-reload

echo "Enabling services..."

# Enable and start timers
systemctl enable auto-fsmo-seize.timer
systemctl enable dhcp-fsmo-monitor.timer
systemctl enable ntp-fsmo-monitor.timer

systemctl start auto-fsmo-seize.timer
systemctl start dhcp-fsmo-monitor.timer
systemctl start ntp-fsmo-monitor.timer

echo "Creating SYSVOL directories..."

# Create SYSVOL directories
DOMAIN_NAME=$(find /var/lib/samba/sysvol/ -maxdepth 1 -type d -name "*.local" 2>/dev/null | head -1 | xargs basename 2>/dev/null || echo "guedry.local")

mkdir -p "/var/lib/samba/sysvol/${DOMAIN_NAME}/dhcp-configs"
mkdir -p "/var/lib/samba/sysvol/${DOMAIN_NAME}/ntp-configs"

echo "Installation complete!"
echo ""
echo "Services installed:"
echo "  - auto-fsmo-seize.timer   (checks for failed FSMO holders every 5 minutes)"
echo "  - dhcp-fsmo-monitor.timer (manages DHCP based on PDC role every 5 minutes)"
echo "  - ntp-fsmo-monitor.timer  (manages NTP based on PDC role every 3 minutes)"
echo ""
echo "Manual commands:"
echo "  fsmo-seize.sh --check     (check current FSMO status)"
echo "  fsmo-seize.sh --force     (emergency: seize all roles)"
echo "  auto-fsmo-seize.sh --test (test PDC connectivity)"
echo ""
echo "To immediately seize PDC role from failed DC:"
echo "  auto-fsmo-seize.sh --force"