#!/bin/bash
# Installation script for Comprehensive FSMO Role Orchestrator
# Sets up complete FSMO role management with SYSVOL-based configuration

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_DIR="/etc/systemd/system"
INSTALL_DIR="/usr/local/bin"

echo "Installing Comprehensive FSMO Role Orchestrator..."

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "This script must be run as root (use sudo)" >&2
    exit 1
fi

# Check if Samba AD-DC is installed
if ! command -v samba-tool >/dev/null 2>&1; then
    echo "Error: Samba AD-DC is not installed" >&2
    exit 1
fi

# Install both orchestrator scripts
echo "Installing orchestrator scripts..."
cp "$SCRIPT_DIR/domain-service-orchestrator.sh" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/fsmo-orchestrator.sh" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/domain-service-orchestrator.sh"
chmod +x "$INSTALL_DIR/fsmo-orchestrator.sh"

# Install systemd services and timers for both orchestrators
echo "Installing systemd services and timers..."

# Domain service orchestrator
cp "$SCRIPT_DIR/domain-service-orchestrator.service" "$SYSTEMD_DIR/"
cp "$SCRIPT_DIR/domain-service-orchestrator.timer" "$SYSTEMD_DIR/"

# FSMO orchestrator
cp "$SCRIPT_DIR/fsmo-orchestrator.service" "$SYSTEMD_DIR/"
cp "$SCRIPT_DIR/fsmo-orchestrator.timer" "$SYSTEMD_DIR/"

# Update the ExecStart paths in the service files
sed -i "s|ExecStart=.*domain-service-orchestrator.sh|ExecStart=$INSTALL_DIR/domain-service-orchestrator.sh|" "$SYSTEMD_DIR/domain-service-orchestrator.service"
sed -i "s|ExecStart=.*fsmo-orchestrator.sh|ExecStart=$INSTALL_DIR/fsmo-orchestrator.sh|" "$SYSTEMD_DIR/fsmo-orchestrator.service"

# Reload systemd
echo "Reloading systemd..."
systemctl daemon-reload

# Initialize SYSVOL structures
echo "Initializing SYSVOL structures..."
"$INSTALL_DIR/domain-service-orchestrator.sh" --init
"$INSTALL_DIR/fsmo-orchestrator.sh" --init

# Enable and start the timers
echo "Enabling and starting orchestrator timers..."

# Start with domain service orchestrator (basic services)
systemctl enable domain-service-orchestrator.timer
systemctl start domain-service-orchestrator.timer

# Then start FSMO orchestrator (comprehensive management)
systemctl enable fsmo-orchestrator.timer
systemctl start fsmo-orchestrator.timer

# Run initial orchestration
echo "Running initial FSMO role orchestration..."
"$INSTALL_DIR/fsmo-orchestrator.sh" --orchestrate

echo ""
echo "=========================================="
echo "FSMO Role Orchestrator Installation Complete!"
echo "=========================================="
echo ""
echo "Installed Components:"
echo "  • Domain Service Orchestrator (runs every 5 minutes)"
echo "  • FSMO Role Orchestrator (runs every 10 minutes)"
echo "  • Comprehensive SYSVOL-based configuration management"
echo ""
echo "FSMO Roles Managed:"
echo "  • PDC Emulator: Time sync, DHCP, Password policies"
echo "  • RID Master: SID allocation, RID pool management"
echo "  • Infrastructure Master: Cross-domain refs, DNS infrastructure"
echo "  • Schema Master: Forest schema management"
echo "  • Domain Naming Master: Domain operations, Forest DNS"
echo ""
echo "Usage Commands:"
echo "  fsmo-orchestrator.sh --status           # Show comprehensive FSMO status"
echo "  fsmo-orchestrator.sh --orchestrate      # Manual full orchestration"
echo "  fsmo-orchestrator.sh --role PDC         # Configure specific role"
echo "  fsmo-orchestrator.sh --query            # Query FSMO assignments"
echo ""
echo "  domain-service-orchestrator.sh --status # Show basic service status"
echo ""
echo "Timer Status:"
echo "  systemctl status domain-service-orchestrator.timer"
echo "  systemctl status fsmo-orchestrator.timer"
echo ""
echo "Log Monitoring:"
echo "  journalctl -u domain-service-orchestrator.service -f"
echo "  journalctl -u fsmo-orchestrator.service -f"
echo ""

# Show current FSMO status
echo "Current FSMO Role Status:"
echo "------------------------"
"$INSTALL_DIR/fsmo-orchestrator.sh" --query 2>/dev/null || echo "FSMO query requires Samba to be running"