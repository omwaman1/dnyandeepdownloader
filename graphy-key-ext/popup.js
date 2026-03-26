function loadKeys() {
    chrome.storage.local.get({ captured_keys: [] }, (data) => {
        const keys = data.captured_keys || [];
        document.getElementById('count').textContent = keys.length;
        document.getElementById('export').disabled = keys.length === 0;

        const container = document.getElementById('keys');
        container.innerHTML = '';
        
        [...keys].reverse().forEach(k => {
            const item = document.createElement('div');
            item.className = 'key-item';
            item.innerHTML = `
                <span class="title" title="${k.title}">${k.title || k.videoId}</span>
                <span class="key" title="Click to copy ${k.keyHex}" onclick="copyKey('${k.keyHex}')">${k.keyHex.substring(0, 12)}…</span>
            `;
            container.appendChild(item);
        });
    });
}

function copyKey(hex) {
    navigator.clipboard.writeText(hex);
    showToast('Key copied!');
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.style.display = 'block';
    setTimeout(() => toast.style.display = 'none', 1500);
}

// ─── Extract All Keys ───
document.getElementById('extractAll').addEventListener('click', () => {
    const btn = document.getElementById('extractAll');
    btn.disabled = true;
    btn.textContent = '⏳ Extracting...';
    
    const progressBox = document.getElementById('progressBox');
    progressBox.style.display = 'block';
    document.getElementById('progressText').textContent = 'Starting extraction...';

    // Send trigger to background → content → injector
    chrome.runtime.sendMessage({ type: 'START_AUTO_EXTRACT' });
});

// ─── Listen for progress updates ───
function checkProgress() {
    chrome.storage.local.get({ extract_progress: null }, (data) => {
        const p = data.extract_progress;
        if (!p) return;

        const progressBox = document.getElementById('progressBox');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        const progressDetail = document.getElementById('progressDetail');
        const btn = document.getElementById('extractAll');

        progressBox.style.display = 'block';

        if (p.status === 'started') {
            progressText.textContent = `Found ${p.total} videos, ${p.remaining} to extract`;
            progressFill.style.width = '0%';
        } else if (p.status === 'progress') {
            const pct = Math.round((p.current / p.total) * 100);
            progressFill.style.width = pct + '%';
            progressText.textContent = `${p.current}/${p.total} processed`;
            progressDetail.textContent = `✅ ${p.success} captured • ❌ ${p.failed} failed • 🔑 ${p.captured} total`;
        } else if (p.status === 'done') {
            progressFill.style.width = '100%';
            progressText.textContent = `Done! ${p.captured} keys captured`;
            progressDetail.textContent = `✅ ${p.success} new • ❌ ${p.failed} failed`;
            btn.disabled = false;
            btn.textContent = '🚀 Extract All Keys (Auto)';
            showToast(`Extraction complete! ${p.captured} keys`);
            // Clear progress
            chrome.storage.local.remove('extract_progress');
        } else if (p.status === 'error') {
            progressText.textContent = `Error: ${p.message}`;
            btn.disabled = false;
            btn.textContent = '🚀 Extract All Keys (Auto)';
        }
    });
}

// ─── Export JSON ───
document.getElementById('export').addEventListener('click', () => {
    chrome.storage.local.get({ captured_keys: [] }, (data) => {
        const keys = data.captured_keys || [];
        if (!keys.length) return;

        const exportData = keys.map(k => ({
            videoId: k.videoId,
            title: k.title,
            section: k.section || '',
            subSection: k.subSection || '',
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
        showToast(`Exported ${keys.length} keys!`);
    });
});

// ─── Clear ───
document.getElementById('clear').addEventListener('click', () => {
    if (confirm('Clear all captured keys?')) {
        chrome.storage.local.set({ captured_keys: [], extract_progress: null }, loadKeys);
    }
});

// Auto-refresh
loadKeys();
setInterval(() => { loadKeys(); checkProgress(); }, 1500);
