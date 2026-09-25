/**
 * YouTube Audio Streaming API
 *
 * Architecture:
 *
 * React Native
 *      ↓
 * /api/stream/:videoId/:itag
 *      ↓
 * yt-dlp --get-url
 *      ↓
 * Direct YouTube audio URL
 *      ↓
 * Node HTTP/HTTPS proxy
 *      ↓
 * React Native Audio Player
 *
 * Features:
 * - YouTube search via InnerTube
 * - Video metadata via InnerTube
 * - Audio stream via yt-dlp
 * - HTTP Range support
 * - Seek support
 * - Content-Length forwarding
 * - Content-Type forwarding
 * - HEAD support
 * - CORS
 * - Health check
 * - yt-dlp health check
 * - Request timeout
 * - Client disconnect handling
 * - Local + production friendly
 * - Windows + Linux/macOS friendly
 */

"use strict";

const http = require("http");
const https = require("https");
const express = require("express");
const { spawn } = require("child_process");
const crypto = require("crypto");

/* =========================================================
   InnerTube
========================================================= */

const {
  getVideoInfo,
  search,
  searchMusic,
  extractVideoId,
} = require("./lib/innerTube");

/* =========================================================
   CONFIG
========================================================= */

const app = express();

const PORT = Number(process.env.PORT) || 3000;

const HOST = process.env.HOST || "0.0.0.0";

function requestId() {
  return crypto.randomBytes(4).toString("hex");
}

function logInfo(message, data = {}) {
  console.log(
    `[${new Date().toISOString()}] [INFO] ${message}`,
    Object.keys(data).length ? data : "",
  );
}

function logError(message, error, data = {}) {
  console.error(`[${new Date().toISOString()}] [ERROR] ${message}`, {
    ...data,
    error: error?.message || error,
    stack: error?.stack,
  });
}

/**
 * Local:
 *
 * Windows:
 *   yt-dlp
 *
 * Production:
 *   Set:
 *   YTDLP_PATH=/usr/local/bin/yt-dlp
 *
 * Windows example:
 *   YTDLP_PATH=C:\yt-dlp\yt-dlp.exe
 */
const YTDLP_PATH = process.env.YTDLP_PATH || "yt-dlp";
const YTDLP_COOKIES_PATH = process.env.YTDLP_COOKIES_PATH || "";

const fs = require("fs");
const path = require("path");

const RUNTIME_COOKIES_PATH =
  process.env.RUNTIME_COOKIES_PATH || "/tmp/youtube-cookies.txt";

function prepareCookiesFile() {
  if (!YTDLP_COOKIES_PATH) {
    return null;
  }

  if (!fs.existsSync(YTDLP_COOKIES_PATH)) {
    throw new Error(`Cookie file not found: ${YTDLP_COOKIES_PATH}`);
  }

  fs.copyFileSync(YTDLP_COOKIES_PATH, RUNTIME_COOKIES_PATH);

  return RUNTIME_COOKIES_PATH;
}

/**
 * yt-dlp process timeout.
 *
 * Resolving a YouTube URL should normally take only
 * a few seconds.
 */
const YTDLP_TIMEOUT = Number(process.env.YTDLP_TIMEOUT) || 15000;

/**
 * Upstream request timeout.
 */
const STREAM_TIMEOUT = Number(process.env.STREAM_TIMEOUT) || 30000;

/**
 * Maximum search limit.
 */
const MAX_SEARCH_LIMIT = Number(process.env.MAX_SEARCH_LIMIT) || 50;

/**
 * Optional API request rate limit.
 *
 * This is intentionally simple in-memory protection.
 *
 * For multiple production instances use Redis / proper
 * reverse-proxy rate limiting.
 */
const RATE_LIMIT_WINDOW = 60 * 1000;

const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 120;

const rateLimitStore = new Map();

/* =========================================================
   AUDIO FORMAT MAP
========================================================= */

