/* TITO KARAOKE STUDIO v3.4 — DIRECT AUDIO RESOLVER (server only)
 *
 * The second full-song tier. The IFrame tier (browser probe gate) covers
 * sources the USER's browser is allowed to embed; this tier covers sources
 * THIS SERVER can extract — a different vantage point with a different
 * allowed set, so their union maximizes coverage:
 *
 *   • visionos innertube player POST (clientName VISIONOS, id 101) — the
 *     one recipe verified from this machine to return cipher-free direct
 *     googlevideo URLs (itag 140 m4a AAC) with no JS-player deciphering;
 *   • resolved URLs are cached (success ~4h, failures 30min) and, because
 *     googlevideo URLs are IP-locked to the requester, the bytes are
 *     PROXIED through our own route — the browser must never see the
 *     upstream URL;
 *   • every function is total: any failure degrades to null / 502, never
 *     a crash. The client treats "no direct audio" as "next tier".
 */

import { memGet, memSet, dedupe } from '@/lib/karaoke/discover-server';

/* ------------------------------------------------------------------ */
/* visionos innertube player request                                   */
/* ------------------------------------------------------------------ */

const VISIONOS_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

interface InnertubeFormat {
  itag?: number;
  mimeType?: string;
  baseUrl?: string;
  url?: string;
  contentLength?: string;
  bitrate?: number;
  averageBitrate?: number;
}

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  streamingData?: { adaptiveFormats?: InnertubeFormat[] };
  videoDetails?: { title?: string; author?: string; lengthSeconds?: string };
}

/** Preferred audio itags in order: 140 = m4a AAC 128k (universal
 *  decodeAudioData support), 251/250/249 = WebM Opus/Vorbis fallbacks. */
const AUDIO_ITAG_PRIORITY = [140, 251, 250, 249, 139];

async function visionosPlayer(videoId: string): Promise<PlayerResponse | null> {
  try {
    const body = JSON.stringify({
      context: {
        client: {
          clientName: 'VISIONOS',
          clientVersion: '1.02',
          deviceMake: 'Apple',
          deviceModel: 'RealityDevice17,1',
          userAgent: VISIONOS_UA,
          osName: 'visionOS',
          osVersion: '26.5.23O471',
          hl: 'en',
          gl: 'US',
        },
      },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    });
    const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': VISIONOS_UA,
        'X-YouTube-Client-Name': '101',
        'X-YouTube-Client-Version': '1.02',
        Origin: 'https://www.youtube.com',
        'X-Origin': 'https://www.youtube.com',
        Referer: 'https://www.youtube.com/',
      },
      body,
      signal: AbortSignal.timeout(9000),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as PlayerResponse;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* resolution                                                          */
/* ------------------------------------------------------------------ */

export interface DirectAudioSource {
  /** the upstream googlevideo URL (IP-locked to this server — proxy only) */
  url: string;
  mimeType: string;
  itag: number;
  contentLength: number;
  title: string;
  author: string;
}

/* resolved sources stick 4h (URLs live ~6h); walls stick 30min so a user
 * retry has a chance without hammering the innertube endpoint */
const RES_TTL_MS = 4 * 60 * 60 * 1000;
const WALL_TTL_MS = 30 * 60 * 1000;

function pickAudioFormat(pr: PlayerResponse): InnertubeFormat | null {
  const fmts = pr.streamingData?.adaptiveFormats ?? [];
  const audio = fmts.filter((f) => typeof f.mimeType === 'string' && f.mimeType.startsWith('audio/'));
  for (const itag of AUDIO_ITAG_PRIORITY) {
    const hit = audio.find((f) => f.itag === itag && (f.baseUrl || f.url));
    if (hit) return hit;
  }
  /* anything audio-shaped with a URL beats nothing */
  const any = audio.find((f) => f.baseUrl || f.url);
  return any ?? null;
}

/** Resolve a direct, cipher-free audio stream URL for a YouTube video.
 * Total: every failure (network, bot wall, no formats) → null (cached
 * briefly so repeat asks don't hammer the endpoint). */
export async function resolveDirectAudio(videoId: string): Promise<DirectAudioSource | null> {
  const id = videoId.trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  const key = `yt:audio:${id}`;
  /* walls are cached as a sentinel object (a stored null would read back
   * as a cache miss through memGet) */
  const cached = memGet<DirectAudioSource | { wall: true }>(key);
  if (cached) return 'wall' in cached ? null : cached;

  return await dedupe<DirectAudioSource | null>(key, async () => {
    const pr = await visionosPlayer(id);
    const status = pr?.playabilityStatus?.status ?? 'ERROR';
    const fmt = status === 'OK' ? pickAudioFormat(pr as PlayerResponse) : null;
    const url = fmt ? fmt.baseUrl || fmt.url || '' : '';
    if (!fmt || !url) {
      memSet(key, { wall: true }, WALL_TTL_MS);
      return null;
    }
    const source: DirectAudioSource = {
      url,
      mimeType: fmt.mimeType ?? 'audio/mp4',
      itag: fmt.itag ?? 0,
      contentLength: Number(fmt.contentLength ?? 0) || 0,
      title: pr?.videoDetails?.title ?? '',
      author: pr?.videoDetails?.author ?? '',
    };
    memSet(key, source, RES_TTL_MS);
    return source;
  });
}

/* ------------------------------------------------------------------ */
/* byte proxy (Range-aware passthrough)                                */
/* ------------------------------------------------------------------ */

/** Fetch a byte range (or the whole file) from the upstream googlevideo
 * URL with the same semantics the browser asked of us. Total: any
 * upstream failure → null; the route turns that into a clean 502. */
export async function proxyDirectAudio(
  source: DirectAudioSource,
  rangeHeader: string | null,
): Promise<Response | null> {
  try {
    const headers: Record<string, string> = {
      'User-Agent': VISIONOS_UA,
      Accept: '*/*',
      Referer: 'https://www.youtube.com/',
      Origin: 'https://www.youtube.com',
    };
    if (rangeHeader) headers.Range = rangeHeader;
    const res = await fetch(source.url, {
      headers,
      signal: AbortSignal.timeout(20_000),
      cache: 'no-store',
      redirect: 'follow',
    });
    if (!res.ok && res.status !== 206) return null;
    if (!res.body) return null;
    return res;
  } catch {
    return null;
  }
}
