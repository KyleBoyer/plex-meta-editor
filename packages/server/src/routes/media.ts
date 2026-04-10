import type { Request, Response } from 'express';
import { Router } from 'express';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import type { SafeDB } from '../db/connection.js';
import type { AppConfig } from '../config.js';
import { createError } from '../middleware/error.js';
import { getMediaFrameRate } from '../media/frame-rate.js';
import { getMediaInfo } from '../plex/queries.js';

type TranscodeVariant = 'standard' | 'full' | 'safe';

interface PlexCredentials {
  plexUrl: string;
  plexToken: string;
}

/** Map container format to MIME type */
const MIME_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  ts: 'video/mp2t',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
};

function getMimeType(container: string, filePath: string): string {
  // Try container from DB first
  if (container && MIME_TYPES[container.toLowerCase()]) {
    return MIME_TYPES[container.toLowerCase()];
  }
  // Fall back to file extension
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME_TYPES[ext] || 'video/mp4';
}

export function createMediaRoutes(db: SafeDB, config: AppConfig): Router {
  const router = Router();

  // GET /api/media/info/:metadataId — media file info (codecs, resolution, file path)
  router.get('/info/:metadataId', async (req, res, next) => {
    try {
      const metadataId = parseMetadataId(req.params.metadataId);
      if (!metadataId) {
        res.status(400).json({ success: false, error: 'Invalid metadata ID' });
        return;
      }

      const info = getMediaInfo(db, metadataId);
      if (!info) {
        res.status(404).json({ success: false, error: 'No media file found for this item' });
        return;
      }

      // Check if file exists on disk (for direct streaming mode)
      const fileExists = fs.existsSync(info.filePath);
      const frameRate = fileExists ? await getMediaFrameRate(info.filePath) : null;

      res.json({
        success: true,
        data: {
          ...info,
          fileExists,
          frameRate,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/media/artwork/:metadataId/:kind — proxy Plex poster/background artwork
  router.get('/artwork/:metadataId/:kind', async (req, res, next) => {
    try {
      const metadataId = parseMetadataId(req.params.metadataId);
      if (!metadataId) {
        res.status(400).json({ success: false, error: 'Invalid metadata ID' });
        return;
      }

      const kind = parseArtworkKind(req.params.kind);
      if (!kind) {
        res.status(400).json({ success: false, error: 'Invalid artwork kind' });
        return;
      }

      const creds = getPlexCredentials(config);
      if (!creds) {
        respondPlexUnavailable(res, config);
        return;
      }

      const artworkUrl = new URL(`/library/metadata/${metadataId}/${kind}`, `${creds.plexUrl}/`);
      artworkUrl.searchParams.set('X-Plex-Token', creds.plexToken);

      await proxyPlexRequest(req, res, artworkUrl, config, {
        fallbackContentType: 'image/jpeg',
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/media/bif/:metadataId — proxy Plex BIF (Base Index Frames) thumbnail index
  router.get('/bif/:metadataId', async (req, res, next) => {
    try {
      const metadataId = parseMetadataId(req.params.metadataId);
      if (!metadataId) {
        res.status(400).json({ success: false, error: 'Invalid metadata ID' });
        return;
      }

      const creds = getPlexCredentials(config);
      if (!creds) {
        respondPlexUnavailable(res, config);
        return;
      }

      const info = getMediaInfo(db, metadataId);
      if (!info) {
        res.status(404).json({ success: false, error: 'No media file found for this item' });
        return;
      }

      const bifUrl = new URL(`/library/parts/${info.partId}/indexes/sd`, `${creds.plexUrl}/`);
      bifUrl.searchParams.set('X-Plex-Token', creds.plexToken);

      res.setHeader('Cache-Control', 'private, max-age=86400');

      await proxyPlexRequest(req, res, bifUrl, config, {
        fallbackContentType: 'application/octet-stream',
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/media/stream/:metadataId — stream video file with HTTP Range support
  router.get('/stream/:metadataId', (req, res, next) => {
    try {
      const metadataId = parseMetadataId(req.params.metadataId);
      if (!metadataId) {
        res.status(400).json({ success: false, error: 'Invalid metadata ID' });
        return;
      }

      const info = getMediaInfo(db, metadataId);
      if (!info) {
        res.status(404).json({ success: false, error: 'No media file found' });
        return;
      }

      const filePath = info.filePath;
      if (!fs.existsSync(filePath)) {
        res.status(404).json({ success: false, error: `Media file not found on disk: ${filePath}` });
        return;
      }

      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const mimeType = getMimeType(info.container, filePath);
      const range = req.headers.range;

      if (range) {
        // ── Range request (seeking) ──────────────────────────
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        // Safari/WebKit sends "bytes=0-1" as a probe request.
        // Handle the case where end is empty (requesting to EOF).
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        if (start >= fileSize || end >= fileSize || start > end || isNaN(start)) {
          res.status(416)
            .header('Content-Range', `bytes */${fileSize}`)
            .end();
          return;
        }

        const chunkSize = end - start + 1;
        const stream = fs.createReadStream(filePath, { start, end });

        // Destroy the file stream if the client disconnects (Safari aborts probes)
        res.on('close', () => stream.destroy());

        res.status(206).header({
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunkSize),
          'Content-Type': mimeType,
          'Cache-Control': 'no-cache',
        });

        stream.pipe(res);
      } else {
        // ── Full file request ────────────────────────────────
        // Safari/WebKit requires Accept-Ranges to be present even on non-range
        // responses, otherwise it won't attempt range requests for seeking.
        const stream = fs.createReadStream(filePath);
        res.on('close', () => stream.destroy());

        res.header({
          'Content-Length': String(fileSize),
          'Content-Type': mimeType,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
        });

        stream.pipe(res);
      }
    } catch (err) {
      next(err);
    }
  });

  // GET /api/media/plex-stream/:metadataId — proxy raw media from Plex through the app
  router.get('/plex-stream/:metadataId', async (req, res, next) => {
    try {
      const metadataId = parseMetadataId(req.params.metadataId);
      if (!metadataId) {
        res.status(400).json({ success: false, error: 'Invalid metadata ID' });
        return;
      }

      const creds = getPlexCredentials(config);
      if (!creds) {
        respondPlexUnavailable(res, config);
        return;
      }

      const info = getMediaInfo(db, metadataId);
      if (!info) {
        res.status(404).json({ success: false, error: 'No media file found for this item' });
        return;
      }

      const streamUrl = new URL(`/library/parts/${info.partId}/file`, `${creds.plexUrl}/`);
      streamUrl.searchParams.set('X-Plex-Token', creds.plexToken);

      await proxyPlexRequest(req, res, streamUrl, config, {
        fallbackContentType: getMimeType(info.container, info.filePath),
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/media/plex-transcode/:metadataId/start.m3u8?variant=standard|full|safe&session=...
  router.get('/plex-transcode/:metadataId/start.m3u8', async (req, res, next) => {
    try {
      const metadataId = parseMetadataId(req.params.metadataId);
      if (!metadataId) {
        res.status(400).json({ success: false, error: 'Invalid metadata ID' });
        return;
      }

      const creds = getPlexCredentials(config);
      if (!creds) {
        respondPlexUnavailable(res, config);
        return;
      }

      const variant = parseTranscodeVariant(req.query.variant);
      const sessionId = parseTranscodeSession(req.query.session);
      const startUrl = buildPlexTranscodeStartUrl(creds, metadataId, variant, sessionId);

      await proxyPlexRequest(req, res, startUrl, config, { metadataId });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/media/plex-transcode/:metadataId/proxy/:resourceName?target=...&sig=...
  // Keep the original filename/extension in the app URL so stricter HLS parsers
  // still recognize playlists and TS segments after we hide the Plex origin.
  const handleSignedPlexProxy = async (req: Request, res: Response, next: (err?: unknown) => void) => {
    try {
      const metadataIdParam = Array.isArray(req.params.metadataId)
        ? req.params.metadataId[0]
        : req.params.metadataId;
      const metadataId = parseMetadataId(metadataIdParam);
      if (!metadataId) {
        res.status(400).json({ success: false, error: 'Invalid metadata ID' });
        return;
      }

      const creds = getPlexCredentials(config);
      if (!creds) {
        respondPlexUnavailable(res, config);
        return;
      }

      const encodedTarget = typeof req.query.target === 'string' ? req.query.target : '';
      const signature = typeof req.query.sig === 'string' ? req.query.sig : '';
      if (!encodedTarget || !signature) {
        res.status(400).json({ success: false, error: 'Signed Plex proxy target is required' });
        return;
      }

      const upstreamUrl = decodeSignedProxyTarget(encodedTarget, signature, creds.plexToken);
      upstreamUrl.searchParams.set('X-Plex-Token', creds.plexToken);

      await proxyPlexRequest(req, res, upstreamUrl, config, { metadataId });
    } catch (err) {
      next(err);
    }
  };

  const handleSessionPlexProxy = async (req: Request, res: Response, next: (err?: unknown) => void) => {
    try {
      const metadataIdParam = Array.isArray(req.params.metadataId)
        ? req.params.metadataId[0]
        : req.params.metadataId;
      const metadataId = parseMetadataId(metadataIdParam);
      if (!metadataId) {
        res.status(400).json({ success: false, error: 'Invalid metadata ID' });
        return;
      }

      const creds = getPlexCredentials(config);
      if (!creds) {
        respondPlexUnavailable(res, config);
        return;
      }

      const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId.trim() : '';
      const resourceName = typeof req.params.resourceName === 'string' ? req.params.resourceName.trim() : '';
      const signature = typeof req.params.signature === 'string' ? req.params.signature.trim() : '';

      if (!sessionId || !resourceName || !signature) {
        res.status(400).json({ success: false, error: 'Signed Plex session resource is required' });
        return;
      }

      if (!parseTranscodeSession(sessionId) || !parseSessionResourceName(resourceName)) {
        res.status(400).json({ success: false, error: 'Invalid Plex session resource' });
        return;
      }

      const expected = createSessionProxySignature(metadataId, sessionId, creds.plexToken);
      if (!signaturesMatch(signature, expected)) {
        res.status(400).json({ success: false, error: 'Invalid Plex proxy signature' });
        return;
      }

      const upstreamUrl = new URL(
        `/video/:/transcode/universal/session/${encodeURIComponent(sessionId)}/base/${encodeURIComponent(resourceName)}`,
        `${creds.plexUrl}/`,
      );
      upstreamUrl.searchParams.set('X-Plex-Token', creds.plexToken);

      await proxyPlexRequest(req, res, upstreamUrl, config, { metadataId });
    } catch (err) {
      next(err);
    }
  };

  router.get('/plex-transcode/:metadataId/session/:sessionId/sig/:signature/base/:resourceName', handleSessionPlexProxy);
  router.get('/plex-transcode/:metadataId/proxy', handleSignedPlexProxy);
  router.get('/plex-transcode/:metadataId/proxy/:resourceName', handleSignedPlexProxy);

  return router;
}

function parseMetadataId(value: string | undefined): number | null {
  const metadataId = parseInt(value || '', 10);
  return Number.isFinite(metadataId) && metadataId > 0 ? metadataId : null;
}

function parseTranscodeVariant(value: unknown): TranscodeVariant {
  switch (value) {
    case 'full':
    case 'safe':
      return value;
    default:
      return 'standard';
  }
}

function parseArtworkKind(value: string | undefined): 'thumb' | 'art' | null {
  switch (value) {
    case 'thumb':
    case 'art':
      return value;
    default:
      return null;
  }
}

function parseTranscodeSession(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const session = value.trim();
  if (!session || session.length > 160) {
    return undefined;
  }

  return /^[A-Za-z0-9._-]+$/.test(session) ? session : undefined;
}

function parseSessionResourceName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const resourceName = value.trim();
  if (!resourceName || resourceName.length > 200) {
    return undefined;
  }

  return /^[A-Za-z0-9._-]+$/.test(resourceName) ? resourceName : undefined;
}

function getPlexCredentials(config: AppConfig): PlexCredentials | null {
  if (!config.plexUrl || !config.plexToken) {
    return null;
  }

  return {
    plexUrl: config.plexUrl,
    plexToken: config.plexToken,
  };
}

function respondPlexUnavailable(res: Response, config: AppConfig): void {
  res.status(503).json({
    success: false,
    error: config.plexStartupError || 'Plex playback is not configured on the server.',
  });
}

function buildPlexTranscodeStartUrl(
  creds: PlexCredentials,
  metadataId: number,
  variant: TranscodeVariant,
  sessionId?: string,
): URL {
  const url = new URL('/video/:/transcode/universal/start.m3u8', `${creds.plexUrl}/`);
  const params = new URLSearchParams({
    'X-Plex-Token': creds.plexToken,
    'X-Plex-Client-Identifier': 'plex-meta-editor',
    'X-Plex-Product': 'Plex Web',
    'X-Plex-Platform': 'Safari',
    hasMDE: '1',
    path: `/library/metadata/${metadataId}`,
    protocol: 'hls',
    directStream: '1',
    directStreamAudio: '1',
    directPlay: '0',
    copyts: '1',
    mediaIndex: '0',
    partIndex: '0',
    fastSeek: '1',
    location: 'lan',
    session: sessionId || `pme-${metadataId}-${randomUUID()}`,
    offset: '0',
  });

  if (variant === 'full') {
    params.set('X-Plex-Product', 'Plex for Windows');
    params.set('X-Plex-Platform', 'Windows');
    params.set('X-Plex-Client-Profile-Name', 'Windows 10 Desktop');
    params.set('directStream', '0');
    params.set('directStreamAudio', '0');
  }

  if (variant === 'safe') {
    params.set('audioChannelCount', '2');
  }

  url.search = params.toString();
  return url;
}

async function proxyPlexRequest(
  req: Request,
  res: Response,
  upstreamUrl: URL,
  config: AppConfig,
  options: { metadataId?: number; fallbackContentType?: string } = {},
): Promise<void> {
  const upstreamHeaders = buildUpstreamHeaders(req, upstreamUrl);
  let upstreamRes: globalThis.Response;
  try {
    upstreamRes = await fetchPlexWithRetries(upstreamUrl, upstreamHeaders);
  } catch (error) {
    const normalized = normalizePlexProxyError(error, config.plexUrl);
    throw createError(normalized.message, normalized.status);
  }

  if (!upstreamRes.ok && upstreamRes.status !== 206) {
    res.status(upstreamRes.status).json({
      success: false,
      error: `Plex returned ${upstreamRes.status}: ${upstreamRes.statusText}`,
    });
    return;
  }

  const finalUrl = new URL(upstreamRes.url || upstreamUrl.toString());
  if (options.metadataId && isPlaylistResponse(upstreamRes.headers.get('content-type'), finalUrl)) {
    const manifest = await upstreamRes.text();
    const rewritten = rewritePlaylist(manifest, finalUrl, options.metadataId, config);
    const rewrittenBuffer = Buffer.from(rewritten, 'utf8');

    sendBufferedPlaylistResponse(req, res, rewrittenBuffer, {
      cacheControl: upstreamRes.headers.get('cache-control'),
      contentType: upstreamRes.headers.get('content-type') || 'application/vnd.apple.mpegurl',
      xPlexProtocol: upstreamRes.headers.get('x-plex-protocol'),
    });
    return;
  }

  res.status(upstreamRes.status);
  for (const header of ['content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified', 'x-plex-protocol']) {
    const value = upstreamRes.headers.get(header);
    if (value) {
      res.setHeader(header, value);
    }
  }

  const contentType = upstreamRes.headers.get('content-type') || options.fallbackContentType;
  if (contentType) {
    res.setHeader('Content-Type', contentType);
  }

  if (!upstreamRes.headers.get('accept-ranges')) {
    res.setHeader('Accept-Ranges', 'bytes');
  }

  if (upstreamRes.body) {
    const readable = Readable.fromWeb(upstreamRes.body as import('node:stream/web').ReadableStream);
    readable.on('error', () => {
      if (!res.writableEnded) {
        res.end();
      }
    });
    res.on('close', () => readable.destroy());
    readable.pipe(res);
  } else {
    res.end();
  }
}

async function fetchPlexWithRetries(
  upstreamUrl: URL,
  headers: Record<string, string>,
): Promise<globalThis.Response> {
  const retryableRequest = isRetryablePlexTranscodeUrl(upstreamUrl);
  const maxAttempts = retryableRequest ? 6 : 1;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(upstreamUrl, { headers });
      if (!shouldRetryPlexResponse(response, upstreamUrl, attempt, maxAttempts)) {
        return response;
      }

      await discardResponse(response);
    } catch (error) {
      lastError = error;
      if (!retryableRequest || attempt >= maxAttempts - 1) {
        throw error;
      }
    }

    await delay(getPlexRetryDelayMs(attempt));
  }

  throw lastError instanceof Error ? lastError : new Error('Plex request failed after retries');
}

function buildUpstreamHeaders(req: Request, upstreamUrl?: URL): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: typeof req.headers.accept === 'string' ? req.headers.accept : '*/*',
  };

  if (typeof req.headers.range === 'string' && !(upstreamUrl && isPlaylistUrl(upstreamUrl))) {
    headers.Range = req.headers.range;
  }

  if (typeof req.headers['user-agent'] === 'string') {
    headers['User-Agent'] = req.headers['user-agent'];
  }

  return headers;
}

function isPlaylistUrl(upstreamUrl: URL): boolean {
  return upstreamUrl.pathname.toLowerCase().endsWith('.m3u8');
}

function isPlaylistResponse(contentType: string | null, upstreamUrl: URL): boolean {
  const type = (contentType || '').toLowerCase();
  return type.includes('mpegurl') || type.includes('m3u8') || upstreamUrl.pathname.toLowerCase().endsWith('.m3u8');
}

function isRetryablePlexTranscodeUrl(upstreamUrl: URL): boolean {
  const pathname = upstreamUrl.pathname.toLowerCase();
  return pathname.includes('/video/:/transcode/universal/start.m3u8')
    || pathname.includes('/video/:/transcode/universal/session/');
}

function shouldRetryPlexResponse(
  response: globalThis.Response,
  upstreamUrl: URL,
  attempt: number,
  maxAttempts: number,
): boolean {
  if (attempt >= maxAttempts - 1) {
    return false;
  }

  if (!isRetryablePlexTranscodeUrl(upstreamUrl)) {
    return false;
  }

  // Plex can briefly 404/500 individual HLS artifacts while the transcode
  // session is still materializing segments. Retrying smooths this over for
  // browser players that request ahead more aggressively than curl/ffprobe.
  return response.status === 404
    || response.status === 429
    || response.status === 500
    || response.status === 502
    || response.status === 503
    || response.status === 504;
}

function getPlexRetryDelayMs(attempt: number): number {
  const delays = [120, 180, 280, 420, 650];
  return delays[Math.min(attempt, delays.length - 1)];
}

async function discardResponse(response: globalThis.Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // Ignore drain/cancel errors while retrying.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizePlexProxyError(
  error: unknown,
  plexUrl: string | null,
): { status: number; message: string } {
  const baseMessage = plexUrl
    ? `Plex request failed for ${plexUrl}`
    : 'Plex request failed';

  if (!(error instanceof Error)) {
    return { status: 502, message: baseMessage };
  }

  const cause = error.cause as { code?: string; errors?: Array<{ code?: string }> } | undefined;
  const errorCodes = new Set<string>();

  if (cause?.code) {
    errorCodes.add(cause.code);
  }

  for (const nested of cause?.errors || []) {
    if (nested?.code) {
      errorCodes.add(nested.code);
    }
  }

  if (error.name === 'AbortError' || /timed out/i.test(error.message)) {
    return {
      status: 504,
      message: `${baseMessage}: timed out waiting for Plex Media Server to respond.`,
    };
  }

  if (errorCodes.has('ECONNREFUSED')) {
    return {
      status: 502,
      message: `${baseMessage}: connection refused. Make sure Plex Media Server is running.`,
    };
  }

  if (errorCodes.has('ENOTFOUND') || errorCodes.has('EAI_AGAIN')) {
    return {
      status: 502,
      message: `${baseMessage}: host lookup failed.`,
    };
  }

  return {
    status: 502,
    message: `${baseMessage}: ${error.message}`,
  };
}

function sendBufferedPlaylistResponse(
  req: Request,
  res: Response,
  body: Buffer,
  options: {
    cacheControl?: string | null;
    contentType: string;
    xPlexProtocol?: string | null;
  },
): void {
  if (options.cacheControl) {
    res.setHeader('Cache-Control', options.cacheControl);
  }

  if (options.xPlexProtocol) {
    res.setHeader('X-Plex-Protocol', options.xPlexProtocol);
  }

  res.setHeader('Content-Type', stripCharset(options.contentType));

  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  if (!rangeHeader) {
    res.status(200);
    res.setHeader('Content-Length', String(body.length));
    res.end(body);
    return;
  }

  const range = parseBytesRange(rangeHeader, body.length);
  if (!range) {
    res.status(416);
    res.setHeader('Content-Range', `bytes */${body.length}`);
    res.end();
    return;
  }

  res.status(206);
  res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${body.length}`);
  res.setHeader('Content-Length', String(range.end - range.start + 1));
  res.end(body.subarray(range.start, range.end + 1));
}

function stripCharset(contentType: string): string {
  return contentType.split(';', 1)[0]?.trim() || 'application/octet-stream';
}

function parseBytesRange(
  header: string,
  size: number,
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || size <= 0) {
    return null;
  }

  const [, startText, endText] = match;
  if (!startText && !endText) {
    return null;
  }

  if (!startText) {
    const suffixLength = parseInt(endText, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }

    if (suffixLength >= size) {
      return { start: 0, end: size - 1 };
    }

    return { start: size - suffixLength, end: size - 1 };
  }

  const start = parseInt(startText, 10);
  if (!Number.isFinite(start) || start < 0 || start >= size) {
    return null;
  }

  let end = endText ? parseInt(endText, 10) : size - 1;
  if (!Number.isFinite(end)) {
    return null;
  }

  end = Math.min(end, size - 1);
  if (end < start) {
    return null;
  }

  return { start, end };
}

function rewritePlaylist(manifest: string, upstreamUrl: URL, metadataId: number, config: AppConfig): string {
  return manifest
    .split(/\r?\n/)
    .map(line => rewritePlaylistLine(line, upstreamUrl, metadataId, config))
    .join('\n');
}

function rewritePlaylistLine(line: string, upstreamUrl: URL, metadataId: number, config: AppConfig): string {
  if (!line.trim()) {
    return line;
  }

  if (!line.startsWith('#')) {
    return buildProxyUrl(metadataId, resolvePlaylistTarget(line, upstreamUrl), config, upstreamUrl);
  }

  return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
    const proxyUrl = buildProxyUrl(metadataId, resolvePlaylistTarget(uri, upstreamUrl), config, upstreamUrl);
    return `URI="${proxyUrl}"`;
  });
}

function resolvePlaylistTarget(target: string, upstreamUrl: URL): URL {
  const resolved = new URL(target, upstreamUrl);
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new Error(`Unsupported Plex playlist target protocol: ${resolved.protocol}`);
  }
  resolved.searchParams.delete('X-Plex-Token');
  resolved.hash = '';
  return resolved;
}

function buildProxyUrl(
  metadataId: number,
  upstreamUrl: URL,
  config: AppConfig,
  currentUpstreamUrl?: URL,
): string {
  const sessionResource = parsePlexSessionResource(upstreamUrl);
  if (sessionResource) {
    return buildSessionProxyUrl(metadataId, sessionResource.sessionId, sessionResource.resourceName, config, currentUpstreamUrl);
  }

  return buildSignedProxyUrl(metadataId, upstreamUrl, config);
}

function buildSessionProxyUrl(
  metadataId: number,
  sessionId: string,
  resourceName: string,
  config: AppConfig,
  currentUpstreamUrl?: URL,
): string {
  if (!config.plexToken) {
    throw new Error('Plex proxy is not configured');
  }

  const encodedResourceName = encodeURIComponent(resourceName);
  const encodedSessionId = encodeURIComponent(sessionId);
  const encodedSignature = encodeURIComponent(createSessionProxySignature(metadataId, sessionId, config.plexToken));
  const currentSessionResource = currentUpstreamUrl ? parsePlexSessionResource(currentUpstreamUrl) : null;

  if (currentSessionResource?.sessionId === sessionId) {
    return encodedResourceName;
  }

  if (currentUpstreamUrl?.pathname.toLowerCase().endsWith('/start.m3u8')) {
    return `session/${encodedSessionId}/sig/${encodedSignature}/base/${encodedResourceName}`;
  }

  return `/api/media/plex-transcode/${metadataId}/session/${encodedSessionId}/sig/${encodedSignature}/base/${encodedResourceName}`;
}

function buildSignedProxyUrl(metadataId: number, upstreamUrl: URL, config: AppConfig): string {
  if (!config.plexToken) {
    throw new Error('Plex proxy is not configured');
  }

  upstreamUrl.searchParams.delete('X-Plex-Token');
  upstreamUrl.hash = '';

  const encodedTarget = Buffer.from(upstreamUrl.toString(), 'utf8').toString('base64url');
  const signature = createProxySignature(encodedTarget, config.plexToken);
  const resourceName = getProxyResourceName(upstreamUrl);
  return `/api/media/plex-transcode/${metadataId}/proxy/${encodeURIComponent(resourceName)}?target=${encodeURIComponent(encodedTarget)}&sig=${encodeURIComponent(signature)}`;
}

function parsePlexSessionResource(upstreamUrl: URL): { sessionId: string; resourceName: string } | null {
  const match = upstreamUrl.pathname.match(/\/video\/:\/transcode\/universal\/session\/([^/]+)\/base\/([^/]+)$/);
  if (!match) {
    return null;
  }

  const sessionId = parseTranscodeSession(match[1]);
  const resourceName = parseSessionResourceName(match[2]);
  if (!sessionId || !resourceName) {
    return null;
  }

  return { sessionId, resourceName };
}

function getProxyResourceName(upstreamUrl: URL): string {
  const basename = path.posix.basename(upstreamUrl.pathname);
  if (basename && basename !== '.' && basename !== '/') {
    return basename;
  }

  if (upstreamUrl.pathname.toLowerCase().endsWith('.m3u8')) {
    return 'playlist.m3u8';
  }

  return 'resource.bin';
}

function decodeSignedProxyTarget(encodedTarget: string, signature: string, secret: string): URL {
  const expected = createProxySignature(encodedTarget, secret);
  if (!signaturesMatch(signature, expected)) {
    throw new Error('Invalid Plex proxy signature');
  }

  const decoded = Buffer.from(encodedTarget, 'base64url').toString('utf8');
  const url = new URL(decoded);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported Plex proxy protocol: ${url.protocol}`);
  }
  url.searchParams.delete('X-Plex-Token');
  url.hash = '';
  return url;
}

function createProxySignature(encodedTarget: string, secret: string): string {
  return createHmac('sha256', secret).update(encodedTarget).digest('base64url');
}

function createSessionProxySignature(
  metadataId: number,
  sessionId: string,
  secret: string,
): string {
  return createHmac('sha256', secret)
    .update(`${metadataId}:${sessionId}`)
    .digest('base64url');
}

function signaturesMatch(actual: string, expected: string): boolean {
  const actualBuf = Buffer.from(actual);
  const expectedBuf = Buffer.from(expected);

  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }

  return timingSafeEqual(actualBuf, expectedBuf);
}
