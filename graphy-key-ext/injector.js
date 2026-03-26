(function() {
    'use strict';
    console.log('[Graphy Key Collector] Injector loaded...');

    function toHex(arr) {
        return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    let hookAttempts = 0;
    let capturedIds = new Set();
    let OrigHls = null; // store reference to original HLS constructor

    function tryHookHls() {
        hookAttempts++;
        if (typeof window.Hls === 'undefined') {
            if (hookAttempts < 100) setTimeout(tryHookHls, 200);
            else console.log('[Graphy Key Collector] HLS.js not found after 100 attempts');
            return;
        }
        
        console.log('[Graphy Key Collector] ⚡ HLS.js hooked successfully!');
        
        OrigHls = window.Hls;
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
                    
                    const vidMatch = streamUrl.match(/\/v\/([a-f0-9]{24})\//);
                    const videoId = vidMatch ? vidMatch[1] : '';

                    if (!videoId || capturedIds.has(videoId)) return;
                    capturedIds.add(videoId);

                    // Find title and section from page
                    let title = '';
                    let section = '';
                    const dataEl = document.querySelector(`[data-id="${videoId}"]`);
                    if (dataEl) {
                        title = dataEl.getAttribute('data-title') || '';
                        // Build section map by document order: labels appear before their videos
                        let curSec = '';
                        const allItems = document.querySelectorAll('[data-type="label"][data-title], [data-type="video"][data-id]');
                        for (const item of allItems) {
                            if (item.getAttribute('data-type') === 'label') {
                                curSec = item.getAttribute('data-title') || '';
                            }
                            if (item.getAttribute('data-id') === videoId) {
                                section = curSec;
                                break;
                            }
                        }
                    }
                    if (!title) {
                        const activeItem = document.querySelector('.courseSubItem.active .courseItemTitle');
                        if (activeItem) title = activeItem.innerText.trim();
                    }
                    if (!title) title = document.title.split(' - ').pop().trim();

                    console.log(`🔑 [Key Collector] CAPTURED: ${videoId} — ${title} — ${keyHex}`);
                    
                    window.postMessage({ 
                        type: 'GRAPHY_KEY_CAPTURED', 
                        payload: { videoId, title, section, keyHex, ivHex, streamUrl, timestamp: new Date().toLocaleTimeString() }
                    }, '*');

                } catch (err) {
                    console.error('[Key Collector] Error:', err);
                }
            });
            return inst;
        };
        Object.keys(OrigHls).forEach(k => { try { window.Hls[k] = OrigHls[k]; } catch(e) {} });
        window.Hls.prototype = OrigHls.prototype;
        window.Hls.isSupported = OrigHls.isSupported;
        window.Hls.Events = OrigHls.Events;
    }

    // ─── Auto-Extract All Keys ───
    
    async function autoExtractAllKeys() {
        console.log('\n🚀 [Auto Extract] Starting batch key extraction...\n');

        // 1. Find course ID from URL
        const courseMatch = window.location.pathname.match(/courses\/([a-f0-9]+)/);
        if (!courseMatch) {
            console.error('[Auto Extract] Not on a course page!');
            window.postMessage({ type: 'GRAPHY_EXTRACT_PROGRESS', status: 'error', message: 'Not on a course page' }, '*');
            return;
        }
        const courseId = courseMatch[1];

        // 2. Build section map by scanning all items in document order
        // Section headers have data-type="label", videos have data-type="video"
        const allDomItems = document.querySelectorAll('[data-type="label"][data-title], [data-type="video"][data-id]');
        let currentSection = '';
        const allVideos = [];
        
        allDomItems.forEach(el => {
            if (el.getAttribute('data-type') === 'label') {
                currentSection = el.getAttribute('data-title') || '';
                console.log(`[Auto Extract] 📁 Section: ${currentSection}`);
            } else if (el.getAttribute('data-type') === 'video' && el.getAttribute('data-id')) {
                allVideos.push({
                    id: el.getAttribute('data-id'),
                    title: el.getAttribute('data-title') || 'Unknown',
                    section: currentSection
                });
            }
        });
        
        console.log(`[Auto Extract] Built section map: ${allVideos.length} videos across sections`);

        // Filter out already captured
        const videos = allVideos.filter(v => !capturedIds.has(v.id));
        const totalOnPage = allVideos.length;
        const alreadyCaptured = capturedIds.size;

        console.log(`[Auto Extract] ${totalOnPage} videos on page, ${alreadyCaptured} already captured, ${videos.length} remaining`);
        window.postMessage({ 
            type: 'GRAPHY_EXTRACT_PROGRESS', 
            status: 'started', 
            total: totalOnPage, 
            remaining: videos.length, 
            captured: alreadyCaptured 
        }, '*');

        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < videos.length; i++) {
            const video = videos[i];
            
            if (capturedIds.has(video.id)) {
                successCount++;
                continue;
            }

            try {
                // 3. Fetch stream URL from API (same-origin, cookies included automatically)
                console.log(`[Auto Extract] [${i + 1}/${videos.length}] Fetching: ${video.title.substring(0, 40)}...`);
                
                const resp = await fetch(`/s/courses/${courseId}/videos/${video.id}/get`, {
                    headers: { 'accept': 'application/json', 'x-requested-with': 'XMLHttpRequest' }
                });
                
                if (!resp.ok) {
                    console.warn(`[Auto Extract] API error ${resp.status} for ${video.id}`);
                    failCount++;
                    continue;
                }

                const data = await resp.json();
                const resource = data['spayee:resource'] || {};
                const streamUrl = resource['spayee:streamUrl'] || '';

                if (!streamUrl) {
                    console.warn(`[Auto Extract] No streamUrl for ${video.id}`);
                    failCount++;
                    continue;
                }

                // 4. Create hidden HLS instance to trigger key loading
                const captured = await new Promise((resolve) => {
                    const tempVideo = document.createElement('video');
                    tempVideo.muted = true;
                    tempVideo.style.display = 'none';
                    document.body.appendChild(tempVideo);

                    const hls = new window.Hls({ 
                        maxBufferLength: 1,    // minimal buffering
                        maxMaxBufferLength: 2,
                        startLevel: 0          // lowest quality
                    });

                    let resolved = false;
                    
                    // Listen for key capture (our hook fires postMessage)
                    const onKeyCapture = (e) => {
                        if (e.data?.type === 'GRAPHY_KEY_CAPTURED' && e.data?.payload?.videoId === video.id) {
                            if (!resolved) { resolved = true; cleanup(); resolve(true); }
                        }
                    };
                    window.addEventListener('message', onKeyCapture);

                    function cleanup() {
                        window.removeEventListener('message', onKeyCapture);
                        try { hls.destroy(); } catch(e) {}
                        try { tempVideo.remove(); } catch(e) {}
                    }

                    // Timeout after 15s
                    setTimeout(() => {
                        if (!resolved) { resolved = true; cleanup(); resolve(false); }
                    }, 15000);

                    hls.loadSource(streamUrl);
                    hls.attachMedia(tempVideo);
                });

                if (captured) {
                    successCount++;
                    console.log(`[Auto Extract] ✅ [${i + 1}/${videos.length}] ${video.title.substring(0, 40)}`);
                } else {
                    failCount++;
                    console.log(`[Auto Extract] ⏱️ [${i + 1}/${videos.length}] Timeout: ${video.title.substring(0, 40)}`);
                }

            } catch (err) {
                failCount++;
                console.error(`[Auto Extract] ❌ [${i + 1}/${videos.length}] Error: ${err.message}`);
            }

            // Send progress update
            window.postMessage({ 
                type: 'GRAPHY_EXTRACT_PROGRESS', 
                status: 'progress', 
                current: i + 1, 
                total: videos.length,
                captured: capturedIds.size,
                success: successCount,
                failed: failCount
            }, '*');

            // Small delay to avoid overwhelming the server
            await new Promise(r => setTimeout(r, 800));
        }

        console.log(`\n🏁 [Auto Extract] Done! ✅ ${successCount} captured, ❌ ${failCount} failed, Total: ${capturedIds.size}\n`);
        window.postMessage({ 
            type: 'GRAPHY_EXTRACT_PROGRESS', 
            status: 'done', 
            captured: capturedIds.size,
            success: successCount,
            failed: failCount
        }, '*');
    }

    // Listen for trigger from content.js
    window.addEventListener('message', (e) => {
        if (e.data?.type === 'GRAPHY_START_AUTO_EXTRACT') {
            autoExtractAllKeys();
        }
    });

    tryHookHls();
})();