const AUDIO_FORMATS = {
  139: {
    mimeType: "audio/mp4",
    extension: "m4a",
  },

  140: {
    mimeType: "audio/mp4",
    extension: "m4a",
  },

  141: {
    mimeType: "audio/mp4",
    extension: "m4a",
  },

  249: {
    mimeType: "audio/webm",
    extension: "webm",
  },

  250: {
    mimeType: "audio/webm",
    extension: "webm",
  },

  251: {
    mimeType: "audio/webm",
    extension: "webm",
  },

  256: {
    mimeType: "audio/mp4",
    extension: "m4a",
  },

  258: {
    mimeType: "audio/mp4",
    extension: "m4a",
  },

  327: {
    mimeType: "audio/mp4",
    extension: "m4a",
  },

  338: {
    mimeType: "audio/webm",
    extension: "webm",
  },
};

/* =========================================================
   MIDDLEWARE
========================================================= */

app.disable("x-powered-by");

/**
 * JSON body.
 */
app.use(
  express.json({
    limit: "1mb",
  }),
);

/**
 * CORS
 */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Range, Accept, Origin",
  );

  res.setHeader(
    "Access-Control-Expose-Headers",
    [
      "Accept-Ranges",
      "Content-Length",
      "Content-Range",
      "Content-Type",
      "ETag",
      "Last-Modified",
      "X-Stream-Backend",
      "X-Video-ID",
      "X-Itag",
    ].join(", "),
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use((req, res, next) => {
  const id = requestId();
  const start = Date.now();

  req.requestId = id;

  logInfo("REQUEST_START", {
    id,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
  });

  res.on("finish", () => {
    logInfo("REQUEST_END", {
      id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start,
    });
  });

  next();
});

/**
 * Basic security headers.
 */
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");

  res.setHeader("X-Frame-Options", "DENY");

  res.setHeader("Referrer-Policy", "no-referrer");

  next();
});

/**
 * Simple request logger.
 */
app.use((req, res, next) => {
  const startedAt = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - startedAt;

    console.log(
      `[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`,
    );
  });

  next();
});

/* =========================================================
   RATE LIMIT
========================================================= */

function cleanupRateLimitStore() {
  const now = Date.now();

  for (const [ip, data] of rateLimitStore.entries()) {
    if (now - data.start > RATE_LIMIT_WINDOW) {
      rateLimitStore.delete(ip);
    }
  }
}

setInterval(cleanupRateLimitStore, 5 * 60 * 1000).unref();

function simpleRateLimit(req, res, next) {
  /**
   * Do not rate limit health checks.
   */
  if (req.path === "/api/health" || req.path === "/api/health/yt-dlp") {
    return next();
  }

  const forwarded = req.headers["x-forwarded-for"];

  const ip =
    typeof forwarded === "string"
      ? forwarded.split(",")[0].trim()
      : req.socket.remoteAddress || "unknown";

  const now = Date.now();

  let record = rateLimitStore.get(ip);

  if (!record || now - record.start > RATE_LIMIT_WINDOW) {
    record = {
      start: now,
      count: 0,
    };
  }

  record.count += 1;

  rateLimitStore.set(ip, record);

  if (record.count > RATE_LIMIT_MAX) {
    return res.status(429).json({
      success: false,
      message: "Too many requests. Please try again later.",
    });
  }

  next();
}

app.use(simpleRateLimit);

/* =========================================================
   HELPERS
========================================================= */

/**
 * Validate YouTube video ID.
 */
function isValidVideoId(videoId) {
  return /^[A-Za-z0-9_-]{11}$/.test(videoId);
}

/**
 * Parse integer safely.
 */
function parsePositiveInt(value, fallback = 10) {
  const number = Number.parseInt(value, 10);

  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }

  return number;
}

/**
 * Get format metadata.
 */
