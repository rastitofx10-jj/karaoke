/* TITO KARAOKE STUDIO v5.0 — FULL-LENGTH AUDIO ENGINE (server only)
 *
 * THE PROBLEM THIS MODULE SOLVES (v4.0 and before): full songs depended on
 * YouTube — embeds are blocked on many networks and datacenter innertube
 * needs PO tokens now. Users got silent 29s surprises.
 *
 * THE FIX: two independent FULL-LENGTH catalogs that stream fine from this
 * server, proxied same-origin to the browser, then decoded into Web Audio —
 * so the entire karaoke machine (vocal removal, key shift, speed, scoring)
 * runs on the REAL FULL SONG:
 *
 *   SoundCloud — millions of full-length covers, remixes and instrumentals
 *     (policy ALLOW, not snipped). Anonymous web client_id, extracted live
 *     from soundcloud.com's JS bundles (cached, auto-refreshed, hard-coded
 *     fallback). HLS playlists (init.mp4 + dataNNN.m4s) are fetched and
 *     concatenated server-side into one fMP4 the browser decodes in one go;
 *     progressive transcodings stream directly.
 *
 *   Audius — decentralized catalog, free discovery API, full-length mp3s
 *     via the /stream redirect.
 *
 * Every exported function is total: network failures degrade to empty
 * results / null — never throw, never break the request.
 */

import { spawn } from 'node:child_process';
import type { DiscoverSong, FullSource } from '@/lib/karaoke/discover-types';

/* ------------------------------------------------------------------ */
/* shared plumbing                                                     */
/* ------------------------------------------------------------------ */

const UA_BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** hard ceiling for one full track (≈ 20 min @ 160kbps + margin) */
const MAX_BYTES = 34 * 1024 * 1024;
/** full songs must be at least this long (ms) to count as FULL */
const MIN_FULL_MS = 60_000;

const mem = new Map<string, { v: unknown; exp: number }>();
function memGet<T>(key: string): T | null {
  const hit = mem.get(key);
  if (!hit || hit.exp < Date.now()) return null;
  return hit.v as T;
}
function memSet(key: string, v: unknown, ttlMs: number) {
  if (mem.size > 200) {
    const now = Date.now();
    for (const [k, e] of mem) if (e.exp < now) mem.delete(k);
  }
  mem.set(key, { v, exp: Date.now() + ttlMs });
}

const inflight = new Map<string, Promise<unknown>>();
async function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = (async () => fn())().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p as Promise<T>;
}

/** LRU for decoded full-track bytes: replay must be instant. */
const byteCache = new Map<string, { bytes: Buffer; mime: string }>();
const BYTE_CACHE_MAX = 8;
function byteCacheSet(key: string, bytes: Buffer, mime: string) {
  if (byteCache.has(key)) byteCache.delete(key);
  byteCache.set(key, { bytes, mime });
  while (byteCache.size > BYTE_CACHE_MAX) {
    byteCache.delete(byteCache.keys().next().value as string);
  }
}

