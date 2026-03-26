// Content script (ISOLATED world): forwards key data from page to background
window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'GRAPHY_KEY_CAPTURED') {
        const p = event.data.payload;
        console.log('[Content] Forwarding key to background:', p.videoId, p.title);
        
        chrome.runtime.sendMessage({
            type: 'KEY_CAPTURED',
            payload: {
                videoId: p.videoId || '',
                title: p.title || '',
                keyHex: p.keyHex || '',
                ivHex: p.ivHex || '',
                streamUrl: p.streamUrl || '',
                timestamp: p.timestamp || new Date().toLocaleTimeString()
            }
        }, (response) => {
            if (response) {
                console.log('[Content] Key stored! Total keys:', response.total);
            }
        });
    }
});