function getFormatInfo(itag) {
  return (
    AUDIO_FORMATS[Number(itag)] || {
      mimeType: "audio/mp4",
      extension: "m4a",
    }
  );
}

/**
 * Convert URL to HTTP/HTTPS module.
 */
function getHttpModule(url) {
  return url.protocol === "https:" ? https : http;
}

/**
 * Kill child process safely.
 */
function killProcess(child) {
  if (!child) {
    return;
  }

  try {
    if (!child.killed) {
      child.kill();
    }
  } catch (error) {
    console.error("[PROCESS] Failed to kill process:", error.message);
  }
}

/* =========================================================
   YT-DLP CHECK
========================================================= */

function checkYtdlp() {
  return new Promise((resolve) => {
    let finished = false;

    const proc = spawn(YTDLP_PATH, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const timeout = setTimeout(() => {
      if (finished) return;

      finished = true;

      killProcess(proc);

      resolve({
        available: false,
        version: null,
        error: "yt-dlp check timed out",
      });
    }, 5000);

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (error) => {
      if (finished) return;

      finished = true;

      clearTimeout(timeout);

      resolve({
        available: false,
        version: null,
        error: error.message,
      });
    });

    proc.on("close", (code) => {
      if (finished) return;

      finished = true;

      clearTimeout(timeout);

      resolve({
        available: code === 0,
        version: stdout.trim() || null,
        error: code === 0 ? null : stderr.trim(),
      });
    });
  });
}

/* =========================================================
   RESOLVE YOUTUBE AUDIO URL
========================================================= */

/**
 * Ask yt-dlp for the direct audio URL.
 *
 * IMPORTANT:
 *
 * We DO NOT pipe yt-dlp stdout to the user.
 *
 * yt-dlp only resolves the temporary YouTube URL.
 *
 * Node then proxies the actual audio.
 *
 * This gives us much better Range / seek handling.
 */
function resolveAudioUrl(videoId, itag) {
  return new Promise((resolve, reject) => {
    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

    /**
     * Exact format if requested.
     *
     * Example:
     *
     * 140
     * 251
     */
    const format = itag ? `${itag}` : "bestaudio[ext=m4a]/bestaudio/best";

    const cookiesPath = prepareCookiesFile();

    const args = [
      "--no-playlist",
      "--no-warnings",
      "--quiet",
      "--no-check-certificates",

      ...(cookiesPath ? ["--cookies", cookiesPath] : []),

      "--get-url",

      "--format",
      format,

      youtubeUrl,
    ];
    console.log("[YT-DLP] Resolving stream");

    console.log("[YT-DLP] video:", videoId);

    console.log("[YT-DLP] itag:", itag || "best");

    let stdout = "";

    let stderr = "";

    let finished = false;

    const proc = spawn(YTDLP_PATH, args, {
      stdio: ["ignore", "pipe", "pipe"],

      windowsHide: true,

      env: {
        ...process.env,
      },
    });

    const timeout = setTimeout(() => {
      if (finished) return;

      finished = true;

      killProcess(proc);

      reject(new Error(`yt-dlp timed out after ${YTDLP_TIMEOUT}ms`));
    }, YTDLP_TIMEOUT);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (error) => {
      if (finished) return;

      finished = true;

      clearTimeout(timeout);

      reject(error);
    });

    proc.on("close", (code) => {
      if (finished) return;

      finished = true;

      clearTimeout(timeout);

      if (code !== 0) {
        const message = stderr.trim() || `yt-dlp exited with code ${code}`;

        return reject(new Error(message));
      }

      /**
       * yt-dlp can theoretically return multiple lines.
       *
       * We take the last non-empty line.
       */
      const urls = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      const directUrl = urls[urls.length - 1];

      if (!directUrl) {
        return reject(new Error("yt-dlp did not return a stream URL"));
      }

      try {
        new URL(directUrl);
      } catch {
        return reject(new Error("yt-dlp returned an invalid stream URL"));
      }

      resolve(directUrl);
    });
  });
}

