#!/bin/bash
# Installation script for Comprehensive FSMO Role Orchestrator
# Sets up complete FSMO role management with a single, unified orchestrator.

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

# Install the main orchestrator script
echo "Installing orchestrator script..."
cp "$SCRIPT_DIR/fsmo-orchestrator.sh" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/fsmo-orchestrator.sh"

# Install the main systemd service and timer
echo "Installing systemd service and timer..."
cp "$SCRIPT_DIR/fsmo-orchestrator.service" "$SYSTEMD_DIR/"
cp "$SCRIPT_DIR/fsmo-orchestrator.timer" "$SYSTEMD_DIR/"

# Ensure the ExecStart path in the service file is correct
sed -i "s|ExecStart=.*fsmo-orchestrator.sh|ExecStart=$INSTALL_DIR/fsmo-orchestrator.sh --orchestrate|" "$SYSTEMD_DIR/fsmo-orchestrator.service"

# Reload systemd
echo "Reloading systemd..."
systemctl daemon-reload

# Initialize SYSVOL structures by running the init function
echo "Initializing SYSVOL structures..."
"$INSTALL_DIR/fsmo-orchestrator.sh" --init

# Enable and start the timer
echo "Enabling and starting the orchestrator timer..."
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
echo "  • Unified FSMO Role Orchestrator (runs every 5 minutes)"
echo "  • Comprehensive SYSVOL-based configuration management"
echo ""
echo "The single 'fsmo-orchestrator.timer' now manages all role and service orchestration, including auto-seizure."
echo ""
echo "Timer Status:"
echo "  systemctl status fsmo-orchestrator.timer"
echo ""
echo "Log Monitoring:"
echo "  journalctl -u fsmo-orchestrator.service -f"
echo ""

# Show current FSMO status
echo "Current FSMO Role Status:"
echo "------------------------"
"$INSTALL_DIR/fsmo-orchestrator.sh" --query 2>/dev/null || echo "FSMO query requires Samba to be running"