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
const CONCURRENT_DOWNLOADS = 5;
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

// ─── Batch Download with Concurrency ─────────────────────
async function downloadSegments(segments, baseUrl, keyHex, ivHex, segDir) {
  fs.mkdirSync(segDir, { recursive: true });
  let completed = 0;

  async function downloadOne(segName) {
    const outPath = path.join(segDir, segName);
    if (fs.existsSync(outPath)) {
      completed++;
      return;
    }

    const url = baseUrl + segName;
    const encrypted = await fetchBinary(url);
    const decrypted = decryptSegment(encrypted, keyHex, ivHex);
    fs.writeFileSync(outPath, decrypted);
    completed++;

    if (completed % 50 === 0 || completed === segments.length) {
      process.stdout.write(`\r    Progress: ${completed}/${segments.length} segments`);
    }
  }

  // Process in batches
  for (let i = 0; i < segments.length; i += CONCURRENT_DOWNLOADS) {
    const batch = segments.slice(i, i + CONCURRENT_DOWNLOADS);
    await Promise.all(batch.map(downloadOne));
  }
  console.log(`\r    Progress: ${completed}/${segments.length} segments ✓`);
}

function createConcatFile(segmentNames, segDir) {
  const concatFile = path.join(segDir, "concat.txt");
  const content = segmentNames
    .map((s) => `file '${path.join(segDir, s).replace(/\\/g, "/")}'`)
    .join("\n");
  fs.writeFileSync(concatFile, content);
  return concatFile;
}

// ─── Main Download Function ──────────────────────────────
async function downloadVideo(video, index, total) {
  const { videoId, title, keyHex, streamUrl } = video;
  const ivHex = video.ivHex || SHARED_IV;
  const section = video.section || "";

  console.log(`\n${"═".repeat(60)}`);
  console.log(`[${index + 1}/${total}] ${title}`);
  if (section) console.log(`  📁 Section: ${section}`);
  console.log(`  ID: ${videoId}`);
  console.log(`${"═".repeat(60)}`);

  if (!streamUrl || !keyHex) {
    console.log("  ⚠ Skipping — missing streamUrl or keyHex");
    return false;
  }

  const safeTitle = sanitizeFilename(title);
  const safeSection = section ? sanitizeFilename(section) : "";
  const videoDir = safeSection ? path.join(OUTPUT_DIR, safeSection) : OUTPUT_DIR;
  fs.mkdirSync(videoDir, { recursive: true });
  const outputFile = path.join(videoDir, `${safeTitle}.mp4`);

  if (fs.existsSync(outputFile)) {
    console.log(`  ⏭ Already downloaded: ${outputFile}`);
    return true;
  }

  // Extract base URL from stream URL
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

    // Step 3: Download video segments
    const tempDir = path.join(OUTPUT_DIR, ".temp", videoId);
    const videoDir = path.join(tempDir, "video");
    console.log("  ⬇️  Downloading video...");
    await downloadSegments(videoSegments, baseUrl, keyHex, ivHex, videoDir);

    // Binary-concat video segments into single .ts
    console.log("  🔗 Joining video segments...");
    const videoTsFile = path.join(tempDir, "video.ts");
    const videoOut = fs.createWriteStream(videoTsFile);
    for (const seg of videoSegments) {
      videoOut.write(fs.readFileSync(path.join(videoDir, seg)));
    }
    videoOut.end();
    await new Promise((r) => videoOut.on("finish", r));

    // Step 4: Download audio segments (if separate audio track exists)
    let audioTsFile = null;
    if (audioUri) {
      console.log(`  🔊 Audio track found: ${audioUri}`);
      const audioContent = await fetchText(baseUrl + audioUri);
      const audioSegments = parseM3u8Segments(audioContent);
      console.log(`  📦 Audio segments: ${audioSegments.length}`);

      const audioDir = path.join(tempDir, "audio");
      console.log("  ⬇️  Downloading audio...");
      await downloadSegments(audioSegments, baseUrl, keyHex, ivHex, audioDir);

      // Binary-concat audio segments into single .ts
      console.log("  🔗 Joining audio segments...");
      audioTsFile = path.join(tempDir, "audio.ts");
      const audioOut = fs.createWriteStream(audioTsFile);
      for (const seg of audioSegments) {
        audioOut.write(fs.readFileSync(path.join(audioDir, seg)));
      }
      audioOut.end();
      await new Promise((r) => audioOut.on("finish", r));
    } else {
      console.log("  🔊 No separate audio track (audio in video stream)");
    }

    // Step 5: Mux with ffmpeg
    console.log("  🔧 Muxing with ffmpeg...");
    if (audioTsFile) {
      // Mux video + audio with explicit stream mapping
      execSync(
        `ffmpeg -i "${videoTsFile}" -i "${audioTsFile}" -map 0:v -map 1:a -c copy -y "${outputFile}"`,
        { stdio: "ignore" }
      );
    } else {
      // Video only
      execSync(
        `ffmpeg -i "${videoTsFile}" -c copy -y "${outputFile}"`,
        { stdio: "ignore" }
      );
    }

    // Step 6: Verify output
    const stats = fs.statSync(outputFile);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
    console.log(`  ✅ Saved: ${outputFile} (${sizeMB} MB)`);

    // Cleanup temp
    fs.rmSync(path.join(OUTPUT_DIR, ".temp", videoId), { recursive: true, force: true });
    return true;
  } catch (err) {
    console.error(`  ❌ Error: ${err.message}`);
    return false;
  }
}

// ─── Entry Point ─────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║     Dnyandeep Video Downloader           ║");
  console.log("╚══════════════════════════════════════════╝\n");

  // Load video list from JSON file (arg) or default
  const inputFile = process.argv[2] || "videos_to_download.json";

  if (!fs.existsSync(inputFile)) {
    console.log(`Usage: node dnyandeep_downloader.js <videos.json>\n`);
    console.log(`Expected JSON format:`);
    console.log(`[`);
    console.log(`  {`);
    console.log(`    "videoId": "abc123",`);
    console.log(`    "title": "Video Title",`);
    console.log(`    "keyHex": "16-byte-hex-key",`);
    console.log(`    "streamUrl": "https://qcdn.spayee.in/.../index.m3u8"`);
    console.log(`  }`);
    console.log(`]`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(inputFile, "utf-8"));
  const videos = Array.isArray(data) ? data : data.videos || [data];

  console.log(`Loaded ${videos.length} video(s) from ${inputFile}`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(OUTPUT_DIR, ".temp"), { recursive: true });

  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < videos.length; i++) {
    const result = await downloadVideo(videos[i], i, videos.length);
    if (result === true) success++;
    else if (result === false) failed++;
    else skipped++;
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`Done! ✅ ${success} downloaded, ❌ ${failed} failed, ⏭ ${skipped} skipped`);
  console.log(`Output: ${OUTPUT_DIR}`);
}

main().catch(console.error);
