const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('./node_modules/cheerio');

// ═══════════════════════════════════════════════════════════════════════════
// GRAPHY UNIFIED PDF DOWNLOADER
// Combines: Auto-Fetch → Extract → Fetch URLs → Download
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
    extractedPdfsFile: path.join(__dirname, 'extracted_pdfs.json'),
    pdfLinksFile: path.join(__dirname, 'pdfs_with_raw_links.json'),
    downloadsDir: path.join(__dirname, '..', 'downloads'),
    courseId: '6865121d04aaf431adeda84a',
    courseUrl: 'https://dnyanadeepsaralseva.graphy.com/s/courses/6865121d04aaf431adeda84a/take',
    cookies: "id=9cf2f029-9689-4cdf-bb39-ece68990575f; SESSIONID=BEDC7B1B28E31F60902FF222203FC898; c_login_token=1774186300823",
    concurrency: 10,
    fetchDelay: 200,
    downloadRetries: 3,
};

const apiHeaders = {
    'Cookie': CONFIG.cookies,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'x-requested-with': 'XMLHttpRequest',
    'accept': 'application/json, text/javascript, */*; q=0.01',
    'referer': CONFIG.courseUrl
};

// ═══════════════════════════════════════════════════════════════════════════
// STEP 0: FETCH COURSE PAGE HTML
// ═══════════════════════════════════════════════════════════════════════════