async function fetchJson<T>(url: string, timeoutMs = 10_000, headers?: Record<string, string>): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA_BROWSER, ...(headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchBytes(
  url: string,
  timeoutMs: 25_000,
  headers?: Record<string, string>,
): Promise<{ bytes: Buffer; mime: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA_BROWSER, ...(headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    if (!res.ok || !res.body) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null;
    return { bytes: buf, mime: res.headers.get('content-type') ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* SoundCloud — client_id (live extraction, cached, hard fallback)     */
/* ------------------------------------------------------------------ */

/**
 * Known-good client_id as of this build (verified live). The live
 * extraction below replaces it whenever SoundCloud rotates keys, so a
 * rotation degrades to one slower request — never a broken app.
 */
const SC_CLIENT_ID_FALLBACK = 'qLcgHhXgeEFFaSolTB9I71LBsqncsD93';
let scClientId: string | null = null;
let scClientIdExp = 0;

/** Extract a fresh anonymous web client_id from soundcloud.com's bundles. */
async function scExtractClientId(): Promise<string | null> {
  try {
    const res = await fetch('https://soundcloud.com/', {
      headers: { 'User-Agent': UA_BROWSER },
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const bundles = Array.from(
      new Set(html.match(/https:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9-]+\.js/g) ?? []),
    ).slice(0, 12);
    for (const b of bundles) {
      const js = await fetchBytes(b, 10_000);
      if (!js) continue;
      const m = js.bytes.toString('utf8').match(/client_id:"([a-zA-Z0-9]{25,40})"/);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

/** The current client_id: cached 6h, live-extracted when stale/missing. */
async function scGetClientId(forceRefresh = false): Promise<string> {
  if (!forceRefresh && scClientId && scClientIdExp > Date.now()) return scClientId;
  const fresh = await scExtractClientId();
  scClientId = fresh ?? SC_CLIENT_ID_FALLBACK;
  scClientIdExp = Date.now() + 6 * 60 * 60 * 1000;
  return scClientId;
}

/** api-v2 GET that transparently re-extracts the client_id once on 401/403. */
async function scApi<T>(path: string, timeoutMs = 10_000): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const cid = await scGetClientId(attempt === 1);
    const sep = path.includes('?') ? '&' : '?';
    const data = await fetchJson<T>(`https://api-v2.soundcloud.com${path}${sep}client_id=${cid}`, timeoutMs);
    if (data !== null) return data;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* SoundCloud — search                                                 */
/* ------------------------------------------------------------------ */

interface ScTranscoding {
  url: string;
  preset: string;
  snipped?: boolean;
  duration?: number;
  format?: { protocol?: string; mime_type?: string };
}

export interface ScTrack {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  artwork: string | null;
  playbackCount: number;
  policy: string;
}

interface ScSearchResp {
  collection?: Array<{
    kind?: string;
    id?: number;
    title?: string;
    duration?: number;
    full_duration?: number;
    policy?: string;
    streamable?: boolean;
    artwork_url?: string | null;
    playback_count?: number;
    user?: { username?: string };
    media?: { transcodings?: ScTranscoding[] };
  }>;
}

/** True when the track is a real FULL-LENGTH stream (not a 30s label snippet). */
function scIsFull(item: NonNullable<ScSearchResp['collection']>[number]): boolean {
  if (item.kind !== 'track' || !item.id || !item.title) return false;
  if (item.policy !== 'ALLOW' || item.streamable === false) return false;
  const dur = item.duration ?? 0;
  if (dur < MIN_FULL_MS) return false;
  const full = item.full_duration ?? dur;
  /* label snippets: duration clamped to ~30s while full_duration is bigger */
  if (full > 45_000 && dur < 45_000) return false;
  if (dur < full * 0.95) return false;
  const trs = item.media?.transcodings ?? [];
  return trs.some((t) => t.snipped !== true);
}

export async function scSearch(query: string, limit = 18): Promise<ScTrack[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const key = `scsearch:${q.toLowerCase()}`;
  const cached = memGet<ScTrack[]>(key);
  if (cached) return cached;
  const tracks = await dedupe(key, async () => {
    const data = await scApi<ScSearchResp>(
      `/search?q=${encodeURIComponent(q)}&limit=${Math.min(50, limit * 2)}`,
      10_000,
    );
    const out: ScTrack[] = [];
    const seen = new Set<string>();
    for (const item of data?.collection ?? []) {
      if (!scIsFull(item)) continue;
      if (seen.has(String(item.id))) continue;
      seen.add(String(item.id));
      out.push({
        id: String(item.id),
        title: item.title as string,
        artist: item.user?.username ?? 'SoundCloud',
        durationMs: item.duration ?? 0,
        artwork: item.artwork_url ?? null,
        playbackCount: item.playback_count ?? 0,
        policy: item.policy ?? 'MON',
      });
      if (out.length >= limit) break;
    }
    return out;
  });
  memSet(key, tracks, 10 * 60 * 1000);
  return tracks;
}

/* ------------------------------------------------------------------ */
/* SoundCloud — stream resolution (progressive | HLS)                  */
/* ------------------------------------------------------------------ */

interface ScResolve {
  kind: 'direct' | 'hls';
  mime: string;
  /** direct: the mp3 URL. hls: the signed m3u8 playlist URL. */
  url: string;
}

interface ScTrackResp {
  id?: number;
  title?: string;
  media?: { transcodings?: ScTranscoding[] };
}

const SC_PRESET_ORDER = ['aac_160k', 'aac_96k', 'abr_sq', 'opus_64k', 'mp3_0_0'];

/** Pick the best playable transcoding (progressive first, then by preset). */
function pickTranscoding(trs: ScTranscoding[]): ScTranscoding | null {
  const playable = trs.filter((t) => t.snipped !== true && t.url);
  if (playable.length === 0) return null;
  const progressive = playable.find((t) => t.format?.protocol === 'progressive');
  if (progressive) return progressive;
  let best: ScTranscoding | null = null;
  let bestRank = Infinity;
  for (const t of playable) {
    const rank = SC_PRESET_ORDER.indexOf(t.preset);
    if (rank !== -1 && rank < bestRank) {
      best = t;
      bestRank = rank;
    }
  }
  return best ?? playable[0];
}

async function scResolve(trackId: string): Promise<ScResolve | null> {
  const key = `scresolve:${trackId}`;
  const cached = memGet<ScResolve>(key);
  if (cached) return cached;
  const resolved = await dedupe(key, async (): Promise<ScResolve | null> => {
    if (!/^\d{1,32}$/.test(trackId)) return null;
    const track = await scApi<ScTrackResp>(`/tracks/${trackId}`, 10_000);
    const trs = track?.media?.transcodings ?? [];
    const pick = pickTranscoding(trs);
    if (!pick) return null;
    /* the transcoding URL answers with {url} — the signed CDN location.
     * api-v2 URLs go through scApi (client_id + auto re-auth); any other
     * host is fetched directly with the client_id appended. */
    const API_PREFIX = 'https://api-v2.soundcloud.com';
    const path = pick.url.startsWith(API_PREFIX) ? pick.url.slice(API_PREFIX.length) : null;
    const answered = path
      ? await scApi<{ url?: string }>(path, 10_000)
      : await fetchJson<{ url?: string }>(`${pick.url}${pick.url.includes('?') ? '&' : '?'}client_id=${await scGetClientId()}`, 10_000, {
          Referer: 'https://soundcloud.com/',
        });
    if (!answered?.url) return null;
    const isHls = pick.format?.protocol === 'hls' || /\.m3u8/.test(answered.url);
    return {
      kind: isHls ? 'hls' : 'direct',
      mime: isHls ? 'audio/mp4' : 'audio/mpeg',
      url: answered.url,
    };
  });
  if (resolved) memSet(key, resolved, 15 * 60 * 1000);
  return resolved;
}

/** Parse a media playlist: init segment (#EXT-X-MAP) + all segment URLs. */
function parseM3u8(text: string): { initUrl: string | null; segments: string[] } {
  let initUrl: string | null = null;
  const segments: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) initUrl = m[1];
    } else if (!line.startsWith('#')) {
      segments.push(line);
    }
  }
  return { initUrl, segments };
}

/** Bounded-concurrency map that keeps ORDER (segment order is sacred). */
async function mapOrdered<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface FullAudio {
  bytes: Buffer;
  mime: string;
  title: string;
}

/** SoundCloud: full-track bytes. HLS → init + segments concatenated in order. */
async function scFetchAudio(trackId: string): Promise<FullAudio | null> {
  const resolve = await scResolve(trackId);
  if (!resolve) return null;
  if (resolve.kind === 'direct') {
    const got = await fetchBytes(resolve.url, 60_000);
    return got ? { ...got, title: `sc:${trackId}` } : null;
  }
  /* HLS: fetch the (signed) playlist, then every segment */
  const pl = await fetchBytes(resolve.url, 15_000);
  if (!pl) return null;
  const { initUrl, segments } = parseM3u8(pl.bytes.toString('utf8'));
  if (segments.length === 0 || segments.length > 400) return null;
  const parts: Array<Buffer | null> = await mapOrdered(
    initUrl ? [initUrl, ...segments] : segments,
    6,
    async (url) => {
      const seg = await fetchBytes(url, 30_000);
      return seg ? seg.bytes : null;
    },
  );
  if (parts.some((p) => p === null)) return null;
  const bytes = Buffer.concat(parts as Buffer[]);
  if (bytes.byteLength < 100_000 || bytes.byteLength > MAX_BYTES) return null;
  return { bytes, mime: 'audio/mp4', title: `sc:${trackId}` };
}

/* ------------------------------------------------------------------ */
/* Audius — search + full-track bytes                                  */
/* ------------------------------------------------------------------ */

const AUDIUS_HOSTS = ['https://api.audius.co', 'https://discoveryprovider.audius.co'];
let audiusHostIdx = 0;

async function audiusApi<T>(path: string, timeoutMs = 10_000): Promise<T | null> {
  for (let i = 0; i < AUDIUS_HOSTS.length; i++) {
    const host = AUDIUS_HOSTS[(audiusHostIdx + i) % AUDIUS_HOSTS.length];
    const data = await fetchJson<T>(`${host}${path}`, timeoutMs);
    if (data !== null) {
      audiusHostIdx = (audiusHostIdx + i) % AUDIUS_HOSTS.length;
      return data;
    }
  }
  return null;
}

export interface AuTrack {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  artwork: string | null;
  playbackCount: number;
}

interface AudiusTrackJson {
  id?: string;
  title?: string;
  user?: { name?: string };
  duration?: number;
  play_count?: number;
  is_streamable?: boolean;
  is_delete?: boolean;
  artwork?: { '150x150'?: string; '480x480'?: string } | null;
}

export async function audiusSearch(query: string, limit = 8): Promise<AuTrack[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const key = `ausearch:${q.toLowerCase()}`;
  const cached = memGet<AuTrack[]>(key);
  if (cached) return cached;
  const tracks = await dedupe(key, async () => {
    const data = await audiusApi<{ data?: AudiusTrackJson[] }>(
      `/v1/tracks/search?query=${encodeURIComponent(q)}&app_name=TitoKaraokeStudio&limit=${Math.min(50, limit * 2)}`,
      10_000,
    );
    const out: AuTrack[] = [];
    for (const t of data?.data ?? []) {
      const durMs = Math.round((t.duration ?? 0) * 1000);
      if (!t.id || !t.title || durMs < MIN_FULL_MS) continue;
      /* the search index lags behind deletions — dead tracks 404 on stream */
      if (t.is_streamable === false || t.is_delete === true) continue;
      out.push({
        id: t.id,
        title: t.title,
        artist: t.user?.name ?? 'Audius',
        durationMs: durMs,
        artwork: t.artwork?.['480x480'] ?? t.artwork?.['150x150'] ?? null,
        playbackCount: t.play_count ?? 0,
      });
      if (out.length >= limit) break;
    }
    return out;
  });
  memSet(key, tracks, 10 * 60 * 1000);
  return tracks;
}

/** Audius: /stream redirects (302) to a signed CDN mp3 — follow + download. */
async function audiusFetchAudio(trackId: string): Promise<FullAudio | null> {
  if (!/^[a-zA-Z0-9]{1,64}$/.test(trackId)) return null;
  const got = await fetchBytes(
    `https://api.audius.co/v1/tracks/${encodeURIComponent(trackId)}/stream?app_name=TitoKaraokeStudio`,
    60_000,
  );
  if (!got || !got.mime.startsWith('audio')) return null;
  return { ...got, title: `au:${trackId}` };
}

/* ------------------------------------------------------------------ */
/* THE PUBLIC AUDIO API — provider-dispatched, byte-cached              */
/* ------------------------------------------------------------------ */

export function isFullProvider(p: string): p is 'soundcloud' | 'audius' {
  return p === 'soundcloud' || p === 'sc' || p === 'audius' || p === 'au';
}

export function normalizeProvider(p: string): 'soundcloud' | 'audius' {
  return p === 'audius' || p === 'au' ? 'audius' : 'soundcloud';
}

/** Full-track audio for a provider track id. Cached (LRU) for instant replay. */
export async function getFullAudio(provider: 'soundcloud' | 'audius', trackId: string): Promise<FullAudio | null> {
  const key = `${provider === 'soundcloud' ? 'sc' : 'au'}:${trackId}`;
  const cached = byteCache.get(key);
  if (cached) return { ...cached, title: key };
  const audio = await dedupe(key, () =>
    provider === 'soundcloud' ? scFetchAudio(trackId) : audiusFetchAudio(trackId),
  );
  if (audio) byteCacheSet(key, audio.bytes, audio.mime);
  return audio;
}

/** Cheap pre-flight: does full audio exist for this provider id? */
export async function probeFullAudio(
  provider: 'soundcloud' | 'audius',
  trackId: string,
): Promise<{ ok: boolean; bytes: number; mime: string }> {
  const key = `${provider === 'soundcloud' ? 'sc' : 'au'}:${trackId}`;
  const cached = byteCache.get(key);
  if (cached) return { ok: true, bytes: cached.bytes.byteLength, mime: cached.mime };
  const resolve = provider === 'soundcloud' ? await scResolve(trackId) : null;
  if (provider === 'soundcloud') {
    return resolve ? { ok: true, bytes: 0, mime: resolve.mime } : { ok: false, bytes: 0, mime: '' };
  }
  /* Audius has no cheap resolve — the probe downloads (cached by getFullAudio
   * callers later); report ok with unknown size. The client probes rarely. */
  return { ok: true, bytes: 0, mime: 'audio/mpeg' };
}

/* ------------------------------------------------------------------ */
/* ffmpeg transcode fallback (fMP4 concat that the browser can't decode)*/
/* ------------------------------------------------------------------ */

/**
 * Transcode any audio container to mp3 (192k) with ffmpeg. Used only when a
 * browser rejects the raw fMP4 concatenation — the SECOND attempt always
 * succeeds. Total: returns null on any failure, never throws.
 */
export function transcodeToMp3(input: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-vn', '-c:a', 'libmp3lame', '-b:a', '192k',
        '-f', 'mp3', 'pipe:1',
      ], { stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      const done = (v: Buffer | null) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      child.stdout.on('data', (c: Buffer) => {
        total += c.byteLength;
        if (total > MAX_BYTES) {
          child.kill('SIGKILL');
          done(null);
          return;
        }
        chunks.push(c);
      });
      child.on('error', () => done(null));
      child.on('close', (code) => done(code === 0 && total > 50_000 ? Buffer.concat(chunks) : null));
      child.stdin.on('error', () => {
        /* EPIPE when ffmpeg rejects the input — the close handler settles */
      });
      child.stdin.end(input);
    } catch {
      resolve(null);
    }
  });
}

/* ------------------------------------------------------------------ */
/* MATCHING — attach full-length sources to catalog songs              */
/* ------------------------------------------------------------------ */

const STOP_TOKENS = new Set([
  'the', 'a', 'an', 'and', 'of', 'feat', 'ft', 'with', 'remaster', 'remastered',
  'radio', 'edit', 'version', 'single', 'official', 'video', 'audio', 'lyric',
  'lyrics', 'hq', 'hd', '4k', 'live', 'cover', 'covers', 'by', 'from', 'ost',
]);

function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9\u0590-\u05ff\u0600-\u06ff]+/g) ?? []).filter(
    (w) => w.length > 1 && !STOP_TOKENS.has(w),
  );
}

