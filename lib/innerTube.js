/**
 * YouTube InnerTube API client — no API key required.
 * Impersonates the Android YouTube client to get clean stream URLs.
 */

const https = require('https');
const http = require('http');

// Hardcoded InnerTube API key (public, extracted from YouTube's own web client)
const INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

// Alternative keys that also work
const FALLBACK_KEYS = [
  'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
  'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
];

// ANDROID client — no PO token needed
// Note: some stream URLs may need n-param transform for actual download
const CLIENT_CONTEXT = {
  client: {
    clientName: 'ANDROID',
    clientVersion: '20.10.38',
    androidSdkVersion: 33,
    hl: 'en',
    gl: 'US',
    utcOffsetMinutes: 0,
  },
};

// User-Agent matching the Android client
const USER_AGENT =
  'com.google.android.youtube/20.10.38 (Linux; U; Android 13; US) gzip';

/**
 * Parse a video ID from various YouTube URL formats or a raw ID
 */
function extractVideoId(input) {
  // Already a plain ID (11 chars, alphanumeric + _ -)
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) {
    return input;
  }
  // youtu.be/VIDEO_ID
  let match = input.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (match) return match[1];
  // youtube.com/watch?v=VIDEO_ID
  match = input.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (match) return match[1];
  // youtube.com/embed/VIDEO_ID
  match = input.match(/\/embed\/([A-Za-z0-9_-]{11})/);
  if (match) return match[1];
  // youtube.com/shorts/VIDEO_ID
  match = input.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
  if (match) return match[1];
  return null;
}

/**
 * Extract playlist ID from URL
 */
function extractPlaylistId(input) {
  if (/^[A-Za-z0-9_-]{34}$/.test(input)) return input;
  const match = input.match(/[?&]list=([A-Za-z0-9_-]{34})/);
  return match ? match[1] : null;
}

/**
 * Make an HTTPS POST request
 */
function hpost(urlString, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const data = JSON.stringify(body);

    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      family: 4, // Force IPv4 so stream URL IPs match
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Make an HTTPS GET request
 */
function hget(urlString, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const mod = url.protocol === 'https:' ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      family: 4, // Force IPv4
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...headers,
      },
    };

    const req = mod.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, data: body }));
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Fetch the InnerTube API key by scraping a YouTube video page.
 * Uses multiple fallback strategies.
 */
async function fetchApiKey() {
  // Try extracting from YouTube's main page first
  try {
    const { data } = await hget('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    // Look for "INNERTUBE_API_KEY":"..."
    const match = data.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
    if (match && match[1]) {
      return match[1];
    }
    // Look for "innertubeApiKey":"..."
    const match2 = data.match(/"innertubeApiKey"\s*:\s*"([^"]+)"/);
    if (match2 && match2[1]) {
      return match2[1];
    }
  } catch (_) {
    // Fall through
  }

  // Try embedded player page
  try {
    const { data } = await hget('https://www.youtube.com/embed/dQw4w9WgXcQ');
    const match = data.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
    if (match && match[1]) {
      return match[1];
    }
  } catch (_) {
    // Fall through
  }

  // Use hardcoded fallback
  return INNERTUBE_API_KEY;
}

/**
 * Call the InnerTube /player endpoint to get video metadata + streams
 * @param {string} videoId
 * @param {string} [apiKey]
 */
async function getPlayerResponse(videoId, apiKey) {
  const keys = [apiKey, INNERTUBE_API_KEY, ...FALLBACK_KEYS].filter(Boolean);

  // Try with ANDROID client
  for (const key of keys) {
    try {
      const { status, data } = await hpost(
        `https://www.youtube.com/youtubei/v1/player?key=${key}`,
        {
          videoId,
          context: CLIENT_CONTEXT,
          playbackContext: {
            contentPlaybackContext: {
              signatureTimestamp: '20286',
            },
          },
          // This helps with some videos
          racyCheckOk: true,
        },
      );
      if (status === 200 && data.playabilityStatus) {
        return data;
      }
    } catch (_) {
      continue;
    }
  }

  return null;
}

/**
 * Best audio itags, ordered by preference.
 * 251 = Opus ~160kbps (best quality, webm)
 * 140 = AAC 128kbps (good quality, mp4)
 * 250 = Opus ~70kbps (webm)
 * 249 = Opus ~50kbps (webm)
 */
const AUDIO_ITAGS_BY_PREFERENCE = [251, 140, 250, 249, 256, 258, 327, 338];

/**
 * Get audio streams from a player response
 */
