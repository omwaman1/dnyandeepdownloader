(function() {
    'use strict';
    console.log('[Graphy Key Collector] Injector loaded...');

    function toHex(arr) {
        return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    let hookAttempts = 0;
    let capturedIds = new Set();

    function tryHookHls() {
        hookAttempts++;
        if (typeof window.Hls === 'undefined') {
            if (hookAttempts < 100) setTimeout(tryHookHls, 200);
            else console.log('[Graphy Key Collector] HLS.js not found after 100 attempts');
            return;
        }
        
        console.log('[Graphy Key Collector] ⚡ HLS.js hooked successfully!');
        
        const OrigHls = window.Hls;
        window.Hls = function(...args) {
            const inst = new OrigHls(...args);
            const origLS = inst.loadSource.bind(inst);
            let streamUrl = '';
            
            inst.loadSource = function(u) { streamUrl = u; return origLS(u); };
            
            inst.on('hlsKeyLoaded', function(e, d) {
                try {
                    const frag = d.frag;
                    if (!frag || !frag.decryptdata || !frag.decryptdata.key) return;

                    const keyBytes = new Uint8Array(frag.decryptdata.key);
                    const keyHex = toHex(keyBytes);
                    const ivHex = frag.decryptdata.iv 
                        ? toHex(new Uint8Array(frag.decryptdata.iv.buffer || frag.decryptdata.iv)) 
                        : '';
                    
                    // Extract videoId from stream URL
                    const vidMatch = streamUrl.match(/\/v\/([a-f0-9]{24})\//);
                    const videoId = vidMatch ? vidMatch[1] : '';

                    if (!videoId || capturedIds.has(videoId)) return;
                    capturedIds.add(videoId);

                    // Find video title from page
                    let title = '';
                    // Try active course item
                    const activeItem = document.querySelector('.courseSubItem.active .courseItemTitle, .citem.active .title');
                    if (activeItem) title = activeItem.innerText.trim();
                    // Fallback to data attribute
                    if (!title) {
                        const dataEl = document.querySelector(`[data-id="${videoId}"]`);
                        if (dataEl) title = dataEl.getAttribute('data-title') || '';
                    }
                    // Fallback to page title
                    if (!title) title = document.title.split(' - ').pop().trim();

                    console.log(`\n🔑 [Key Collector] CAPTURED!`);
                    console.log(`  🆔 ${videoId}`);
                    console.log(`  🎬 ${title}`);
                    console.log(`  🗝️ ${keyHex}`);
                    console.log(`  📡 ${streamUrl.substring(0, 60)}...`);
                    console.log(`  Total captured: ${capturedIds.size}`);
                    
                    // Send to content.js → background.js → chrome.storage
                    window.postMessage({ 
                        type: 'GRAPHY_KEY_CAPTURED', 
                        payload: { videoId, title, keyHex, ivHex, streamUrl, timestamp: new Date().toLocaleTimeString() }
                    }, '*');

                } catch (err) {
                    console.error('[Key Collector] Error:', err);
                }
            });
            return inst;
        };
        // Copy static properties
        Object.keys(OrigHls).forEach(k => { try { window.Hls[k] = OrigHls[k]; } catch(e) {} });
        window.Hls.prototype = OrigHls.prototype;
        window.Hls.isSupported = OrigHls.isSupported;
        window.Hls.Events = OrigHls.Events;
    }

    tryHookHls();
})();
