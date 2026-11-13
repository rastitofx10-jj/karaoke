/* TITO KARAOKE STUDIO v3.5 — DIRECT AUDIO RESOLVER (server only)
 *
 * The second full-song tier. The IFrame tier (browser probe gate) covers
 * sources the USER's browser is allowed to embed; this tier covers sources
 * THIS SERVER can extract — a different vantage point with a different
 * allowed set, so their union maximizes coverage.
 *
 * v3.5 — CLIENT ROTATION (hunted DNA: LuanRT/YouTube.js client roster).
 * A single innertube recipe (v3.4: VISIONOS only) dies the moment YouTube
 * walls that one client from datacenter IPs. The industry standard is a
 * rotation chain — every innertube client (IOS / ANDROID_VR / ANDROID_MUSIC /
 * VISIONOS / TV…) has a different bot-wall fingerprint, so when one is
 * walled the next still resolves. The chain, exact client versions, UAs and
 * numeric client ids are mined from the youtubei.js Constants (5.4k★, the
 * reference implementation), in the order most likely to return cipher-free
 * URLs without a PO token:
 *
 *   1. VISIONOS   (client id 101) — verified working from this machine
 *   2. ANDROID_VR (client id 28)  — Oculus Quest 3, verified cipher-free
 *   3. IOS        (client id 5)   — iPhone client, verified m4a/AAC direct
 *
 * (measured from this machine, 2026-11-14: ANDROID returns ciphered URLs
 *  needing a PO token, TVHTML5 is UNPLAYABLE, ANDROID_MUSIC refuses —
 *  the chain holds only VERIFIED clients so no stall budget is wasted
 *  on a client that can never resolve.)
 *
 * • resolved URLs are cached (success ~4h, failures 30min) and, because
 *   googlevideo URLs are IP-locked to the requester, the bytes are
 *   PROXIED through our own route — the browser must never see the
 *   upstream URL;
 * • every function is total: any failure degrades to null / 502, never
 *   a crash. The client treats "no direct audio" as "next tier".
 */

import { memGet, memSet, dedupe } from '@/lib/karaoke/discover-server';

/* ------------------------------------------------------------------ */
/* the client roster (hunted from youtubei.js Constants)                */
/* ------------------------------------------------------------------ */

interface ClientRecipe {
  /** clientName sent in the innertube context */
  name: string;
  /** numeric id for X-YouTube-Client-Name */
  id: string;
  version: string;
  userAgent: string;
  osName: string;
  osVersion: string;
  deviceMake?: string;
  deviceModel?: string;
  androidSdkVersion?: number;
}

const CLIENT_CHAIN: ClientRecipe[] = [
  {
    name: 'VISIONOS',
    id: '101',
    version: '1.02',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    osName: 'visionOS',
    osVersion: '26.5.23O471',
    deviceMake: 'Apple',
    deviceModel: 'RealityDevice17,1',
  },
  {
    name: 'ANDROID_VR',
    id: '28',
    version: '1.65.10',
    userAgent:
      'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    osName: 'Android',
    osVersion: '12L',
    deviceMake: 'Oculus',
    deviceModel: 'Quest 3',
    androidSdkVersion: 32,
  },
  {
    name: 'iOS',
    id: '5',
    version: '20.11.6',
    userAgent: 'com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)',
    osName: 'iOS',
    osVersion: '16.7.7.20H330',
    deviceMake: 'Apple',
    deviceModel: 'iPhone10,4',
  },
];

/* the UA of the recipe that resolved a URL must also fetch its bytes —
 * googlevideo URLs are bound to the client that requested them */
const RECIPE_BY_NAME = new Map(CLIENT_CHAIN.map((c) => [c.name, c]));

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

function innertubeBody(c: ClientRecipe, videoId: string): string {
  const client: Record<string, unknown> = {
    clientName: c.name,
    clientVersion: c.version,
    userAgent: c.userAgent,
    osName: c.osName,
    osVersion: c.osVersion,
    hl: 'en',
    gl: 'US',
  };
  if (c.deviceMake) client.deviceMake = c.deviceMake;
  if (c.deviceModel) client.deviceModel = c.deviceModel;
  if (c.androidSdkVersion) client.androidSdkVersion = c.androidSdkVersion;
  return JSON.stringify({
    context: {
      client,
    },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  });
}

/** One innertube player POST, as one client. Total: any failure → null. */
async function innertubePlayer(c: ClientRecipe, videoId: string): Promise<PlayerResponse | null> {
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': c.userAgent,
        'X-YouTube-Client-Name': c.id,
        'X-YouTube-Client-Version': c.version,
        Origin: 'https://www.youtube.com',
        'X-Origin': 'https://www.youtube.com',
        Referer: 'https://www.youtube.com/',
      },
      body: innertubeBody(c, videoId),
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
  /** the innertube client that resolved the URL — its UA must fetch the bytes */
  client: string;
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

/** Resolve a direct, cipher-free audio stream URL for a YouTube video,
 * rotating through the client chain until one resolves. Total: every
 * failure (network, bot wall on every client, no formats) → null (cached
 * briefly so repeat asks don't hammer the endpoints). */
export async function resolveDirectAudio(videoId: string): Promise<DirectAudioSource | null> {
  const id = videoId.trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  const key = `yt:audio:${id}`;
  /* walls are cached as a sentinel object (a stored null would read back
   * as a cache miss through memGet) */
  const cached = memGet<DirectAudioSource | { wall: true }>(key);
  if (cached) return 'wall' in cached ? null : cached;

  return await dedupe<DirectAudioSource | null>(key, async () => {
    for (const recipe of CLIENT_CHAIN) {
      const pr = await innertubePlayer(recipe, id);
      const status = pr?.playabilityStatus?.status ?? 'ERROR';
      const fmt = status === 'OK' ? pickAudioFormat(pr as PlayerResponse) : null;
      const url = fmt ? fmt.baseUrl || fmt.url || '' : '';
      if (!fmt || !url) continue; // this client is walled — next client

      const source: DirectAudioSource = {
        url,
        mimeType: fmt.mimeType ?? 'audio/mp4',
        itag: fmt.itag ?? 0,
        contentLength: Number(fmt.contentLength ?? 0) || 0,
        title: pr?.videoDetails?.title ?? '',
        author: pr?.videoDetails?.author ?? '',
        client: recipe.name,
      };
      memSet(key, source, RES_TTL_MS);
      return source;
    }
    /* every client in the chain is walled — cache the wall briefly */
    memSet(key, { wall: true }, WALL_TTL_MS);
    return null;
  });
}

/* ------------------------------------------------------------------ */
/* byte proxy (Range-aware passthrough)                                */
/* ------------------------------------------------------------------ */

/** Fetch a byte range (or the whole file) from the upstream googlevideo
 * URL with the same semantics the browser asked of us, impersonating the
 * innertube client that resolved the URL (googlevideo binds URLs to the
 * requesting client's UA). Total: any upstream failure → null; the route
 * turns that into a clean 502. */
export async function proxyDirectAudio(
  source: DirectAudioSource,
  rangeHeader: string | null,
): Promise<Response | null> {
  try {
    const ua = RECIPE_BY_NAME.get(source.client)?.userAgent ?? CLIENT_CHAIN[0].userAgent;
    const headers: Record<string, string> = {
      'User-Agent': ua,
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