function extractAudioStreams(playerResponse) {
  const adaptiveFormats =
    playerResponse?.streamingData?.adaptiveFormats || [];
  const formats = playerResponse?.streamingData?.formats || [];

  const allFormats = [...adaptiveFormats, ...formats];

  const audioStreams = allFormats
    .filter((f) => {
      const mime = f.mimeType || '';
      // Audio-only: mime starts with "audio/" or has no video
      return (
        mime.startsWith('audio/') ||
        (!f.width && !f.height && (f.audioQuality || f.audioChannels))
      );
    })
    .map((f) => ({
      itag: f.itag,
      mimeType: f.mimeType || '',
      codecs: (f.mimeType || '').match(/codecs="([^"]+)"/)?.[1] || 'unknown',
      bitrate: f.bitrate || 0,
      audioBitrate: f.bitrate
        ? `${Math.round(f.bitrate / 1000)}kbps`
        : inferBitrate(f.itag),
      audioChannels: f.audioChannels || 2,
      audioSampleRate: f.audioSampleRate
        ? parseInt(f.audioSampleRate)
        : 'unknown',
      audioQuality: f.audioQuality || '',
      approxDurationMs: f.approxDurationMs || '0',
      contentLength: f.contentLength
        ? parseInt(f.contentLength)
        : parseInt(f.contentLengthApprox) || 0,
      loudnessDb: f.loudnessDb || 0,
      // The actual stream URL
      url: f.url || f.signatureCipher || null,
      // For streaming directly
      hasCleanUrl: !!f.url,
    }))
    // Sort by preference
    .sort((a, b) => {
      const aIdx = AUDIO_ITAGS_BY_PREFERENCE.indexOf(a.itag);
      const bIdx = AUDIO_ITAGS_BY_PREFERENCE.indexOf(b.itag);
      if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
      if (aIdx >= 0) return -1;
      if (bIdx >= 0) return 1;
      return (b.bitrate || 0) - (a.bitrate || 0);
    });

  return audioStreams;
}

function inferBitrate(itag) {
  const map = {
    139: '48kbps',
    140: '128kbps',
    141: '256kbps',
    249: '~50kbps',
    250: '~70kbps',
    251: '~160kbps',
    256: '192kbps',
    258: '384kbps',
    327: '256kbps',
    338: '~480kbps',
    599: '30kbps',
    600: '~35kbps',
    774: '~256kbps',
  };
  return map[itag] || 'unknown';
}

/**
 * Get video info: metadata + audio streams
 * @param {string} videoInput - Video ID or URL
 */
async function getVideoInfo(videoInput) {
  const videoId = extractVideoId(videoInput);
  if (!videoId) {
    throw new Error(`Could not extract video ID from: ${videoInput}`);
  }

  const apiKey = await fetchApiKey();
  const playerResponse = await getPlayerResponse(videoId, apiKey);

  if (!playerResponse) {
    throw new Error(`Failed to fetch video data for: ${videoId}`);
  }

  const playability = playerResponse.playabilityStatus || {};
  if (playability.status === 'ERROR' || playability.status === 'LOGIN_REQUIRED') {
    throw new Error(
      `Video not playable: ${playability.reason || playability.status}\n` +
      `Try using a different video. Age-restricted content may not work without authentication.`
    );
  }

  const videoDetails = playerResponse.videoDetails || {};
  const audioStreams = extractAudioStreams(playerResponse);
  // Decode URL-encoded signatureCiphers
  for (const stream of audioStreams) {
    if (!stream.url && stream.signatureCipher) {
      // Not needed for ANDROID client, but kept for robustness
      stream.url = stream.signatureCipher;
    }
  }

  return {
    videoId,
    title: videoDetails.title || '',
    author: videoDetails.author || '',
    channelId: videoDetails.channelId || '',
    lengthSeconds: parseInt(videoDetails.lengthSeconds) || 0,
    viewCount: parseInt(videoDetails.viewCount) || 0,
    thumbnails: videoDetails.thumbnail?.thumbnails || [],
    isPrivate: videoDetails.isPrivate || false,
    isLive: videoDetails.isLiveContent || false,
    audioStreams,
    // The best audio stream (first in sorted list)
    bestAudio: audioStreams[0] || null,
    playerResponse,
  };
}

/**
 * Get audio stream URL for a video (returns the best quality audio stream directly)
 * @param {string} videoInput
 * @param {number} [preferredItag] - Preferred audio format itag (140, 251, etc.)
 */
async function getAudioStream(videoInput, preferredItag) {
  const info = await getVideoInfo(videoInput);

  if (preferredItag) {
    const stream = info.audioStreams.find((s) => s.itag === preferredItag);
    if (stream && stream.url) {
      return {
        url: stream.url,
        mimeType: stream.mimeType,
        bitrate: stream.bitrate,
        audioBitrate: stream.audioBitrate,
        durationMs: parseInt(stream.approxDurationMs) || 0,
        contentLength: stream.contentLength,
      };
    }
  }

  const best = info.bestAudio;
  if (!best || !best.url) {
    throw new Error('No audio stream available for this video.');
  }

  return {
    url: best.url,
    mimeType: best.mimeType,
    bitrate: best.bitrate,
    audioBitrate: best.audioBitrate,
    durationMs: parseInt(best.approxDurationMs) || 0,
    contentLength: best.contentLength,
  };
}

