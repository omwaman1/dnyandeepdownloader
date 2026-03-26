// Background: inject scripts, store keys, relay messages

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url && tab.url.includes('graphy.com')) {
        chrome.scripting.executeScript({
            target: { tabId },
            files: ['injector.js'],
            world: 'MAIN'
        }).then(() => {
            console.log('[BG] Injector loaded into tab', tabId);
        }).catch(err => {
            console.error('[BG] Injection error:', err);
        });
    }
});

// Store keys persistently
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'KEY_CAPTURED') {
        const entry = message.payload;
        chrome.storage.local.get({ captured_keys: [] }, (data) => {
            const keys = data.captured_keys;
            const existing = keys.findIndex(k => k.videoId === entry.videoId);
            if (existing >= 0) {
                keys[existing] = entry;
            } else {
                keys.push(entry);
            }
            chrome.storage.local.set({ captured_keys: keys }, () => {
                sendResponse({ status: 'ok', total: keys.length });
            });
        });
        return true;
    }

    // Forward extraction progress to popup
    if (message.type === 'EXTRACT_PROGRESS') {
        chrome.storage.local.set({ extract_progress: message.data });
    }

    // Trigger auto-extract on active tab — inject scripts first to avoid "Receiving end" errors
    if (message.type === 'START_AUTO_EXTRACT') {
        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            if (!tabs[0]) return;
            const tabId = tabs[0].id;
            try {
                // Ensure injector is loaded in MAIN world
                await chrome.scripting.executeScript({
                    target: { tabId },
                    files: ['injector.js'],
                    world: 'MAIN'
                });
                // Trigger auto-extract directly via MAIN world script
                await chrome.scripting.executeScript({
                    target: { tabId },
                    func: () => window.postMessage({ type: 'GRAPHY_START_AUTO_EXTRACT' }, '*'),
                    world: 'MAIN'
                });
                // Ensure content script is loaded for receiving key messages
                await chrome.scripting.executeScript({
                    target: { tabId },
                    files: ['content.js']
                });
                console.log('[BG] Auto-extract triggered on tab', tabId);
            } catch (err) {
                console.error('[BG] Failed to trigger auto-extract:', err);
            }
        });
    }
});
