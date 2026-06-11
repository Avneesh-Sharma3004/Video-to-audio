# 🎵 YouTube Audio API

Stream and download YouTube audio — no API keys, no headless browser, no Google account.

Powers [InnerTube](https://tyrrrz.me/blog/reverse-engineering-youtube-revisited) for metadata/search and [yt-dlp](https://github.com/yt-dlp/yt-dlp) for actual audio delivery.

## Install

```bash
npm install
pip install yt-dlp    # required for streaming/downloading
```

## Usage

### Server

```bash
node server.js        # → http://localhost:3000
```

Endpoints:

| Endpoint | Example |
|---|---|
| **Search** | `GET /api/search?q=chill+lofi&limit=5` |
| **Video info** | `GET /api/video/dQw4w9WgXcQ` |
| **Stream audio** | `GET /api/stream/dQw4w9WgXcQ/140` |

```bash
# Search
curl "http://localhost:3000/api/search?q=study+lofi" | jq

# Get metadata + audio stream list
curl "http://localhost:3000/api/video/dQw4w9WgXcQ" | jq

# Download audio (AAC 128kbps)
curl "http://localhost:3000/api/stream/dQw4w9WgXcQ/140" -o song.m4a

# Or Opus ~160kbps
curl "http://localhost:3000/api/stream/dQw4w9WgXcQ/251" -o song.webm
```

### CLI

```bash
node cli.js search "study lofi"         # Search
node cli.js info dQw4w9WgXcQ           # Video info + audio streams
node cli.js download dQw4w9WgXcQ 140   # Download AAC 128k
node cli.js stream dQw4w9WgXcQ 251     # Stream Opus to stdout
```

## Audio formats

| itag | Codec | Bitrate | Container |
|------|-------|---------|-----------|
| 251 | Opus | ~160 kbps | webm |
| 140 | AAC | 128 kbps | m4a |
| 250 | Opus | ~70 kbps | webm |
| 249 | Opus | ~50 kbps | webm |
| 139 | AAC HE | 48 kbps | m4a |

## How it works

1. **Metadata & search** → YouTube's private InnerTube API. No keys needed — extracted from YouTube's own pages.
2. **Audio streaming** → yt-dlp handles YouTube's `n`-param cipher and serves clean audio.

No quota limits. No browser automation. Just works™.

## Web Player

A full music player frontend is included at `player.html`:

```bash
node server.js
# Open http://localhost:3000/player.html
```

- Search YouTube for music
- Click any track → streams instantly (no download, direct `<audio>` playback)
- Quality selector: AAC 128k / Opus 160k / Opus 70k
- Now-playing bar with play/pause

## Use as a music app backend

The API is a drop-in backend for any music player — web, Electron, React Native, or desktop.

```js
// Search
const res = await fetch('http://localhost:3000/api/search?q=chill+lofi&limit=10');
const { results } = await res.json();
// results[i] = { videoId, title, author, lengthText, thumbnails, url }

// Play (just set as audio source — streams directly, no download)
const audio = new Audio();
audio.src = `http://localhost:3000/api/stream/${results[0].videoId}/140`;
audio.play();

// Get metadata
const info = await fetch(`http://localhost:3000/api/video/${videoId}`).then(r => r.json());
// info = { title, author, duration, audioStreams: [{ itag, bitrate, url, ... }], ... }
```

Works the same as any paid music API — search, metadata, streaming URLs — without keys or quotas.
