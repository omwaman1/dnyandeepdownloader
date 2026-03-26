#!/usr/bin/env node
/**
 * Dnyandeep Downloader
 * Downloads and decrypts HLS videos from Graphy/Spayee CDN
 * 
 * Usage:
 *   node dnyandeep_downloader.js <course_data.json>
 * 
 * The course_data.json should contain an array of videos with:
 *   { videoId, title, keyHex, ivHex, streamUrl }
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

// ─── Config ──────────────────────────────────────────────
const SHARED_IV = "496daa1c6914000e408c65cead91fc29";
const CONCURRENT_DOWNLOADS = 64;
const OUTPUT_DIR = path.join(__dirname, "..", "downloads");

const CDN_HEADERS = {
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  origin: "https://dnyanadeepsaralseva.graphy.com",
  referer: "https://dnyanadeepsaralseva.graphy.com/",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
};

// ─── Helpers ─────────────────────────────────────────────
function fetchBinary(url, retries = 3) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: CDN_HEADERS }, (res) => {
      if (res.statusCode === 403 && retries > 0) {
        res.resume();
        return setTimeout(() => fetchBinary(url, retries - 1).then(resolve).catch(reject), 1000);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", (err) => {
      if (retries > 0) setTimeout(() => fetchBinary(url, retries - 1).then(resolve).catch(reject), 1000);
      else reject(err);
    });
  });
}

function fetchText(url) {
  return fetchBinary(url).then((buf) => buf.toString("utf-8"));
}

function decryptSegment(data, keyHex, ivHex) {
  const key = Buffer.from(keyHex, "hex");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, "_").replace(/\s+/g, " ").trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── M3U8 Parsing ────────────────────────────────────────
function parseM3u8Segments(content) {
  return content.split("\n").filter((l) => l.trim().endsWith(".ts")).map((l) => l.trim());
}

function parseM3u8Variants(content) {
  const lines = content.split("\n");
  const variants = [];
  let audioUri = null;

  for (let i = 0; i < lines.length; i++) {
    // Parse audio track: #EXT-X-MEDIA:TYPE=AUDIO,...,URI="hls_audio_.m3u8"
    if (lines[i].includes("EXT-X-MEDIA") && lines[i].includes("TYPE=AUDIO")) {
      const uriMatch = lines[i].match(/URI="([^"]+)"/);
      if (uriMatch) audioUri = uriMatch[1];
    }
    // Parse video variants
    if (lines[i].startsWith("#EXT-X-STREAM-INF:")) {
      const info = lines[i];
      const uri = lines[i + 1]?.trim();
      const resMatch = info.match(/RESOLUTION=(\d+)x(\d+)/);
      const bwMatch = info.match(/BANDWIDTH=(\d+)/);
      variants.push({
        uri,
        width: resMatch ? parseInt(resMatch[1]) : 0,
        height: resMatch ? parseInt(resMatch[2]) : 0,
        bandwidth: bwMatch ? parseInt(bwMatch[1]) : 0,
      });
    }
  }
  return { variants, audioUri };
}

// ─── Worker Queue Download (64 workers, no idle time) ────
async function downloadSegments(segments, baseUrl, keyHex, ivHex, segDir) {
  fs.mkdirSync(segDir, { recursive: true });
  let completed = 0;
  let totalBytes = 0;
  let queueIndex = 0;
  const startTime = Date.now();

  function showProgress() {
    const pct = Math.round((completed / segments.length) * 100);
    const elapsed = (Date.now() - startTime) / 1000;
    const speed = elapsed > 0 ? (totalBytes / 1024 / 1024 / elapsed).toFixed(1) : '0.0';
    const bar = '█'.repeat(Math.floor(pct / 2.5)) + '░'.repeat(40 - Math.floor(pct / 2.5));
    process.stdout.write(`\r    [${bar}] ${pct}% (${completed}/${segments.length}) ${speed} MB/s`);
  }

  // Each worker pulls next segment from queue immediately after finishing
  async function worker() {
    while (true) {
      const idx = queueIndex++;
      if (idx >= segments.length) break;

      const segName = segments[idx];
      const outPath = path.join(segDir, segName);

      if (fs.existsSync(outPath)) {
        totalBytes += fs.statSync(outPath).size;
        completed++;
        showProgress();
        continue;
      }

      const url = baseUrl + segName;
      const encrypted = await fetchBinary(url);
      const decrypted = decryptSegment(encrypted, keyHex, ivHex);
      fs.writeFileSync(outPath, decrypted);
      totalBytes += decrypted.length;
      completed++;
      showProgress();
    }
  }

  // Spawn 64 workers — each grabs next segment from queue as soon as it's free
  const workers = Array.from({ length: CONCURRENT_DOWNLOADS }, () => worker());
  await Promise.all(workers);

  const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\r    ✅ ${segments.length} segments (${totalMB} MB) in ${totalTime}s                    `);
}

function createConcatFile(segmentNames, segDir) {
  const concatFile = path.join(segDir, "concat.txt");
  const content = segmentNames
    .map((s) => `file '${path.join(segDir, s).replace(/\\/g, "/")}'`)
    .join("\n");
  fs.writeFileSync(concatFile, content);
  return concatFile;
}

// ─── Main Download Function (returns mux promise for pipelining) ──
async function downloadVideo(video, index, total) {
  const { videoId, title, keyHex, streamUrl } = video;
  const ivHex = video.ivHex || SHARED_IV;
  const section = video.section || "";

  console.log(`\n${"═".repeat(60)}`);
  console.log(`[${index + 1}/${total}] ${title}`);
  if (section) console.log(`  📁 Section: ${section}`);
  if (video.subSection) console.log(`  📂 SubSection: ${video.subSection}`);
  console.log(`  ID: ${videoId}`);
  console.log(`${"═".repeat(60)}`);

  if (!streamUrl || !keyHex) {
    console.log("  ⚠ Skipping — missing streamUrl or keyHex");
    return { status: "skipped" };
  }

  const safeTitle = sanitizeFilename(title);
  const safeSection = section ? sanitizeFilename(section) : "";
  const safeSubSection = (video.subSection || "") ? sanitizeFilename(video.subSection) : "";
  
  // Build nested folder: downloads / section / subSection
  let outDir = OUTPUT_DIR;
  if (safeSection) outDir = path.join(outDir, safeSection);
  if (safeSubSection) outDir = path.join(outDir, safeSubSection);
  fs.mkdirSync(outDir, { recursive: true });
  const outputFile = path.join(outDir, `${safeTitle}.mp4`);

  if (fs.existsSync(outputFile)) {
    console.log(`  ⏭ Already downloaded: ${outputFile}`);
    return { status: "success" };
  }

  const baseUrl = streamUrl.replace(/index\.m3u8$/, "");

  try {
    // Step 1: Fetch master m3u8
    console.log("  📋 Fetching master playlist...");
    const masterContent = await fetchText(streamUrl);
    const { variants, audioUri } = parseM3u8Variants(masterContent);

    // Step 2: Pick video variant
    let videoSegments;
    if (variants.length > 0) {
      const v480 = variants.find((v) => v.height === 480);
      const chosen = v480 || variants.sort((a, b) => a.bandwidth - b.bandwidth)[0];
      console.log(`  🎬 Video: ${chosen.width}x${chosen.height} (${chosen.bandwidth} bps)`);
      const variantContent = await fetchText(baseUrl + chosen.uri);
      videoSegments = parseM3u8Segments(variantContent);
    } else {
      videoSegments = parseM3u8Segments(masterContent);
    }
    console.log(`  📦 Video segments: ${videoSegments.length}`);

    // Step 3: Download video segments (64 parallel workers)
    const tempDir = path.join(OUTPUT_DIR, ".temp", videoId);
    const vidSegDir = path.join(tempDir, "video");
    console.log("  ⬇️  Downloading video...");
    await downloadSegments(videoSegments, baseUrl, keyHex, ivHex, vidSegDir);

    // Binary-concat video segments
    console.log("  🔗 Joining video segments...");
    const videoTsFile = path.join(tempDir, "video.ts");
    const videoOut = fs.createWriteStream(videoTsFile);
    for (const seg of videoSegments) {
      videoOut.write(fs.readFileSync(path.join(vidSegDir, seg)));
    }
    videoOut.end();
    await new Promise((r) => videoOut.on("finish", r));

    // Step 4: Download audio (if separate track)
    let audioTsFile = null;
    if (audioUri) {
      console.log(`  🔊 Audio track found: ${audioUri}`);
      const audioContent = await fetchText(baseUrl + audioUri);
      const audioSegments = parseM3u8Segments(audioContent);
      console.log(`  📦 Audio segments: ${audioSegments.length}`);

      const audioSegDir = path.join(tempDir, "audio");
      console.log("  ⬇️  Downloading audio...");
      await downloadSegments(audioSegments, baseUrl, keyHex, ivHex, audioSegDir);

      console.log("  🔗 Joining audio segments...");
      audioTsFile = path.join(tempDir, "audio.ts");
      const audioOut = fs.createWriteStream(audioTsFile);
      for (const seg of audioSegments) {
        audioOut.write(fs.readFileSync(path.join(audioSegDir, seg)));
      }
      audioOut.end();
      await new Promise((r) => audioOut.on("finish", r));
    } else {
      console.log("  🔊 No separate audio track (audio in video stream)");
    }

    // Step 5: Start mux in BACKGROUND (returns promise, doesn't block)
    console.log("  🔧 Muxing in background...");
    const muxPromise = muxAsync(videoTsFile, audioTsFile, outputFile, videoId, title);
    return { status: "muxing", muxPromise };

  } catch (err) {
    console.error(`  ❌ Error: ${err.message}`);
    return { status: "failed" };
  }
}

// ─── Non-blocking ffmpeg mux ─────────────────────────────
function muxAsync(videoTsFile, audioTsFile, outputFile, videoId, title) {
  const { spawn } = require("child_process");
  return new Promise((resolve) => {
    let args;
    if (audioTsFile) {
      args = ["-i", videoTsFile, "-i", audioTsFile, "-map", "0:v", "-map", "1:a", "-c", "copy", "-y", outputFile];
    } else {
      args = ["-i", videoTsFile, "-c", "copy", "-y", outputFile];
    }

    const proc = spawn("ffmpeg", args, { stdio: "ignore" });
    proc.on("close", (code) => {
      if (code === 0 && fs.existsSync(outputFile)) {
        const sizeMB = (fs.statSync(outputFile).size / 1024 / 1024).toFixed(1);
        console.log(`  ✅ Muxed: ${title} (${sizeMB} MB)`);
        fs.rmSync(path.join(OUTPUT_DIR, ".temp", videoId), { recursive: true, force: true });
        resolve(true);
      } else {
        console.error(`  ❌ Mux failed: ${title}`);
        resolve(false);
      }
    });
    proc.on("error", () => {
      console.error(`  ❌ ffmpeg not found or error: ${title}`);
      resolve(false);
    });
  });
}

// ─── Entry Point: Pipelined download + mux ───────────────
async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║     Dnyandeep Video Downloader               ║");
  console.log("║     64-thread workers | pipelined mux         ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  const inputFile = process.argv[2] || "videos_to_download.json";

  if (!fs.existsSync(inputFile)) {
    console.log(`Usage: node dnyandeep_downloader.js <videos.json>\n`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(inputFile, "utf-8"));
  const videos = Array.isArray(data) ? data : data.videos || [data];
  console.log(`Loaded ${videos.length} video(s) from ${inputFile}`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(OUTPUT_DIR, ".temp"), { recursive: true });

  let success = 0, failed = 0, skipped = 0;
  let pendingMux = null;

  for (let i = 0; i < videos.length; i++) {
    const result = await downloadVideo(videos[i], i, videos.length);

    if (result.status === "muxing") {
      // Wait for PREVIOUS mux before starting next download
      if (pendingMux) {
        if (await pendingMux) success++; else failed++;
      }
      // Current mux runs in background while next video downloads
      pendingMux = result.muxPromise;
    } else if (result.status === "success") {
      success++;
    } else if (result.status === "skipped") {
      skipped++;
    } else {
      failed++;
    }
  }

  // Wait for final mux to complete
  if (pendingMux) {
    if (await pendingMux) success++; else failed++;
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`Done! ✅ ${success} downloaded, ❌ ${failed} failed, ⏭ ${skipped} skipped`);
  console.log(`Output: ${OUTPUT_DIR}`);
}

main().catch(console.error);