/* =========================================================
   PROXY AUDIO STREAM
========================================================= */

/**
 * Proxy direct YouTube audio URL.
 *
 * Supports:
 *
 * Range: bytes=0-
 *
 * Range: bytes=100000-
 *
 * Range: bytes=100000-200000
 */
function proxyAudioStream({ req, res, directUrl, videoId, itag }) {
  return new Promise((resolve) => {
    let completed = false;

    const url = new URL(directUrl);

    const clientModule = getHttpModule(url);

    const requestHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",

      Accept: "*/*",

      Connection: "keep-alive",
    };

    /**
     * Forward Range from RN/player.
     */
    if (req.headers.range) {
      requestHeaders.Range = req.headers.range;

      console.log("[STREAM] Range:", req.headers.range);
    }

    /**
     * Some YouTube URLs are sensitive to referrer.
     */
    requestHeaders.Referer = "https://www.youtube.com/";

    const upstreamReq = clientModule.request(
      {
        protocol: url.protocol,

        hostname: url.hostname,

        port: url.port || (url.protocol === "https:" ? 443 : 80),

        path: url.pathname + url.search,

        method: "GET",

        headers: requestHeaders,

        timeout: STREAM_TIMEOUT,

        family: 4,
      },

      (upstreamRes) => {
        /**
         * IMPORTANT:
         *
         * Do not override status.
         *
         * YouTube may return:
         *
         * 200
         * 206
         * 416
         */
        const statusCode = upstreamRes.statusCode || 502;

        res.status(statusCode);

        /**
         * Content type.
         */
        const contentType =
          upstreamRes.headers["content-type"] || getFormatInfo(itag).mimeType;

        res.setHeader("Content-Type", contentType);

        /**
         * Range support.
         */
        res.setHeader(
          "Accept-Ranges",
          upstreamRes.headers["accept-ranges"] || "bytes",
        );

        /**
         * Content length.
         */
        if (upstreamRes.headers["content-length"]) {
          res.setHeader(
            "Content-Length",
            upstreamRes.headers["content-length"],
          );
        }

        /**
         * Content range.
         */
        if (upstreamRes.headers["content-range"]) {
          res.setHeader("Content-Range", upstreamRes.headers["content-range"]);
        }

        /**
         * Last modified.
         */
        if (upstreamRes.headers["last-modified"]) {
          res.setHeader("Last-Modified", upstreamRes.headers["last-modified"]);
        }

        /**
         * ETag.
         */
        if (upstreamRes.headers.etag) {
          res.setHeader("ETag", upstreamRes.headers.etag);
        }

        /**
         * Our own debugging headers.
         */
        res.setHeader("X-Stream-Backend", "yt-dlp-url-proxy");

        res.setHeader("X-Video-ID", videoId);

        if (itag) {
          res.setHeader("X-Itag", String(itag));
        }

        console.log(
          "[UPSTREAM]",
          statusCode,
          contentType,
          "length:",
          upstreamRes.headers["content-length"] || "unknown",
        );

        /**
         * Pipe audio.
         */
        upstreamRes.pipe(res);

        upstreamRes.on("end", () => {
          completed = true;

          resolve();
        });

        upstreamRes.on("error", (error) => {
          console.error("[UPSTREAM] Stream error:", error.message);

          completed = true;

          if (!res.writableEnded) {
            res.end();
          }

          resolve();
        });
      },
    );

    /**
     * Request timeout.
     */
    upstreamReq.setTimeout(STREAM_TIMEOUT, () => {
      console.error("[UPSTREAM] Request timeout");

      upstreamReq.destroy(new Error("Upstream request timeout"));
    });

    /**
     * Upstream error.
     */
    upstreamReq.on("error", (error) => {
      console.error("[UPSTREAM] Request error:", error.message);

      if (!res.headersSent) {
        res.status(502).json({
          success: false,
          message: "Unable to connect to YouTube audio stream",
          error: error.message,
        });
      } else if (!res.writableEnded) {
        res.end();
      }

      resolve();
    });

    /**
     * Client disconnect.
     */
    req.on("close", () => {
      if (completed) {
        return;
      }

      console.log("[STREAM] Client disconnected");

      try {
        upstreamReq.destroy();
      } catch {}
    });

    /**
     * Start upstream request.
     */
    upstreamReq.end();
  });
}