/**
 * Search YouTube using the WEB client (search works better with WEB than ANDROID)
 * @param {string} query
 * @param {number} [limit=10]
 */
async function search(query, limit = 10) {
  const apiKey = await fetchApiKey();
  const key = apiKey || INNERTUBE_API_KEY;

  const { data } = await hpost(
    `https://www.youtube.com/youtubei/v1/search?key=${key}`,
    {
      query,
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20250101.00.00',
          hl: 'en',
          gl: 'US',
          utcOffsetMinutes: 0,
        },
      },
    },
    { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  );

  const items = [];
  // Search results come in sectionListRenderer
  const sections =
    data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents || [];

  for (const section of sections) {
    const contents = section?.itemSectionRenderer?.contents || [];
    for (const item of contents) {
      const videoRenderer = item.videoRenderer;
      if (!videoRenderer || items.length >= limit) continue;

      const vid = videoRenderer.videoId;
      const title = videoRenderer.title?.runs?.[0]?.text || '';
      const author = videoRenderer.ownerText?.runs?.[0]?.text || '';
      const lengthText = videoRenderer.lengthText?.simpleText || '';
      const viewCountText = videoRenderer.viewCountText?.simpleText || '';
      const thumbnails = videoRenderer.thumbnail?.thumbnails || [];

      items.push({
        videoId: vid,
        title,
        author,
        lengthText,
        viewCountText,
        thumbnails,
        url: `https://www.youtube.com/watch?v=${vid}`,
      });
    }
  }

  return items;
}

/**
 * Search for music (tuned for music results)
 */
async function searchMusic(query, limit = 10) {
  const apiKey = await fetchApiKey();
  const key = apiKey || INNERTUBE_API_KEY;

  // Use WEB client + params for music filter
  const { data } = await hpost(
    `https://www.youtube.com/youtubei/v1/search?key=${key}`,
    {
      query,
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20250101.00.00',
          hl: 'en',
          gl: 'US',
          utcOffsetMinutes: 0,
        },
      },
      params: 'EgWKAQIIAWoKEAoQAxAEEAUQCQ%3D%3D', // Music videos
    },
    { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  );

  const items = [];
  const sections =
    data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents || [];

  for (const section of sections) {
    const contents = section?.itemSectionRenderer?.contents || [];
    for (const item of contents) {
      const videoRenderer = item.videoRenderer;
      if (!videoRenderer || items.length >= limit) continue;

      items.push({
        videoId: videoRenderer.videoId,
        title: videoRenderer.title?.runs?.[0]?.text || '',
        author: videoRenderer.ownerText?.runs?.[0]?.text || '',
        lengthText: videoRenderer.lengthText?.simpleText || '',
        url: `https://www.youtube.com/watch?v=${videoRenderer.videoId}`,
      });
    }
  }

  return items;
}

/**
 * Get playlist info including all video entries
 * @param {string} playlistInput - Playlist ID or URL
 */
async function getPlaylistInfo(playlistInput) {
  const playlistId = extractPlaylistId(playlistInput);
  if (!playlistId) {
    throw new Error(`Could not extract playlist ID from: ${playlistInput}`);
  }

  const apiKey = await fetchApiKey();
  const key = apiKey || INNERTUBE_API_KEY;

  const { data } = await hpost(
    `https://www.youtube.com/youtubei/v1/browse?key=${key}`,
    {
      browseId: `VL${playlistId}`,
      context: CLIENT_CONTEXT,
    },
  );

  const metadata =
    data?.sidebar?.playlistSidebarRenderer?.items || [];
  const header = data?.header?.playlistHeaderRenderer || {};

  const title = header.title?.simpleText || header.title?.runs?.[0]?.text || '';
  const owner = header.ownerText?.runs?.[0]?.text || '';
  const totalVideos = parseInt(header.numVideosText?.runs?.[0]?.text) || 0;

  const videos = [];
  const contents =
    data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer
      ?.content?.sectionListRenderer?.contents || [];

  for (const section of contents) {
    const items =
      section?.playlistVideoListRenderer?.contents || [];
    for (const item of items) {
      const video = item.playlistVideoRenderer;
      if (!video) continue;
      videos.push({
        videoId: video.videoId,
        title: video.title?.runs?.[0]?.text || '',
        author: video.shortBylineText?.runs?.[0]?.text || '',
        lengthText: video.lengthText?.simpleText || '',
        index: parseInt(video.index?.simpleText) || 0,
      });
    }
  }

  return {
    playlistId,
    title,
    owner,
    totalVideos,
    videos,
  };
}

module.exports = {
  extractVideoId,
  extractPlaylistId,
  fetchApiKey,
  getPlayerResponse,
  getVideoInfo,
  getAudioStream,
  extractAudioStreams,
  search,
  searchMusic,
  getPlaylistInfo,
  AUDIO_ITAGS_BY_PREFERENCE,
  INNERTUBE_API_KEY,
  CLIENT_CONTEXT,
  USER_AGENT,
};
