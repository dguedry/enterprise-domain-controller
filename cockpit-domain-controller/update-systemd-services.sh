#!/bin/bash
# Update SystemD Services for SYSVOL-based FSMO Orchestration
# Migrates from individual FSMO monitors to unified orchestrator

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_DIR="/etc/systemd/system"

echo "Updating SystemD services for SYSVOL-based FSMO orchestration..."

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "This script must be run as root (use sudo)" >&2
    exit 1
fi

# Stop and disable old individual FSMO monitors
echo "Stopping and disabling old FSMO monitoring services..."

OLD_SERVICES=(
    "dhcp-fsmo-monitor.timer"
    "dhcp-fsmo-monitor.service"
    "ntp-fsmo-monitor.timer" 
    "ntp-fsmo-monitor.service"
)

for service in "${OLD_SERVICES[@]}"; do
    if systemctl is-enabled "$service" >/dev/null 2>&1; then
        echo "  Disabling $service"
        systemctl stop "$service" 2>/dev/null || true
        systemctl disable "$service" 2>/dev/null || true
    fi
done

# Disable auto-fsmo-seize service (now integrated into orchestrator)
echo "Disabling separate auto-fsmo-seize service (integrated into orchestrator)..."

# Stop and disable auto-fsmo-seize since it's now integrated
if systemctl is-enabled auto-fsmo-seize.timer >/dev/null 2>&1; then
    echo "  Stopping and disabling auto-fsmo-seize.timer"
    systemctl stop auto-fsmo-seize.timer 2>/dev/null || true
    systemctl disable auto-fsmo-seize.timer 2>/dev/null || true
fi

if systemctl is-enabled auto-fsmo-seize.service >/dev/null 2>&1; then
    echo "  Disabling auto-fsmo-seize.service"
    systemctl disable auto-fsmo-seize.service 2>/dev/null || true
fi

# Remove auto-fsmo-seize service files (functionality now integrated)
if [ -f "$SYSTEMD_DIR/auto-fsmo-seize.service" ]; then
    echo "  Backing up and removing auto-fsmo-seize.service (integrated into orchestrator)"
    cp "$SYSTEMD_DIR/auto-fsmo-seize.service" "$SYSTEMD_DIR/auto-fsmo-seize.service.backup"
    rm -f "$SYSTEMD_DIR/auto-fsmo-seize.service"
fi

if [ -f "$SYSTEMD_DIR/auto-fsmo-seize.timer" ]; then
    echo "  Backing up and removing auto-fsmo-seize.timer (integrated into orchestrator)"
    cp "$SYSTEMD_DIR/auto-fsmo-seize.timer" "$SYSTEMD_DIR/auto-fsmo-seize.timer.backup"
    rm -f "$SYSTEMD_DIR/auto-fsmo-seize.timer"
fi

# Create a unified FSMO monitoring service that replaces old monitors
echo "Creating unified FSMO monitoring service..."

cat > "$SYSTEMD_DIR/fsmo-monitor.service" << 'EOF'
[Unit]
Description=Unified FSMO Role Monitor
Documentation=man:fsmo-orchestrator(8)
Wants=samba-ad-dc.service
After=samba-ad-dc.service network-online.target
Before=fsmo-orchestrator.service
Requires=network-online.target

[Service]
Type=oneshot
# Monitor FSMO roles and trigger orchestration if changes detected
ExecStart=/bin/bash -c 'if /usr/local/bin/fsmo-orchestrator.sh --query | grep -q "HELD_ROLES"; then /usr/local/bin/fsmo-orchestrator.sh --orchestrate; fi'
User=root
Group=root

# Security settings
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/samba /var/run /var/log /etc/dhcp /etc/chrony /etc/bind
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=fsmo-monitor

# Timeout
TimeoutStartSec=120
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

cat > "$SYSTEMD_DIR/fsmo-monitor.timer" << 'EOF'
[Unit]
Description=Unified FSMO Role Monitor Timer
Documentation=man:fsmo-orchestrator(8)
Requires=fsmo-monitor.service