/* =========================================================
   STREAM HANDLER
========================================================= */

async function handleStream(req, res) {
  const startedAt = Date.now();

  const videoId = req.params.videoId;

  const rawItag = req.params.itag;

  /**
   * Optional itag.
   */
  const itag = rawItag ? Number.parseInt(rawItag, 10) : null;

  console.log("");
  console.log("==========================================");
  console.log("[STREAM] REQUEST");
  console.log("Video ID:", videoId);
  console.log("Itag:", itag || "best");
  console.log("Range:", req.headers.range || "none");
  console.log("==========================================");

  /**
   * Validate video ID.
   */
  if (!isValidVideoId(videoId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid YouTube video ID",
    });
  }

  /**
   * Validate itag.
   */
  if (rawItag && (!itag || Number.isNaN(itag))) {
    return res.status(400).json({
      success: false,
      message: "Invalid audio itag",
    });
  }

  /**
   * Resolve direct URL.
   */
  let directUrl;

  try {
    directUrl = await resolveAudioUrl(videoId, itag);
  } catch (error) {
    console.error("[STREAM] yt-dlp resolve failed:", error.message);

    /**
     * Important:
     *
     * Do not fallback to stdout streaming here.
     *
     * The URL proxy architecture is intentional.
     */
    return res.status(502).json({
      success: false,
      message: "Unable to resolve YouTube audio stream",
      error: error.message,
      videoId,
      itag,
    });
  }

  console.log("[STREAM] Direct URL resolved in", `${Date.now() - startedAt}ms`);

  /**
   * Proxy the actual stream.
   */
  await proxyAudioStream({
    req,
    res,
    directUrl,
    videoId,
    itag,
  });
}

/* =========================================================
   SEARCH
========================================================= */

app.get("/api/search", async (req, res) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    const type = typeof req.query.type === "string" ? req.query.type : "";

    const requestedLimit = parsePositiveInt(req.query.limit, 10);

    const limit = Math.min(requestedLimit, MAX_SEARCH_LIMIT);

    if (!q) {
      return res.status(400).json({
        success: false,
        message: "Missing query parameter ?q=",
      });
    }

    console.log(`[SEARCH] "${q}" limit=${limit} type=${type || "normal"}`);

    const results =
      type.toLowerCase() === "music"
        ? await searchMusic(q, limit)
        : await search(q, limit);

    return res.json({
      success: true,
      query: q,
      count: results.length,
      results,
    });
  } catch (error) {
    console.error("[SEARCH] Error:", error);

    return res.status(500).json({
      success: false,
      message: "YouTube search failed",
      error: error.message,
    });
  }
});

/* =========================================================
   VIDEO INFO
========================================================= */

app.get("/api/video/:id", async (req, res) => {
  try {
    const videoId = extractVideoId(req.params.id);

    if (!videoId || !isValidVideoId(videoId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid YouTube video ID",
      });
    }

    console.log("[VIDEO] Getting information:", videoId);

    const info = await getVideoInfo(videoId);

    /**
     * Never expose complete InnerTube player response.
     *
     * It can be huge and may contain unnecessary
     * internal information.
     */
    const { playerResponse, ...cleanInfo } = info;

    return res.json({
      success: true,
      ...cleanInfo,
    });
  } catch (error) {
    console.error("[VIDEO] Error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to get YouTube video information",
      error: error.message,
    });
  }
});

/* =========================================================
   STREAM ROUTES
========================================================= */

