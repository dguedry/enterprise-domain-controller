#!/bin/bash
# Cleanup Obsolete FSMO Service Files
# Removes old FSMO monitoring services replaced by unified orchestrators

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Cleaning up obsolete FSMO service files..."

# Files that are obsolete and can be safely removed
OBSOLETE_FILES=(
    # Old individual FSMO monitors (replaced by unified orchestrators)
    "dhcp-fsmo-monitor.service"
    "dhcp-fsmo-monitor.timer"
    "ntp-fsmo-monitor.service"
    "ntp-fsmo-monitor.timer"

    # Old individual FSMO manager scripts (replaced by orchestrators)
    "dhcp-fsmo-manager.sh"
    "ntp-fsmo-manager.sh"

    # Old installation script (replaced by comprehensive installer)
    "install-domain-orchestrator.sh"

    # Backup files from development
    "domain-controller.js.backup"
    "domain-controller.js.working-backup"
)

# Files to keep (still needed)
KEEP_FILES=(
    # Core orchestrators
    "domain-service-orchestrator.sh"
    "domain-service-orchestrator.service"
    "domain-service-orchestrator.timer"
    "fsmo-orchestrator.sh"  # Now includes auto-seizure functionality
    "fsmo-orchestrator.service"
    "fsmo-orchestrator.timer"

    # Manual emergency scripts (still useful for manual operations)
    "auto-fsmo-seize.sh"  # Kept for manual use
    "fsmo-seize.sh"

    # Installation and migration scripts
    "install-fsmo-orchestrator.sh"
    "migrate-to-orchestrators.sh"
    "update-systemd-services.sh"
)

# Count files to be removed
removed_count=0
kept_count=0

echo "Files to be removed:"
for file in "${OBSOLETE_FILES[@]}"; do
    if [ -f "$SCRIPT_DIR/$file" ]; then
        echo "  ✗ $file"
        ((removed_count++))
    else
        echo "  ? $file (not found)"
    fi
done

echo ""
echo "Files to keep (verifying they exist):"
for file in "${KEEP_FILES[@]}"; do
    if [ -f "$SCRIPT_DIR/$file" ]; then
        echo "  ✓ $file"
        ((kept_count++))
    else
        echo "  ⚠ $file (missing - may need attention)"
    fi
done

echo ""
echo "Summary:"
echo "  Files to remove: $removed_count"
echo "  Files to keep: $kept_count"
echo ""

# Check for auto-confirm flag
if [[ "$1" == "-y" || "$1" == "--yes" ]]; then
    REPLY="y"
else
    # Prompt for confirmation
    read -p "Proceed with removal? (y/N): " -n 1 -r
    echo
fi

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "Removing obsolete files..."

    for file in "${OBSOLETE_FILES[@]}"; do
        if [ -f "$SCRIPT_DIR/$file" ]; then
            echo "  Removing $file"
            rm "$SCRIPT_DIR/$file"
        fi
    done

    echo ""
    echo "✅ Cleanup completed successfully!"
    echo ""
    echo "Remaining FSMO service files:"
    ls -la "$SCRIPT_DIR"/*fsmo*.sh "$SCRIPT_DIR"/*fsmo*.service "$SCRIPT_DIR"/*fsmo*.timer "$SCRIPT_DIR"/*orchestrator* 2>/dev/null || echo "  (None found)"

else
    echo "Cleanup cancelled."
    exit 0
fi