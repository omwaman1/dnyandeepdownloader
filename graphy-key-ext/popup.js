function loadKeys() {
    chrome.storage.local.get({ captured_keys: [] }, (data) => {
        const keys = data.captured_keys || [];
        
        // Update count
        document.getElementById('count').textContent = keys.length;
        document.getElementById('export').disabled = keys.length === 0;
        
        // Render key list (newest first)
        const container = document.getElementById('keys');
        container.innerHTML = '';
        
        [...keys].reverse().forEach(k => {
            const item = document.createElement('div');
            item.className = 'key-item';
            item.innerHTML = `
                <span class="title" title="${k.title}">${k.title || k.videoId}</span>
                <span class="key" title="Click to copy" onclick="copyKey('${k.keyHex}')">${k.keyHex.substring(0, 12)}...</span>
            `;
            container.appendChild(item);
        });
    });
}

function copyKey(hex) {
    navigator.clipboard.writeText(hex);
    const toast = document.getElementById('toast');
    toast.style.display = 'block';
    toast.textContent = 'Key copied!';
    setTimeout(() => toast.style.display = 'none', 1500);
}

// Export JSON — format matching dnyandeep_downloader.js
document.getElementById('export').addEventListener('click', () => {
    chrome.storage.local.get({ captured_keys: [] }, (data) => {
        const keys = data.captured_keys || [];
        if (!keys.length) return;

        // Format for downloader: { videoId, title, keyHex, ivHex, streamUrl }
        const exportData = keys.map(k => ({
            videoId: k.videoId,
            title: k.title,
            keyHex: k.keyHex,
            ivHex: k.ivHex || '',
            streamUrl: k.streamUrl
        }));

        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'videos_to_download.json';
        a.click();
        URL.revokeObjectURL(url);

        const toast = document.getElementById('toast');
        toast.style.display = 'block';
        toast.textContent = `Exported ${keys.length} keys!`;
        setTimeout(() => toast.style.display = 'none', 2000);
    });
});

// Clear all keys
document.getElementById('clear').addEventListener('click', () => {
    if (confirm('Clear all captured keys?')) {
        chrome.storage.local.set({ captured_keys: [] }, loadKeys);
    }
});

// Auto-refresh
loadKeys();
setInterval(loadKeys, 2000);