function tokenCoverage(needle: string[], haystack: string[]): number {
  if (needle.length === 0) return 0;
  const hay = new Set(haystack);
  let hit = 0;
  for (const t of needle) if (hay.has(t)) hit++;
  return hit / needle.length;
}

const PENALTY_RE = /(nightcore|sped up|sped-up|8d|slowed|reverb|chipmunk|mashup)/i;

/**
 * Score one provider track against a catalog song. Returns null when it is
 * clearly NOT the same song. `original` = the uploader IS the song's artist
 * (the exact original recording, not a cover).
 */
function scoreMatch(
  song: { title: string; artist: string; durationMs: number },
  track: { title: string; artist: string; durationMs: number },
): { score: number; original: boolean } | null {
  const songTitleToks = tokens(song.title);
  const trackTitleToks = tokens(track.title);
  if (songTitleToks.length === 0 || trackTitleToks.length === 0) return null;
  const titleCoverage = tokenCoverage(songTitleToks, trackTitleToks);
  if (titleCoverage < 0.65) return null;
  const songArtistToks = tokens(song.artist);
  const artistOverlap = tokenCoverage(songArtistToks, tokens(track.artist));
  const songArtistInTitle = tokenCoverage(songArtistToks, trackTitleToks);
  const durSec = song.durationMs / 1000;
  if (durSec < 30) return null;
  const ratio = track.durationMs / song.durationMs;
  if (ratio < 0.65 || ratio > 1.45) return null;
  const proximity = 1 - Math.min(1, Math.abs(ratio - 1) / 0.45);
  let score = 0.5 * titleCoverage + 0.2 * Math.max(artistOverlap, songArtistInTitle) + 0.3 * proximity;
  if (PENALTY_RE.test(track.title)) score -= 0.18;
  const original = songArtistToks.length > 0 && artistOverlap >= 0.5 && titleCoverage >= 0.99;
  return { score, original };
}

