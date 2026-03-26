/**
 * Dnyandeep Key Collector
 * 
 * Fetches course page to get all video IDs, then starts an HTTP server
 * on port 3001 to receive decrypted keys from the browser extension.
 * 
 * Usage:
 *   1. node fetch1.js
 *   2. Open the Graphy course page in Chrome (with extension loaded)
 *   3. Play each video — keys are captured automatically
 *   4. course_data.json is updated in real-time
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { BASE_URL, COURSE_ID, PAGE_HEADERS, API_HEADERS } = require("./auth");

const COURSE_URL = `${BASE_URL}/s/courses/${COURSE_ID}/take`;
const PORT = 3001;
const OUTPUT_FILE = "course_data.json";
const VIDEO_LIMIT = 10; // limit API fetch to first N videos (server still accepts all keys)

// ─── Debug Logger ───

const DEBUG = true;
function log(...args) { console.log(`[${new Date().toLocaleTimeString()}]`, ...args); }
function debug(...args) { if (DEBUG) console.log(`  [DEBUG ${new Date().toLocaleTimeString()}]`, ...args); }

// ─── HTTPS fetch helpers ───

function fetchPage(url, depth = 0) {
  if (depth > 5) return Promise.reject(new Error("Too many redirects"));
  return new Promise((resolve, reject) => {
    debug(`fetchPage → GET ${url} (redirect depth: ${depth})`);
    const startTime = Date.now();

    https.get(url, { headers: PAGE_HEADERS }, (res) => {
      debug(`fetchPage ← status: ${res.statusCode}, headers: content-type=${res.headers["content-type"]}`);

      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redir = res.headers.location;
        if (redir.startsWith("/")) redir = BASE_URL + redir;
        debug(`fetchPage → redirect to: ${redir}`);
        res.resume();
        return fetchPage(redir, depth + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }

      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        debug(`fetchPage ← received ${body.length} chars in ${Date.now() - startTime}ms`);
        resolve(body);
      });
      res.on("error", reject);
    }).on("error", (e) => {
      debug(`fetchPage ← ERROR: ${e.message}`);
      reject(e);
    });
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    debug(`fetchJson → GET ${url.substring(0, 100)}`);
    const startTime = Date.now();

    https.get(url, { headers: API_HEADERS }, (res) => {
      debug(`fetchJson ← status: ${res.statusCode}`);
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        debug(`fetchJson ← ${raw.length} chars in ${Date.now() - startTime}ms`);
        try { resolve(JSON.parse(raw)); }
        catch (e) {
          debug(`fetchJson ← JSON PARSE ERROR: ${e.message}, raw: ${raw.substring(0, 200)}`);
          reject(e);
        }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ─── HTML parsing ───

function extractVideoIds(html) {
  debug(`extractVideoIds → parsing HTML (${html.length} chars)...`);
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const videos = [];

  // Try section-based extraction first
  const sections = doc.querySelectorAll(".courseSubSection");
  debug(`extractVideoIds → found ${sections.length} .courseSubSection elements`);

  sections.forEach((sec, si) => {
    const sectionTitle = sec.querySelector(".sectionTitle")?.textContent?.trim() || `Section ${si + 1}`;
    const vidEls = sec.querySelectorAll('[data-type="video"][data-id]');
    debug(`  Section "${sectionTitle.substring(0, 40)}": ${vidEls.length} videos`);

    vidEls.forEach((el) => {
      const id = el.getAttribute("data-id");
      const title = el.getAttribute("data-title") || "";
      if (id) videos.push({ id, title, section: sectionTitle });
    });
  });

  // Fallback: if no sections found, just get all video elements
  if (videos.length === 0) {
    debug(`extractVideoIds → no sections found, using fallback selector`);
    const allVids = doc.querySelectorAll('[data-type="video"][data-id]');
    debug(`extractVideoIds → fallback found ${allVids.length} video elements`);
    allVids.forEach((el) => {
      const id = el.getAttribute("data-id");
      const title = el.getAttribute("data-title") || "";
      if (id) videos.push({ id, title, section: "" });
    });
  }

  debug(`extractVideoIds → total: ${videos.length} videos extracted`);
  return videos;
}

// ─── Extract videoId from a streamUrl ───
// e.g. .../v/696dc32f2282ab09399b3ccd/u/... → 696dc32f2282ab09399b3ccd
function extractVideoIdFromStreamUrl(streamUrl) {
  const m = streamUrl.match(/\/v\/([a-f0-9]{24})\//);
  const result = m ? m[1] : null;
  debug(`extractVideoIdFromStreamUrl("...${streamUrl.slice(-40)}") → ${result}`);
  return result;
}

// ─── State ───

let courseData = {
  courseId: COURSE_ID,
  fetchedAt: null,
  totalVideos: 0,
  keysCollected: 0,
  videos: [],
};

function saveData() {
  courseData.keysCollected = courseData.videos.filter((v) => v.decryptedKeyHex).length;
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(courseData, null, 2), "utf-8");
  debug(`saveData → wrote ${OUTPUT_FILE} (${courseData.keysCollected}/${courseData.totalVideos} keys)`);
}

// ─── HTTP Server ───

function startServer() {
  const server = http.createServer((req, res) => {
    debug(`HTTP ${req.method} ${req.url} from ${req.socket.remoteAddress}`);

    // CORS headers for extension
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      debug(`  → CORS preflight, responding 204`);
      res.writeHead(204);
      return res.end();
    }

    // POST /api/download-live-video — receive key from extension
    if (req.method === "POST" && req.url === "/api/download-live-video") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        debug(`  → POST body (${body.length} chars): ${body.substring(0, 200)}`);
        try {
          const payload = JSON.parse(body);
          const { title, keyHex, ivHex, streamUrl } = payload;

          debug(`  → Payload parsed:`);
          debug(`    title:     "${title}"`);
          debug(`    keyHex:    ${keyHex}`);
          debug(`    ivHex:     ${ivHex}`);
          debug(`    streamUrl: ${streamUrl?.substring(0, 80)}...`);

          // Extract videoId from the stream URL
          const videoId = extractVideoIdFromStreamUrl(streamUrl || "");

          if (!videoId || !keyHex) {
            log(`  ❌ Missing videoId or keyHex — videoId=${videoId}, keyHex=${keyHex}`);
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Missing videoId or keyHex" }));
          }

          // Find matching video in our list
          const video = courseData.videos.find((v) => v.videoId === videoId);
          if (video) {
            const wasNew = !video.decryptedKeyHex;
            video.decryptedKeyHex = keyHex;
            video.ivHex = ivHex || "";
            video.streamUrl = streamUrl || video.streamUrl;
            saveData();

            const collected = courseData.videos.filter((v) => v.decryptedKeyHex).length;
            if (wasNew) {
              log(`✅ NEW KEY: "${video.title}" (${videoId})`);
            } else {
              log(`🔄 KEY UPDATED: "${video.title}" (${videoId})`);
            }
            log(`   Key: ${keyHex}`);
            log(`   Progress: ${collected}/${courseData.totalVideos} videos`);
            
            if (collected === courseData.totalVideos) {
              log(`\n🎉🎉🎉 ALL KEYS COLLECTED! Run dnyandeep_downloader.js to download. 🎉🎉🎉\n`);
            }
          } else {
            // Unknown video — still save it as a new entry
            debug(`  → Video ${videoId} not in our list, adding as new entry`);
            courseData.videos.push({
              videoId,
              title: title || "Unknown",
              section: "",
              streamUrl: streamUrl || "",
              mp4Link: "",
              totalTime: 0,
              decryptedKeyHex: keyHex,
              ivHex: ivHex || "",
            });
            courseData.totalVideos = courseData.videos.length;
            saveData();
            log(`🆕 Unknown video added: "${title}" (${videoId}) — Key: ${keyHex}`);
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", videoId }));
        } catch (err) {
          log(`❌ Error processing POST: ${err.message}`);
          debug(`  → Stack: ${err.stack}`);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // GET /status — show progress
    if (req.method === "GET" && req.url === "/status") {
      const collected = courseData.videos.filter((v) => v.decryptedKeyHex).length;
      const missing = courseData.videos
        .filter((v) => !v.decryptedKeyHex)
        .map((v) => ({ videoId: v.videoId, title: v.title }));
      debug(`  → /status: ${collected}/${courseData.totalVideos} collected, ${missing.length} missing`);

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ total: courseData.totalVideos, collected, missing }, null, 2));
    }

    debug(`  → 404 Not Found: ${req.method} ${req.url}`);
    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(PORT, () => {
    log(`\n🌐 Key collection server running on http://localhost:${PORT}`);
    log(`   Status page: http://localhost:${PORT}/status`);
    log(`\n📋 Instructions:`);
    log(`   1. Make sure Graphy Key Logger extension is loaded in Chrome`);
    log(`   2. Open the course page: ${COURSE_URL}`);
    log(`   3. Click on each video to play it`);
    log(`   4. Keys are captured and saved automatically to ${OUTPUT_FILE}`);
    log(`   5. Press Ctrl+C when done\n`);
    log(`⏳ Waiting for keys from extension...\n`);
  });
}

// ─── Fetch stream URLs for videos ───

async function fetchStreamUrls(videos, limit) {
  const toFetch = limit ? videos.slice(0, limit) : videos;
  log(`\nStep 3: Fetching stream URLs for ${toFetch.length}/${videos.length} videos (limit: ${limit || 'none'})...`);
  let successCount = 0, failCount = 0;

  for (let i = 0; i < toFetch.length; i++) {
    const v = toFetch[i];
    try {
      const apiUrl = `${BASE_URL}/s/courses/${COURSE_ID}/videos/${v.videoId}/get`;
      const data = await fetchJson(apiUrl);
      const res = data["spayee:resource"] || {};
      v.streamUrl = res["spayee:streamUrl"] || "";
      v.mp4Link = res["spayee:uploadVideoMP4Link"] || "";
      v.totalTime = res["spayee:totalTime"] || 0;
      const titleApi = res["spayee:title"];
      if (titleApi) v.title = titleApi;
      successCount++;
      debug(`  [${i + 1}/${toFetch.length}] ✓ "${v.title.substring(0, 40)}" stream=${v.streamUrl ? "YES" : "NO"}`);
    } catch (err) {
      failCount++;
      debug(`  [${i + 1}/${toFetch.length}] ✗ ${v.videoId}: ${err.message}`);
    }
    // Small delay to avoid rate limiting
    if (i < toFetch.length - 1) await new Promise((r) => setTimeout(r, 300));
  }
  log(`  Done: ${successCount} success, ${failCount} failed\n`);
}

// ─── Main ───

async function main() {
  try {
    log("═══════════════════════════════════════════════════");
    log("  Dnyandeep Key Collector v2.0");
    log("═══════════════════════════════════════════════════\n");

    // Step 1: Fetch course page
    log("Step 1: Fetching course page...");
    debug(`  URL: ${COURSE_URL}`);
    const html = await fetchPage(COURSE_URL);
    log(`  ✓ Fetched ${html.length} characters\n`);

    if (html.length < 5000) {
      log("❌ Session expired! HTML too short (probably a login redirect).");
      log("   Update COOKIE in auth.js with a fresh SESSIONID from your browser.");
      debug(`  First 500 chars of response: ${html.substring(0, 500)}`);
      process.exit(1);
    }

    // Step 2: Extract video IDs
    log("Step 2: Extracting video IDs from HTML...");
    const videoList = extractVideoIds(html);
    log(`  ✓ Found ${videoList.length} videos\n`);

    if (videoList.length === 0) {
      log("❌ No videos found in the page HTML!");
      debug(`  Check if the HTML contains data-type="video" elements`);
      process.exit(1);
    }

    // Print video list
    debug(`  Video list:`);
    videoList.forEach((v, i) => {
      debug(`    ${i + 1}. [${v.id}] ${v.title.substring(0, 50)}`);
    });

    // Load existing course_data.json if it exists (to preserve already-collected keys)
    let existingKeys = {};
    try {
      const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8"));
      if (existing.videos) {
        existing.videos.forEach((v) => {
          if (v.decryptedKeyHex) existingKeys[v.videoId] = { key: v.decryptedKeyHex, iv: v.ivHex || "" };
        });
        log(`  ✓ Loaded ${Object.keys(existingKeys).length} existing keys from ${OUTPUT_FILE}`);
        debug(`  Existing keys: ${Object.keys(existingKeys).join(", ")}`);
      }
    } catch (e) {
      debug(`  No existing ${OUTPUT_FILE} found (${e.message})`);
    }

    // Build video entries
    courseData.fetchedAt = new Date().toISOString();
    courseData.totalVideos = videoList.length;
    courseData.videos = videoList.map((v) => ({
      videoId: v.id,
      title: v.title,
      section: v.section,
      streamUrl: "",
      mp4Link: "",
      totalTime: 0,
      decryptedKeyHex: existingKeys[v.id]?.key || "",
      ivHex: existingKeys[v.id]?.iv || "",
    }));

    // Step 3: Fetch stream URLs from API
    await fetchStreamUrls(courseData.videos, VIDEO_LIMIT);

    // Save initial data
    saveData();
    const alreadyHaveKeys = courseData.videos.filter((v) => v.decryptedKeyHex).length;
    const withStreams = courseData.videos.filter((v) => v.streamUrl).length;
    log(`📊 Summary:`);
    log(`   Total videos:    ${courseData.totalVideos}`);
    log(`   With stream URL: ${withStreams}`);
    log(`   Keys collected:  ${alreadyHaveKeys}/${courseData.totalVideos}`);

    if (alreadyHaveKeys === courseData.totalVideos) {
      log(`\n🎉 All keys already collected! Run dnyandeep_downloader.js to download.`);
      return;
    }

    // Step 4: Start server to receive keys
    log("\nStep 4: Starting key collection server...");
    startServer();
  } catch (err) {
    log(`\n❌ Fatal error: ${err.message}`);
    debug(`Stack: ${err.stack}`);
    process.exit(1);
  }
}

main();
