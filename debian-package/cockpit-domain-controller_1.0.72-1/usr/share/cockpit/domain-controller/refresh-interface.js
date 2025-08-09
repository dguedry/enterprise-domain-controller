// Refresh cockpit interface after FSMO changes
// This can be run in browser console to clear stuck interface

console.log('Refreshing cockpit domain controller interface...');

// Clear any loading states
const loadingOverlay = document.getElementById('loading-overlay');
if (loadingOverlay) {
    loadingOverlay.classList.add('hidden');
    console.log('Cleared loading overlay');
}

// Hide any loading spinners
const loadingSpinners = document.querySelectorAll('.pf-c-spinner, .spinner-border');
loadingSpinners.forEach(spinner => {
    spinner.style.display = 'none';
});

// Re-enable any disabled buttons
const disabledButtons = document.querySelectorAll('button[disabled]');
disabledButtons.forEach(button => {
    button.disabled = false;
});

// Trigger domain status check if available
if (window.domainController && typeof window.domainController.checkDomainStatus === 'function') {
    console.log('Triggering domain status refresh...');
    window.domainController.checkDomainStatus();
} else {
    console.log('Domain controller not available, try refreshing the page');
    // Force page refresh as fallback
    setTimeout(() => {
        window.location.reload();
    }, 2000);
}

console.log('Interface refresh completed');