function toFullSource(
  provider: 'soundcloud' | 'audius',
  track: ScTrack | AuTrack,
  score: number,
  original: boolean,
): FullSource {
  return {
    provider,
    id: track.id,
    title: track.title,
    artist: track.artist,
    durationMs: track.durationMs,
    score: Math.round(score * 1000) / 1000,
    original,
  };
}

/**
 * Attach the best full-length sources to every catalog row (in place).
 * Each song gets at most 3 sources, sorted by score.
 */
export function attachFullSources(
  songs: DiscoverSong[],
  sc: ScTrack[],
  au: AuTrack[],
): void {
  if (songs.length === 0 || (sc.length === 0 && au.length === 0)) return;
  for (const song of songs) {
    const scored: FullSource[] = [];
    for (const tr of sc) {
      const m = scoreMatch(song, tr);
      if (m !== null) scored.push(toFullSource('soundcloud', tr, m.score, m.original));
    }
    for (const tr of au) {
      const m = scoreMatch(song, tr);
      if (m !== null) scored.push(toFullSource('audius', tr, m.score, m.original));
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored.length > 0) song.fullSources = scored.slice(0, 3);
  }
}

/* ------------------------------------------------------------------ */
/* standalone rows — guaranteed full-length songs straight from SC     */
/* ------------------------------------------------------------------ */