/**
 * Best available audio.
 *
 * GET /api/stream/:videoId
 */

/**
 * Specific audio format.
 *
 * GET /api/stream/:videoId/:itag
 *
 * Example:
 *
 * /api/stream/dQw4w9WgXcQ/140
 *
 * /api/stream/dQw4w9WgXcQ/251
 */
app.get("/api/stream/:videoId/:itag", handleStream);

/**
 * HEAD request.
 *
 * Some audio players / clients may use HEAD.
 *
 * We resolve the URL and perform a HEAD request upstream.
 */
app.head("/api/stream/:videoId", async (req, res) => {
  await handleHeadRequest(req, res, null);
});

app.head("/api/stream/:videoId/:itag", async (req, res) => {
  const itag = Number.parseInt(req.params.itag, 10);

  await handleHeadRequest(req, res, Number.isNaN(itag) ? null : itag);
});

/* =========================================================
   HEAD STREAM
========================================================= */

async function handleHeadRequest(req, res, itag) {
  const videoId = req.params.videoId;

  if (!isValidVideoId(videoId)) {
    return res.status(400).end();
  }

  try {
    const directUrl = await resolveAudioUrl(videoId, itag);

    const url = new URL(directUrl);

    const clientModule = getHttpModule(url);

    const upstreamReq = clientModule.request(
      {
        protocol: url.protocol,

        hostname: url.hostname,

        port: url.port || (url.protocol === "https:" ? 443 : 80),

        path: url.pathname + url.search,

        method: "HEAD",

        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36",

          Referer: "https://www.youtube.com/",
        },

        timeout: STREAM_TIMEOUT,

        family: 4,
      },

      (upstreamRes) => {
        res.status(upstreamRes.statusCode || 200);

        res.setHeader(
          "Content-Type",
          upstreamRes.headers["content-type"] || getFormatInfo(itag).mimeType,
        );

        res.setHeader(
          "Accept-Ranges",
          upstreamRes.headers["accept-ranges"] || "bytes",
        );

        if (upstreamRes.headers["content-length"]) {
          res.setHeader(
            "Content-Length",
            upstreamRes.headers["content-length"],
          );
        }

        res.setHeader("X-Stream-Backend", "yt-dlp-url-proxy");

        res.setHeader("X-Video-ID", videoId);

        if (itag) {
          res.setHeader("X-Itag", String(itag));
        }

        res.end();
      },
    );

    upstreamReq.on("error", (error) => {
      console.error("[HEAD] Error:", error.message);

      if (!res.headersSent) {
        res.status(502).end();
      }
    });

    upstreamReq.setTimeout(STREAM_TIMEOUT, () => {
      upstreamReq.destroy();
    });

    upstreamReq.end();
  } catch (error) {
    console.error("[HEAD] Resolve error:", error.message);

    return res.status(502).end();
  }
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/api/health", async (req, res) => {
  const ytDlp = await checkYtdlp();

  res.json({
    success: true,

    status: "ok",

    service: "YouTube Audio Streaming API",

    version: "2.0.0",

    environment: process.env.NODE_ENV || "development",

    uptime: Math.floor(process.uptime()),

    node: process.version,

    engine: "InnerTube + yt-dlp URL Proxy",

    ytDlp: {
      available: ytDlp.available,

      version: ytDlp.version,

      error: ytDlp.error,
    },

    features: {
      search: true,

      videoInfo: true,

      audioStreaming: true,

      rangeRequests: true,

      seeking: true,

      headRequests: true,

      cors: true,
    },
  });
});

/**
 * Dedicated yt-dlp health endpoint.
 */
app.get("/api/health/yt-dlp", async (req, res) => {
  const result = await checkYtdlp();

  return res.status(result.available ? 200 : 503).json({
    success: result.available,

    ytdlp: result,
  });
});

