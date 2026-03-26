// Background service worker: injects scripts + stores keys in chrome.storage.local

// Inject HLS hook into Graphy pages
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

// Receive keys from content.js and store persistently
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'KEY_CAPTURED') {
        const entry = message.payload;
        console.log('[BG] Key received:', entry.videoId, entry.title);

        // Load existing keys, add/update, save
        chrome.storage.local.get({ captured_keys: [] }, (data) => {
            const keys = data.captured_keys;
            const existing = keys.findIndex(k => k.videoId === entry.videoId);
            if (existing >= 0) {
                keys[existing] = entry; // update
                console.log('[BG] Updated existing key for', entry.videoId);
            } else {
                keys.push(entry); // add new
                console.log('[BG] Added new key #' + keys.length);
            }
            chrome.storage.local.set({ captured_keys: keys }, () => {
                sendResponse({ status: 'ok', total: keys.length });
            });
        });
        return true; // async sendResponse
    }
});