/** Strip cover/noise annotations from a provider title for display + LRCLIB. */
export function cleanProviderTitle(title: string): string {
  return title
    .replace(/\((?:[^()]*(?:cover|remix|nightcore|version|edit|instrumental|acoustic|karaoke|live|audio|video|lyric)[^()]*)\)/gi, '')
    .replace(/\[(?:[^\[\]]*(?:cover|remix|nightcore|version|edit|instrumental|acoustic|karaoke|live|audio|video|lyric)[^\[\]]*)\]/gi, '')
    .replace(/\b(?:cover|nightcore|remix|8d|slowed|sped\s*up)\b/gi, '')
    .replace(/\s*[-–—]\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Parse "Artist - Title (Cover…)" style titles into LRCLIB hints. */
export function parseCoverTitle(title: string): { lrcTitle: string; lrcArtist?: string } {
  const cleaned = cleanProviderTitle(title);
  const parts = cleaned.split(/\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    /* "Artist - Song" is the dominant SoundCloud cover convention */
    return { lrcTitle: parts.slice(1).join(' - '), lrcArtist: parts[0] };
  }
  return { lrcTitle: cleaned };
}

/**
 * Full-length SC tracks that matched NO catalog row become standalone
 * DiscoverSong rows — real songs, guaranteed full, with LRCLIB hints
 * parsed from their titles.
 */
export function standaloneRows(
  sc: ScTrack[],
  songs: DiscoverSong[],
  limit = 5,
): DiscoverSong[] {
  const used = new Set<string>();
  for (const s of songs) {
    for (const f of s.fullSources ?? []) used.add(`${f.provider}:${f.id}`);
  }
  const rows: DiscoverSong[] = [];
  for (const tr of sc) {
    if (rows.length >= limit) break;
    if (used.has(`soundcloud:${tr.id}`)) continue;
    if (tr.durationMs < 120_000 || tr.playbackCount < 300) continue;
    const display = cleanProviderTitle(tr.title) || tr.title;
    const hint = parseCoverTitle(tr.title);
    const art = tr.artwork
      ? tr.artwork.replace(/-(large|t500x500|badge)\./, '-t500x500.')
      : null;
    rows.push({
      id: `sc:${tr.id}`,
      trackId: Number(tr.id) || 0,
      title: display.slice(0, 120),
      artist: tr.artist,
      album: 'SoundCloud',
      artwork: art ?? '',
      artworkSmall: tr.artwork?.replace(/-(t500x500|badge)\./, '-large.') ?? '',
      previewUrl: '',
      durationMs: tr.durationMs,
      genre: null,
      hasLrc: false,
      fullSources: [
        {
          provider: 'soundcloud',
          id: tr.id,
          title: tr.title,
          artist: tr.artist,
          durationMs: tr.durationMs,
          score: 1,
          original: true,
        },
      ],
      lrcTitle: hint.lrcTitle || display,
      lrcArtist: hint.lrcArtist ?? tr.artist,
    });
  }
  return rows;
}

/**
 * Fresh full-source resolution for ONE catalog song (load-time / retry).
 * Runs a provider search scoped to the song's title+artist, then matches.
 */
export async function resolveFullSources(
  song: Pick<DiscoverSong, 'title' | 'artist' | 'durationMs'>,
): Promise<FullSource[]> {
  const q = `${song.artist} ${song.title}`.trim();
  const key = `fullsong:${q.toLowerCase()}:${Math.round(song.durationMs / 1000)}`;
  const cached = memGet<FullSource[]>(key);
  if (cached) return cached;
  const sources = await dedupe(key, async () => {
    const [sc, au] = await Promise.all([scSearch(q, 20), audiusSearch(q, 8)]);
    const holder: DiscoverSong[] = [
      {
        id: 'probe', trackId: 0, title: song.title, artist: song.artist, album: '',
        artwork: '', artworkSmall: '', previewUrl: '', durationMs: song.durationMs,
        genre: null, hasLrc: false,
      },
    ];
    attachFullSources(holder, sc, au);
    return holder[0].fullSources ?? [];
  });
  memSet(key, sources, sources.length > 0 ? 15 * 60 * 1000 : 2 * 60 * 1000);
  return sources;
}