[Timer]
# Monitor FSMO roles every 2 minutes for quick response to changes
OnCalendar=*:0/2
# Run on startup
OnBootSec=1min
# Persistent across reboots
Persistent=true
# Small randomization to prevent conflicts
RandomizedDelaySec=15

[Install]
WantedBy=timers.target
EOF

echo "  Created unified fsmo-monitor service and timer"

# Update existing orchestrator services with better dependencies
echo "Updating orchestrator service dependencies..."

# Update domain-service-orchestrator dependencies
if [ -f "$SYSTEMD_DIR/domain-service-orchestrator.service" ]; then
    sed -i '/After=/c\After=samba-ad-dc.service network-online.target fsmo-monitor.service' "$SYSTEMD_DIR/domain-service-orchestrator.service"
    sed -i '/Wants=/c\Wants=samba-ad-dc.service' "$SYSTEMD_DIR/domain-service-orchestrator.service"
fi

# Update fsmo-orchestrator dependencies  
if [ -f "$SYSTEMD_DIR/fsmo-orchestrator.service" ]; then
    sed -i '/After=/c\After=samba-ad-dc.service network-online.target domain-service-orchestrator.service' "$SYSTEMD_DIR/fsmo-orchestrator.service"
    sed -i '/Wants=/c\Wants=samba-ad-dc.service domain-service-orchestrator.service' "$SYSTEMD_DIR/fsmo-orchestrator.service"
fi

# Create service ordering configuration
echo "Creating service ordering configuration..."

cat > "$SYSTEMD_DIR/fsmo-orchestration.target" << 'EOF'
[Unit]
Description=FSMO Role Orchestration Target
Documentation=man:fsmo-orchestrator(8)
Wants=fsmo-monitor.timer domain-service-orchestrator.timer fsmo-orchestrator.timer
After=samba-ad-dc.service network-online.target
Requires=samba-ad-dc.service
Conflicts=auto-fsmo-seize.timer

[Install]
WantedBy=multi-user.target
EOF

echo "  Created fsmo-orchestration.target for service coordination"

# Remove old service files
echo "Cleaning up old service files..."
for service in "${OLD_SERVICES[@]}"; do
    if [ -f "$SYSTEMD_DIR/$service" ]; then
        echo "  Removing $SYSTEMD_DIR/$service"
        rm -f "$SYSTEMD_DIR/$service"
    fi
done

# Reload systemd
echo "Reloading systemd configuration..."
systemctl daemon-reload

# Enable new services
echo "Enabling updated services..."
systemctl enable fsmo-monitor.timer
systemctl enable fsmo-orchestration.target

# Start new services
echo "Starting updated services..."
systemctl start fsmo-monitor.timer
systemctl start fsmo-orchestration.target

echo ""
echo "=========================================="
echo "SystemD Services Update Complete!"
echo "=========================================="
echo ""
echo "Service Changes:"
echo "  ✅ Replaced individual FSMO monitors with unified orchestration"
echo "  ✅ Updated auto-fsmo-seize to trigger orchestration after seizure"
echo "  ✅ Created unified fsmo-monitor (every 2 minutes)"
echo "  ✅ Improved service dependencies and ordering"
echo "  ✅ Created fsmo-orchestration.target for coordination"
echo ""
echo "Active Timers:"
echo "  • fsmo-monitor.timer (every 2 minutes) - Quick FSMO change detection"  
echo "  • domain-service-orchestrator.timer (every 5 minutes) - Basic services"
echo "  • fsmo-orchestrator.timer (every 5 minutes) - Comprehensive FSMO + auto-seizure"
echo ""
echo "Check status with:"
echo "  systemctl status fsmo-orchestration.target"
echo "  systemctl list-timers '*fsmo*' '*domain*'"
echo ""
echo "Monitor logs with:"
echo "  journalctl -u fsmo-monitor.service -f"
echo "  journalctl -u fsmo-orchestrator.service -f"