function fetchWebpage() {
    console.log('\n━━━ STEP 0: FETCHING COURSE PAGE ━━━');
    
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'accept-language': 'en-US,en;q=0.9,hi;q=0.8',
                'cookie': CONFIG.cookies,
                'origin': 'https://dnyanadeepsaralseva.graphy.com',
                'referer': 'https://dnyanadeepsaralseva.graphy.com/',
                'sec-fetch-dest': 'document',
                'sec-fetch-mode': 'navigate',
                'sec-fetch-site': 'none',
                'user-agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36'
            },
            timeout: 30000
        };

        const req = https.get(CONFIG.courseUrl, options, (res) => {
            let data = Buffer.alloc(0);
            
            res.on('data', chunk => {
                data = Buffer.concat([data, chunk]);
            });
            
            res.on('end', () => {
                try {
                    const html = data.toString('utf-8');
                    console.log(`✅ Fetched course page (${data.length} bytes)`);
                    resolve(html);
                } catch (err) {
                    reject(new Error(`Failed to decode HTML: ${err.message}`));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout after 30s'));
        });
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 1: EXTRACT PDFs FROM HTML
// ═══════════════════════════════════════════════════════════════════════════

function extractPdfsFromHtmlString(htmlString) {
    console.log('\n━━━ STEP 1: EXTRACTING PDFs FROM HTML ━━━');
    
    if (!htmlString || htmlString.length === 0) {
        console.error(`❌ No HTML content provided`);
        return [];
    }

    const $ = cheerio.load(htmlString);
    const pdfs = [];
    let currentSection = "Root / Uncategorized";
    
    // Collect all elements with data-type in document order
    const allElements = $('[data-type]').toArray();
    
    allElements.forEach((el) => {
        const $el = $(el);
        const type = $el.attr('data-type');
        const title = $el.attr('data-title');
        const id = $el.attr('data-id');

        // Labels represent section headers
        if (type === 'label' && title) {
            currentSection = title.trim() || currentSection;
        }

        // Extract PDFs and associate with current section
        if ((type === 'pdf' || type === 'document' || type === 'attachment' || type === 'file') && id && title) {
            if (!pdfs.some(p => p.id === id)) {
                pdfs.push({ 
                    id, 
                    title: title.trim(), 
                    section: currentSection, 
                    type 
                });
            }
        }
    });

    console.log(`✅ Found ${pdfs.length} PDF items`);
    
    // Show section distribution
    if (pdfs.length > 0) {
        const sections = new Map();
        pdfs.forEach(p => {
            sections.set(p.section, (sections.get(p.section) || 0) + 1);
        });
        
        console.log(`   Organized into ${sections.size} sections:`);
        Array.from(sections.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .forEach(([s, count]) => console.log(`     • ${s}: ${count} PDFs`));
    }
    
    return pdfs;
}

// ═══════════════════════════════════════════════════════════════════════════// HELPER: CHECK WHICH PDFs ALREADY EXIST
// ═══════════════════════════════════════════════════════════════════════════

function getAlreadyDownloadedPdfs() {
    const downloaded = new Set();
    
    if (!fs.existsSync(CONFIG.downloadsDir)) {
        return downloaded;
    }
    
    const sections = fs.readdirSync(CONFIG.downloadsDir);
    sections.forEach(section => {
        const sectionPath = path.join(CONFIG.downloadsDir, section);
        if (fs.statSync(sectionPath).isDirectory()) {
            const files = fs.readdirSync(sectionPath);
            files.forEach(file => {
                const filePath = path.join(sectionPath, file);
                const stats = fs.statSync(filePath);
                // Only count files > 1KB as valid downloads
                if (stats.size > 1000) {
                    const filename = path.parse(file).name;
                    downloaded.add(filename);
                }
            });
        }
    });
    
    return downloaded;
}

// ═══════════════════════════════════════════════════════════════════════════// STEP 2: FETCH RAW PDF URLs
// ═══════════════════════════════════════════════════════════════════════════

async function fetchPdfUrls(pdfs) {
    console.log('\n━━━ STEP 2: FETCHING RAW PDF URLS ━━━');
    
    // Check which PDFs already exist
    const alreadyDownloaded = getAlreadyDownloadedPdfs();
    const needsFetch = pdfs.filter(pdf => !alreadyDownloaded.has(sanitize(pdf.title)));
    
    console.log(`   📊 Already downloaded: ${alreadyDownloaded.size}`);
    console.log(`   📥 Need to fetch: ${needsFetch.length}/${pdfs.length}\n`);
    
    let success = 0;
    let failed = 0;
    let skipped = 0;
    const failedPdfs = []; // Track non-downloadable PDFs
    const total = pdfs.length;

    for (let i = 0; i < pdfs.length; i++) {
        const pdf = pdfs[i];
        const safeTitle = sanitize(pdf.title);
        
        // Skip if already downloaded
        if (alreadyDownloaded.has(safeTitle)) {
            pdf.rawPdfUrl = 'ALREADY_DOWNLOADED';
            skipped++;
            if ((i + 1) % 10 === 0) {
                process.stdout.write(`\r   Progress: ${i+1}/${total} (✅: ${success}, ❌: ${failed}, ⏭️: ${skipped})`);
            }
            continue;
        }
        
        const url = `https://dnyanadeepsaralseva.graphy.com/s/courses/${CONFIG.courseId}/pdfs/${pdf.id}/download`;
        
        try {
            const res = await fetch(url, { 
                headers: apiHeaders, 
                redirect: 'manual' 
            });
            
            if (res.status === 302 || res.status === 301) {
                const location = res.headers.get('location');
                if (location) {
                    pdf.rawPdfUrl = location;
                    success++;
                } else {
                    failed++;
                    failedPdfs.push({ title: pdf.title, section: pdf.section, reason: 'No redirect location' });
                }
            } else {
                failed++;
                failedPdfs.push({ title: pdf.title, section: pdf.section, reason: `HTTP ${res.status}` });
            }
        } catch (err) {
            failed++;
            failedPdfs.push({ title: pdf.title, section: pdf.section, reason: err.message });
        }
        
        // Anti-ban delay
        await new Promise(r => setTimeout(r, CONFIG.fetchDelay));
        
        // Progress update every 10 items
        if ((i + 1) % 10 === 0) {
            process.stdout.write(`\r   Progress: ${i+1}/${total} (✅: ${success}, ❌: ${failed}, ⏭️: ${skipped})`);
        }
    }

    // Save failed PDFs to file
    if (failedPdfs.length > 0) {
        const failedFile = path.join(__dirname, 'failed_pdfs.json');
        fs.writeFileSync(failedFile, JSON.stringify(failedPdfs, null, 2));
        console.log(`\n⚠️  ${failedPdfs.length} PDFs not downloadable - saved to: failed_pdfs.json`);
    }

    console.log(`\n✅ Fetched URLs for ${success}/${needsFetch.length} new PDFs`);
    console.log(`❌ Failed to fetch: ${failed}/${needsFetch.length} PDFs (see failed_pdfs.json)`);
    console.log(`⏭️  Already downloaded: ${skipped}`);
    return pdfs;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3: DOWNLOAD PDFs
// ═══════════════════════════════════════════════════════════════════════════

function sanitize(str) {
    return (str || 'Uncategorized').replace(/[\\/:*?"<>|]/g, '').trim();
}

async function downloadPdf(pdfInfo, index, total) {
    const tag = `[${index + 1}/${total}]`;
    const safeSection = sanitize(pdfInfo.section);
    const safeTitle = sanitize(pdfInfo.title);
    
    const sectionDir = path.join(CONFIG.downloadsDir, safeSection);
    const outputPdf = path.join(sectionDir, `${safeTitle}.pdf`);

    // Skip if already exists and is somewhat valid
    if (fs.existsSync(outputPdf) && fs.statSync(outputPdf).size > 1000) {
        process.stdout.write(`\r${tag} ⏭️  SKIP`);
        return;
    }

    if (!fs.existsSync(sectionDir)) fs.mkdirSync(sectionDir, { recursive: true });

    let attempts = 0;
    while (attempts < CONFIG.downloadRetries) {
        try {
            const res = await fetch(pdfInfo.rawPdfUrl);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            
            const buffer = Buffer.from(await res.arrayBuffer());
            fs.writeFileSync(outputPdf, buffer);
            
            const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
            process.stdout.write(`\r${tag} ✅ ${safeTitle}.pdf (${sizeMB} MB)     `);
            return;
        } catch (err) {
            attempts++;
            if (attempts === CONFIG.downloadRetries) {
                process.stdout.write(`\r${tag} ❌ FAILED ${safeTitle}.pdf`);
            } else {
                await new Promise(r => setTimeout(r, 1000 * attempts));
            }
        }
    }
}

async function downloadAllPdfs(pdfs) {
    console.log('\n━━━ STEP 3: DOWNLOADING PDFs ━━━');
    
    // Filter only those with valid URLs (excluding already downloaded)
    const validPdfs = pdfs.filter(p => p.rawPdfUrl && p.rawPdfUrl !== 'ALREADY_DOWNLOADED');
    
    if (validPdfs.length === 0) {
        console.log('❌ No valid PDF URLs found!');
        return;
    }

    console.log(`📋 Downloaded ${validPdfs.length} valid PDF links`);
    console.log(`🧵 Concurrency: ${CONFIG.concurrency}`);
    console.log(`📂 Output: ${CONFIG.downloadsDir}\n`);

    let cursor = 0;
    const total = validPdfs.length;

    async function worker() {
        while (cursor < total) {
            const i = cursor++;
            await downloadPdf(validPdfs[i], i, total);
        }
    }

    const workers = [];
    for (let w = 0; w < Math.min(CONFIG.concurrency, total); w++) {
        workers.push(worker());
    }

    const startTime = Date.now();
    await Promise.all(workers);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n✅ Downloaded ${total} PDFs in ${elapsed}s`);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN PIPELINE
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
    console.log('═══════════════════════════════════════════════════════════════════════════');
    console.log('                    GRAPHY UNIFIED PDF DOWNLOADER');
    console.log('                  (Auto-Fetching Webpage - No Dependencies)');
    console.log('═══════════════════════════════════════════════════════════════════════════');

    try {
        // Step 0: Fetch webpage (auto-generated, no need for external webpage.json)
        const pageHtml = await fetchWebpage();

        // Step 1: Extract PDFs from the fetched HTML
        const pdfs = extractPdfsFromHtmlString(pageHtml);
        if (pdfs.length === 0) {
            console.log('❌ No PDFs extracted. Exiting.');
            return;
        }

        // Step 2: Fetch URLs
        await fetchPdfUrls(pdfs);

        // Step 3: Download
        await downloadAllPdfs(pdfs);

        console.log('\n═══════════════════════════════════════════════════════════════════════════');
        console.log('🎉 COMPLETE! All steps finished successfully.');
        console.log('═══════════════════════════════════════════════════════════════════════════\n');

    } catch (err) {
        console.error('\n❌ ERROR:', err.message);
        process.exit(1);
    }
}

main();