app.get("/api/debug/yt-dlp", async (req, res) => {
  const videoId = req.query.videoId || "vRjaGgDsWSo";
  const itag = req.query.itag || "140";

  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--get-url",
    "--format",
    String(itag),
    youtubeUrl,
  ];

  console.log("==========================================");
  console.log("[DEBUG YT-DLP]");
  console.log("Video:", videoId);
  console.log("Itag:", itag);
  console.log("Command:", YTDLP_PATH, args.join(" "));
  console.log("==========================================");

  const proc = spawn(YTDLP_PATH, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
    },
  });

  let stdout = "";
  let stderr = "";

  proc.stdout.on("data", (data) => {
    const text = data.toString();

    stdout += text;

    console.log("[DEBUG STDOUT]", text.trim());
  });

  proc.stderr.on("data", (data) => {
    const text = data.toString();

    stderr += text;

    console.error("[DEBUG STDERR]", text.trim());
  });

  proc.on("error", (error) => {
    console.error("[DEBUG PROCESS ERROR]", error);

    res.status(500).json({
      success: false,
      stage: "spawn",
      error: error.message,
    });
  });

  proc.on("close", (code) => {
    console.log("[DEBUG EXIT CODE]", code);

    res.status(code === 0 ? 200 : 502).json({
      success: code === 0,
      videoId,
      itag,
      exitCode: code,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    });
  });
});

/* =========================================================
   API DOCS
========================================================= */

app.get("/", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;

  res.type("html");

  res.send(`
<!DOCTYPE html>
<html lang="en">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
/>

<title>YouTube Audio API</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 40px 20px;
  background: #0f172a;
  color: #e5e7eb;
  font-family:
    Inter,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}

.container {
  max-width: 900px;
  margin: auto;
}

h1 {
  color: #f43f5e;
}

.card {
  background: #111827;
  border: 1px solid #1f2937;
  border-radius: 12px;
  padding: 18px;
  margin: 15px 0;
}

.method {
  color: #22c55e;
  font-weight: 700;
}

code {
  background: #020617;
  padding: 4px 7px;
  border-radius: 5px;
}

pre {
  background: #020617;
  padding: 15px;
  border-radius: 10px;
  overflow-x: auto;
}

small {
  color: #94a3b8;
}

</style>

</head>

<body>

<div class="container">

<h1>🎵 YouTube Audio Streaming API</h1>

<p>
InnerTube metadata/search +
yt-dlp direct URL resolution +
Node audio proxy.
</p>

<div class="card">

<strong>Health</strong>

<p>
<a href="/api/health">
${baseUrl}/api/health
</a>
</p>

</div>

<div class="card">

<div class="method">
GET /api/search
</div>

<p>
Search YouTube.
</p>

<code>
/api/search?q=arijit+singh&limit=10
</code>

<br><br>

<code>
/api/search?q=arijit+singh&type=music
</code>

</div>

<div class="card">

<div class="method">
GET /api/video/:id
</div>

<p>
Get video metadata and audio formats.
</p>

<code>
/api/video/dQw4w9WgXcQ
</code>

</div>

<div class="card">

<div class="method">
GET /api/stream/:videoId
</div>

<p>
Best available audio.
</p>

<code>
/api/stream/dQw4w9WgXcQ
</code>

</div>

<div class="card">

<div class="method">
GET /api/stream/:videoId/:itag
</div>

<p>
Specific audio format.
</p>

<code>
/api/stream/dQw4w9WgXcQ/140
</code>

<br><br>

<code>
/api/stream/dQw4w9WgXcQ/251
</code>

</div>

<div class="card">

<h3>Audio Formats</h3>

<table>

<tr>
<th>itag</th>
<th>Codec</th>
<th>Container</th>
</tr>

<tr>
<td>140</td>
<td>AAC</td>
<td>M4A</td>
</tr>

<tr>
<td>141</td>
<td>AAC</td>
<td>M4A</td>
</tr>

<tr>
<td>139</td>
<td>AAC</td>
<td>M4A</td>
</tr>

<tr>
<td>251</td>
<td>Opus</td>
<td>WebM</td>
</tr>

<tr>
<td>250</td>
<td>Opus</td>
<td>WebM</td>
</tr>

<tr>
<td>249</td>
<td>Opus</td>
<td>WebM</td>
</tr>

</table>

</div>

<div class="card">

<h3>curl</h3>

<pre>
curl "${baseUrl}/api/video/dQw4w9WgXcQ"

curl "${baseUrl}/api/stream/dQw4w9WgXcQ/140" -o song.m4a

curl -H "Range: bytes=0-" \\
"${baseUrl}/api/stream/dQw4w9WgXcQ/140"
</pre>

</div>

<small>
YouTube audio URLs are temporary and are resolved
through yt-dlp when a stream request is made.
</small>

</div>

</body>

</html>
`);
});

