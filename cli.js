#!/usr/bin/env node

/**
 * CLI: YouTube Audio Downloader/Player
 *
 * Usage:
 *   node cli.js info <video-id-or-url>             # Show video info + audio streams
 *   node cli.js search <query>                      # Search YouTube
 *   node cli.js stream <video-id-or-url> [itag]     # Stream audio to stdout (requires yt-dlp)
 *   node cli.js download <video-id-or-url> [itag]   # Download audio to file (requires yt-dlp)
 */

const { spawn, execSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const {
  getVideoInfo,
  search,
  extractVideoId,
} = require('./lib/innerTube');

// ─── Helpers ─────────────────────────────────

function checkYtdlp() {
  try {
    execSync('yt-dlp --version', { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function streamOrDownload(mode, videoIdOrUrl, itag) {
  const ytUrl = videoIdOrUrl.includes('youtube.com') || videoIdOrUrl.includes('youtu.be')
    ? videoIdOrUrl
    : `https://www.youtube.com/watch?v=${videoIdOrUrl}`;

  const format = itag ? String(itag) : '140/251/250/249/139/bestaudio';
  const args = ['-f', format, ...(mode === 'stream' ? ['-o', '-'] : []), '--no-playlist', ytUrl];

  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args, {
      stdio: mode === 'stream' ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });

    if (mode === 'stream') {
      proc.stdout.pipe(process.stdout);
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`yt-dlp exited with code ${code}`));
        } else {
          resolve();
        }
      });
    } else {
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`yt-dlp exited with code ${code}`));
      });
    }

    proc.on('error', reject);
  });
}

// ─── Main ────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const input = args[1];
  const option = args[2];

  if (!command || !input) {
    console.log(`
  🎵 YouTube Audio API CLI

  Commands:
    info <id-or-url>                Show video metadata + audio stream list
    search <query>                  Search YouTube
    stream <id-or-url> [itag]       Stream audio to stdout (needs yt-dlp)
    download <id-or-url> [itag]     Download audio to file (needs yt-dlp)

  Audio itags: 140=AAC128k 251=Opus160k 250=Opus70k 249=Opus50k 139=AAC48k

  Requirements: pip install yt-dlp (for stream/download commands)
    `);
    process.exit(0);
  }

  try {
    if (command === 'info') {
      const videoId = extractVideoId(input) || input;
      const info = await getVideoInfo(videoId);

      console.log(`
  ╔══════════════════════════════════════╗
  ║  📺 Video Info
  ╚══════════════════════════════════════╝
  Title:        ${info.title}
  Author:       ${info.author}
  Duration:     ${info.lengthSeconds}s (${Math.floor(info.lengthSeconds / 60)}:${String(info.lengthSeconds % 60).padStart(2, '0')})
  Views:        ${info.viewCount.toLocaleString()}
  Video ID:     ${info.videoId}

  🎧 Audio Streams:
  `);

      for (const stream of info.audioStreams) {
        const size = stream.contentLength
          ? `(${(stream.contentLength / 1024 / 1024).toFixed(1)}MB)`
          : '';
        console.log(
          `  ✅ itag:${String(stream.itag).padEnd(5)} ${stream.audioBitrate.padEnd(12)} ${stream.mimeType.split(';')[0].padEnd(20)} ${size}`
        );
      }

      console.log(`
  🚀 Stream:   node cli.js stream ${info.videoId} 251
  📥 Download: node cli.js download ${info.videoId} 140
    `);

    } else if (command === 'search') {
      const results = await search(input, 10);
      console.log(`\n  🔍 "${input}":\n`);
      for (const r of results) {
        console.log(`  ${r.videoId}  |  ${r.title}`);
        console.log(`             ${r.author}  ${r.lengthText}  ${r.viewCountText}\n`);
      }

    } else if (command === 'stream') {
      if (!checkYtdlp()) {
        console.error('❌ yt-dlp not found. Install it: pip install yt-dlp');
        process.exit(1);
      }
      console.error(`  🎧 Streaming...`);
      await streamOrDownload('stream', input, option);

    } else if (command === 'download') {
      if (!checkYtdlp()) {
        console.error('❌ yt-dlp not found. Install it: pip install yt-dlp');
        process.exit(1);
      }
      console.error(`  📥 Downloading...`);
      await streamOrDownload('download', input, option);
      console.log(`  ✅ Done.`);

    } else {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`\n  ❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main();
