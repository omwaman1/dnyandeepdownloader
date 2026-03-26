// Content script (ISOLATED world): bridges page ↔ background
// Wrapped in try-catch to handle "Extension context invalidated" gracefully

window.addEventListener('message', function(event) {
    // Forward captured keys to background for storage
    if (event.data && event.data.type === 'GRAPHY_KEY_CAPTURED') {
        try {
            chrome.runtime.sendMessage({
                type: 'KEY_CAPTURED',
                payload: event.data.payload
            });
        } catch(e) {
            // Extension context invalidated — harmless, keys still captured via re-injected instance
        }
    }

    // Forward extraction progress to background (for popup)
    if (event.data && event.data.type === 'GRAPHY_EXTRACT_PROGRESS') {
        try {
            chrome.runtime.sendMessage({
                type: 'EXTRACT_PROGRESS',
                data: event.data
            });
        } catch(e) {
            // Extension context invalidated
        }
    }
});

// Listen for commands from popup via background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'START_AUTO_EXTRACT') {
        window.postMessage({ type: 'GRAPHY_START_AUTO_EXTRACT' }, '*');
        sendResponse({ status: 'triggered' });
    }
});