/* =========================================================
   404
========================================================= */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
    path: req.originalUrl,
  });
});

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use((error, req, res, next) => {
  console.error("[EXPRESS ERROR]", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    message: "Internal server error",
    error: process.env.NODE_ENV === "production" ? undefined : error.message,
  });
});

/* =========================================================
   PROCESS ERROR HANDLING
========================================================= */

process.on("uncaughtException", (error) => {
  console.error("==========================================");

  console.error("[UNCAUGHT EXCEPTION]");

  console.error(error);

  console.error("==========================================");

  /**
   * Do not immediately kill the process.
   *
   * In production a process manager such as:
   *
   * PM2 / Docker / Railway / Render
   *
   * should restart it if necessary.
   */
});

process.on("unhandledRejection", (reason) => {
  console.error("==========================================");

  console.error("[UNHANDLED REJECTION]");

  console.error(reason);

  console.error("==========================================");
});

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

let server;

function shutdown(signal) {
  console.log(`[SERVER] ${signal} received. Shutting down...`);

  if (!server) {
    process.exit(0);
  }

  server.close(() => {
    console.log("[SERVER] HTTP server closed.");

    process.exit(0);
  });

  /**
   * Force shutdown after 10 sec.
   */
  setTimeout(() => {
    console.error("[SERVER] Forced shutdown.");

    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("SIGINT", () => shutdown("SIGINT"));

/* =========================================================
   START SERVER
========================================================= */

server = app.listen(PORT, HOST, () => {
  console.log("");
  console.log("==========================================");

  console.log("🎵 YouTube Audio Streaming API");

  console.log("==========================================");

  console.log(`Server: http://localhost:${PORT}`);

  console.log(`Host: ${HOST}`);

  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);

  console.log(`yt-dlp: ${YTDLP_PATH}`);

  console.log("==========================================");

  console.log("Endpoints:");

  console.log(`GET /api/search?q=...`);

  console.log(`GET /api/video/:id`);

  console.log(`GET /api/stream/:id`);

  console.log(`GET /api/stream/:id/:itag`);

  console.log(`GET /api/health`);

  console.log("==========================================");

  /**
   * Check yt-dlp at startup.
   */
  checkYtdlp().then((result) => {
    if (result.available) {
      console.log(`[YT-DLP] Ready: ${result.version}`);
    } else {
      console.error("[YT-DLP] NOT AVAILABLE");

      console.error("[YT-DLP] Error:", result.error);

      console.error(
        "[YT-DLP] Set YTDLP_PATH environment variable if necessary.",
      );
    }

    console.log("==========================================");
  });
});

process.on("uncaughtException", (error) => {
  console.error("\n🔥 UNCAUGHT EXCEPTION");
  console.error(error);
});

process.on("unhandledRejection", (reason) => {
  console.error("\n🔥 UNHANDLED REJECTION");
  console.error(reason);
});

server.requestTimeout = 0;

server.headersTimeout = 65000;

server.keepAliveTimeout = 65000;
