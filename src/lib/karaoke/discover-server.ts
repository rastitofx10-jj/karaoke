/* TITO KARAOKE STUDIO v2.0 — DISCOVER ENGINE (server only)
 *
 * Search & charts: iTunes Search API (official 30s preview clips, artwork,
 * metadata) + Apple RSS charts. Lyrics: LRCLIB (synced LRC for full songs).
 *
 * The crown jewel — AI PREVIEW SYNC:
 * iTunes preview clips are 30-second excerpts cut from the middle of the
 * song, so full-song LRC timestamps never line up with a clip. We fix this
 * automatically:
 *   1. fetch the clip, downmix it to 16 kHz mono WAV (ffmpeg)
 *   2. transcribe it with the ASR model (z-ai-web-dev-sdk, server side)
 *   3. fuzzy-align the transcript against the LRC lines (sliding window,
 *      Levenshtein-tolerant word matching)
 *   4. derive the clip's start offset from the first/last matched lines
 *   5. shift every LRC timestamp into the clip's timeline
 * The offset is cached in SQLite per preview URL (computed once, forever).
 *
 * Caching: TTL memory cache + in-flight de-dup + SQLite for offsets and
 * play counters. Every exported function is total: network/DB failures
 * degrade gracefully and never throw.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { db } from '@/lib/db';
import type { DiscoverSong, PrepareResult } from '@/lib/karaoke/discover-types';
import { parseLrc, serializeLrc } from '@/lib/karaoke/lrc';
import type { LrcLine } from '@/lib/karaoke/types';

/* ------------------------------------------------------------------ */
/* memory cache + in-flight de-dup                                     */
/* ------------------------------------------------------------------ */

const mem = new Map<string, { v: unknown; exp: number }>();
const MEM_MAX = 300;

export function memGet<T>(key: string): T | null {
  const hit = mem.get(key);
  if (!hit) return null;
  if (hit.exp < Date.now()) {
    mem.delete(key);
    return null;
  }
  return hit.v as T;
}

export function memSet(key: string, v: unknown, ttlMs: number): void {
  if (mem.size >= MEM_MAX) {
    const oldest = mem.keys().next().value;
    if (oldest !== undefined) mem.delete(oldest);
  }
  mem.set(key, { v, exp: Date.now() + ttlMs });
}

const inflight = new Map<string, Promise<unknown>>();

/** Run `fn` once for concurrent callers with the same key. */
export async function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fn().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

/* ------------------------------------------------------------------ */
/* shared http helpers                                                 */
/* ------------------------------------------------------------------ */

const UA = 'TitoKaraokeStudio/2.0 (browser karaoke; +https://localhost)';

async function getJson<T>(url: string, timeoutMs = 8000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Only Apple media hosts may be proxied / fetched (SSRF guard). */
export function isAllowedPreview(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h.endsWith('.apple.com') || h.endsWith('.mzstatic.com') || h.endsWith('.akamai.net');
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* iTunes catalog                                                      */
/* ------------------------------------------------------------------ */

interface ItunesTrack {
  trackId?: number;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  artworkUrl100?: string;
  previewUrl?: string;
  trackTimeMillis?: number;
  primaryGenreType?: string;
  kind?: string;
}

function upscaleArt(url: string, size: string): string {
  return url.replace(/\/\d+x\d+bb\./, `/${size}bb.`);
}

function mapTrack(r: ItunesTrack): DiscoverSong | null {
  if (!r.previewUrl || r.kind !== 'song' || typeof r.trackId !== 'number') return null;
  if (!r.trackName || !r.artistName) return null;
  const art = typeof r.artworkUrl100 === 'string' ? r.artworkUrl100 : '';
  return {
    id: `itunes:${r.trackId}`,
    trackId: r.trackId,
    title: r.trackName,
    artist: r.artistName,
    album: typeof r.collectionName === 'string' ? r.collectionName : '',
    artwork: art ? upscaleArt(art, '600x600') : '',
    artworkSmall: art ? upscaleArt(art, '200x200') : '',
    previewUrl: r.previewUrl,
    durationMs: typeof r.trackTimeMillis === 'number' ? r.trackTimeMillis : 0,
    genre: typeof r.primaryGenreType === 'string' ? r.primaryGenreType : null,
    hasLrc: false,
  };
}

export async function itunesSearch(term: string, limit = 24, country = 'IL'): Promise<DiscoverSong[]> {
  const url =
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}` +
    `&media=music&entity=song&limit=${limit}&country=${country}`;
  const data = await getJson<{ results?: ItunesTrack[] }>(url);
  if (!data?.results) return [];
  const seen = new Set<string>();
  const out: DiscoverSong[] = [];
  for (const r of data.results) {
    const s = mapTrack(r);
    if (!s) continue;
    const key = `${s.artist.toLowerCase()}|${s.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export async function itunesLookup(ids: string[]): Promise<DiscoverSong[]> {
  if (ids.length === 0) return [];
  const url = `https://itunes.apple.com/lookup?id=${ids.join(',')}&entity=song`;
  const data = await getJson<{ results?: ItunesTrack[] }>(url);
  if (!data?.results) return [];
  const out: DiscoverSong[] = [];
  const seen = new Set<number>();
  for (const r of data.results) {
    const s = mapTrack(r);
    if (!s || seen.has(s.trackId)) continue;
    seen.add(s.trackId);
    out.push(s);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* LRCLIB                                                              */
/* ------------------------------------------------------------------ */

export interface LrcHit {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string | null;
  duration?: number | null;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

export async function lrclibSearch(
  params: { artist?: string; title?: string; q?: string },
  timeoutMs = 5000,
): Promise<LrcHit[]> {
  const qs =
    params.q !== undefined
      ? `q=${encodeURIComponent(params.q)}`
      : `track_name=${encodeURIComponent(params.title ?? '')}&artist_name=${encodeURIComponent(params.artist ?? '')}`;
  const data = await getJson<LrcHit[] | { [k: string]: unknown }[]>(`https://lrclib.net/api/search?${qs}`, timeoutMs);
  return Array.isArray(data) ? (data as LrcHit[]).slice(0, 8) : [];
}

/**
 * Polite LRCLIB badge enrichment: limited concurrency, per-call timeout and
 * an overall budget — when LRCLIB is slow, badges simply don't light up and
 * the lyrics lookup happens later, at prepare time. Never throws.
 */
export async function enrichHasLrc(
  songs: DiscoverSong[],
  opts: { concurrency?: number; perCallMs?: number; budgetMs?: number } = {},
): Promise<void> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const perCallMs = Math.max(500, opts.perCallMs ?? 2500);
  const budgetMs = Math.max(500, opts.budgetMs ?? 4000);
  const deadline = Date.now() + budgetMs;
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < songs.length && Date.now() < deadline) {
      const s = songs[idx++];
      try {
        const hits = await lrclibSearch(
          { artist: s.artist, title: s.title },
          Math.min(perCallMs, Math.max(500, deadline - Date.now())),
        );
        s.hasLrc = hits.some((h) => h.syncedLyrics && !h.instrumental);
      } catch {
        s.hasLrc = false;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

const normName = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Pick the hit that best matches artist/title/duration, preferring synced. */
export function pickBestHit(hits: LrcHit[], artist: string, title: string, durationSec?: number): LrcHit | null {
  const na = normName(artist);
  const nt = normName(title);
  let best: LrcHit | null = null;
  let bestScore = -Infinity;
  for (const h of hits) {
    if (h.instrumental) continue;
    if (!h.syncedLyrics && !h.plainLyrics) continue;
    let score = h.syncedLyrics ? 12 : 2;
    const ha = normName(h.artistName ?? '');
    const ht = normName(h.trackName ?? '');
    if (ha && na) {
      if (ha === na) score += 8;
      else if (ha.includes(na) || na.includes(ha)) score += 4;
    }
    if (ht && nt) {
      if (ht === nt) score += 6;
      else if (ht.includes(nt) || nt.includes(ht)) score += 3;
    }
    if (durationSec && typeof h.duration === 'number') {
      score -= Math.min(Math.abs(h.duration - durationSec), 40);
    }
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* AI preview sync — alignment                                         */
/* ------------------------------------------------------------------ */

function normWord(w: string): string {
  return w
    .toLowerCase()
    .replace(/[\u0591-\u05C7]/g, '') // strip Hebrew niqqud
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Small bounded Levenshtein (early exit when the row min explodes). */
function lev(a: string, b: string): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  let prev = new Array<number>(lb + 1);
  let cur = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > 4) return 5; // beyond tolerance — bail out
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[lb];
}

function wordEq(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === 0 || b.length === 0) return false;
  if (Math.abs(a.length - b.length) > 2) return false;
  const tol = Math.max(a.length, b.length) >= 6 ? 2 : 1;
  return lev(a, b) <= tol;
}

export interface AlignResult {
  offsetSec: number | null;
  confidence: number;
  matched: number;
  ratio: number;
  startLine: number;
  endLine: number;
}

const EMPTY_ALIGN: AlignResult = { offsetSec: null, confidence: 0, matched: 0, ratio: 0, startLine: -1, endLine: -1 };

/**
 * Aligns an ASR transcript of the 30s preview against full-song LRC lines
 * and returns the preview's start offset inside the full song.
 *
 * Sliding window over LRC line starts; inside a window, consecutive lines
 * greedily consume transcript words (Levenshtein-tolerant). The offset is
 * estimated from the first matched line (preview starts ≈ its timestamp)
 * and cross-checked against the line following the last match (its
 * timestamp ≈ preview end). Never throws.
 */
export function alignPreviewOffset(transcript: string, lines: LrcLine[], previewDurSec: number): AlignResult {
  try {
    const tWords = (typeof transcript === 'string' ? transcript : '')
      .split(/\s+/)
      .map(normWord)
      .filter((w) => w.length > 0);
    if (tWords.length < 3 || lines.length === 0) return EMPTY_ALIGN;

    const lineWords = lines.map((l) =>
      (l.text ?? '')
        .split(/\s+/)
        .map(normWord)
        .filter((w) => w.length > 0),
    );

    let best: AlignResult = { ...EMPTY_ALIGN };
    let bestScore = -Infinity;

    for (let start = 0; start < lines.length; start++) {
      if (lineWords[start].length === 0) continue;
      let ti = 0;
      let matched = 0;
      let endLine = -1;
      let firstMatched = -1;
      for (let li = start; li < lines.length && ti < tWords.length; li++) {
        const lw = lineWords[li];
        if (lw.length === 0) continue;
        let lineHit = 0;
        let pos = ti;
        let wi = 0;
        let skipped = 0;
        const maxSkip = Math.max(3, lw.length);
        while (wi < lw.length && pos < tWords.length) {
          if (wordEq(lw[wi], tWords[pos])) {
            lineHit++;
            wi++;
            pos++;
            skipped = 0;
          } else {
            pos++;
            skipped++;
            if (skipped > maxSkip) break;
          }
        }
        const need = Math.max(1, Math.ceil(lw.length * 0.5));
        if (lineHit >= need) {
          if (firstMatched < 0) firstMatched = li;
          matched += lineHit;
          ti = pos;
          endLine = li;
        }
      }
      if (matched < 4 || firstMatched < 0) continue;
      const ratio = matched / tWords.length;

      // Offset anchors:
      //   A = first matched line's timestamp (clip starts ≈ at its vocal)
      //   B = line AFTER the last match minus clip duration (clip ends ≈ there)
      // Chorus repeats create equal-ratio windows — the window whose A/B
      // anchors agree (span ≈ clip duration) is the right occurrence.
      const startT = lines[firstMatched].time;
      let offset = startT;
      let anchorDiff = 15;
      if (endLine >= 0 && endLine + 1 < lines.length) {
        const afterEnd = lines[endLine + 1].time - previewDurSec;
        anchorDiff = Math.abs(afterEnd - startT);
        if (anchorDiff <= 3) offset = (startT + afterEnd) / 2;
        else if (anchorDiff <= 6) offset = startT * 0.6 + afterEnd * 0.4;
      }
      const score = ratio * 1000 - Math.min(anchorDiff, 15);
      if (score <= bestScore) continue;
      bestScore = score;

      best = {
        offsetSec: offset,
        confidence: Math.min(1, ratio),
        matched,
        ratio,
        startLine: firstMatched,
        endLine,
      };
    }

    if (best.matched < 4 || best.ratio < 0.3) return { ...EMPTY_ALIGN, ratio: best.ratio };
    return best;
  } catch {
    return EMPTY_ALIGN;
  }
}

/* ------------------------------------------------------------------ */
/* AI preview sync — audio + ASR plumbing                              */
/* ------------------------------------------------------------------ */

/** Downmix any audio buffer to 16 kHz mono WAV via ffmpeg stdin/stdout. */
function ffmpegWav16kMono(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-ac', '1', '-ar', '16000',
      '-f', 'wav', 'pipe:1',
    ]);
    const chunks: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch { /* already dead */ }
      reject(new Error('ffmpeg timeout'));
    }, 25000);
    p.stdout.on('data', (c: Buffer) => chunks.push(c));
    p.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 200)}`));
    });
    p.stdin.on('error', () => { /* EPIPE when ffmpeg dies early — close handles it */ });
    p.stdin.end(input);
  });
}

/**
 * WAV duration in seconds. When ffmpeg streams WAV through a pipe it
 * cannot seek back to patch the header, so the `data` chunk size arrives
 * as a 0xFFFFFFFF placeholder — in that case the bytes actually present
 * after the chunk header are the truth. Sanity-clamped to [1, 600].
 */
function wavDuration(buf: Buffer): number {
  let dur = 30;
  try {
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return 30;
    const byteRate = buf.readUInt32LE(28);
    if (byteRate <= 0) return 30;
    let pos = 12;
    while (pos + 8 <= buf.length) {
      const id = buf.toString('ascii', pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      if (id === 'data') {
        const present = buf.length - (pos + 8);
        dur = (size > present ? present : size) / byteRate;
        break;
      }
      pos += 8 + size + (size % 2);
    }
  } catch {
    /* fall through */
  }
  if (!Number.isFinite(dur) || dur < 1 || dur > 600) return 30;
  return dur;
}

type ZaiModule = typeof import('z-ai-web-dev-sdk');
let zaiMod: Promise<ZaiModule> | null = null;
function loadZai(): Promise<ZaiModule> {
  if (!zaiMod) zaiMod = import('z-ai-web-dev-sdk');
  return zaiMod;
}

/** Transcribe a WAV buffer with the ASR model (server side only). */
async function transcribe(wav: Buffer): Promise<string> {
  const mod = await loadZai();
  const zai = await mod.default.create();
  const res = await zai.audio.asr.create({ file_base64: wav.toString('base64') });
  return typeof res?.text === 'string' ? res.text : '';
}

export interface PreviewSync {
  offsetSec: number | null;
  confidence: number;
  previewDurSec: number;
}

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

async function computeSync(previewUrl: string, lines: LrcLine[], songDurationSec: number): Promise<PreviewSync> {
  const fail: PreviewSync = { offsetSec: null, confidence: 0, previewDurSec: 30 };
  try {
    const res = await fetch(previewUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
    });
    if (!res.ok) return fail;
    const m4a = Buffer.from(await res.arrayBuffer());
    const wav = await ffmpegWav16kMono(m4a);
    let dur = wavDuration(wav);
    if (!(dur >= 1 && dur <= 600)) dur = 30;
    const transcript = await transcribe(wav);
    const align = alignPreviewOffset(transcript, lines, dur);
    if (align.offsetSec === null) return { ...fail, previewDurSec: dur };
    let offset = align.offsetSec;
    if (songDurationSec > 0 && dur < songDurationSec) {
      const maxOff = songDurationSec - dur;
      offset = Math.min(Math.max(offset, 0), maxOff);
    } else {
      offset = Math.max(offset, 0);
    }
    return { offsetSec: offset, confidence: align.confidence, previewDurSec: dur };
  } catch {
    return fail;
  }
}

/** Cached (SQLite + memory) preview sync. Computed once per preview URL. */
export async function getPreviewSync(previewUrl: string, lines: LrcLine[], songDurationSec: number): Promise<PreviewSync> {
  const key = sha1(previewUrl);

  // 1. memory
  const memHit = memGet<PreviewSync>(`sync:${key}`);
  if (memHit) return memHit;

  // 2. SQLite (permanent)
  try {
    const row = await db.syncCache.findUnique({ where: { id: key } });
    if (row) {
      const hit: PreviewSync = {
        offsetSec: row.offsetSec >= 0 ? row.offsetSec : null,
        confidence: row.confidence,
        previewDurSec: row.previewDurSec > 0 ? row.previewDurSec : 30,
      };
      memSet(`sync:${key}`, hit, 60 * 60 * 1000);
      return hit;
    }
  } catch {
    /* DB hiccup — compute anyway */
  }

  // 3. compute once for concurrent callers
  const result = await dedupe(`sync:${key}`, () => computeSync(previewUrl, lines, songDurationSec));
  if (result.offsetSec !== null) {
    memSet(`sync:${key}`, result, 60 * 60 * 1000);
    try {
      await db.syncCache.upsert({
        where: { id: key },
        create: {
          id: key,
          offsetSec: result.offsetSec,
          confidence: result.confidence,
          previewDurSec: result.previewDurSec,
        },
        update: {
          offsetSec: result.offsetSec,
          confidence: result.confidence,
          previewDurSec: result.previewDurSec,
        },
      });
    } catch {
      /* cache write failure is non-fatal */
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* prepare — lyrics + offset in one shot                               */
/* ------------------------------------------------------------------ */

export async function prepareLyrics(opts: {
  artist: string;
  title: string;
  durationMs?: number;
  previewUrl?: string;
}): Promise<PrepareResult> {
  const none: PrepareResult = {
    found: false, synced: false, lrc: null, plainLyrics: null, offsetSec: null, confidence: 0, match: null,
  };
  const durSec = opts.durationMs && opts.durationMs > 0 ? opts.durationMs / 1000 : 0;

  let hits = await lrclibSearch({ artist: opts.artist, title: opts.title });
  let best = pickBestHit(hits, opts.artist, opts.title, durSec);
  if (!best) {
    hits = await lrclibSearch({ q: `${opts.artist} ${opts.title}` });
    best = pickBestHit(hits, opts.artist, opts.title, durSec);
  }
  if (!best) return none;

  const match: PrepareResult['match'] = {
    title: best.trackName ?? opts.title,
    artist: best.artistName ?? opts.artist,
    album: best.albumName ?? null,
  };

  const asPlain = (): string | null => best?.plainLyrics ?? null;

  if (!best.syncedLyrics) {
    return { ...none, found: true, plainLyrics: asPlain(), match };
  }

  let parsed;
  try {
    parsed = parseLrc(best.syncedLyrics);
  } catch {
    return { ...none, found: true, plainLyrics: asPlain(), match };
  }
  const lines = parsed.lines;
  if (lines.length === 0) {
    return { ...none, found: true, plainLyrics: asPlain(), match };
  }

  const previewUrl = opts.previewUrl && isAllowedPreview(opts.previewUrl) ? opts.previewUrl : undefined;
  if (!previewUrl) {
    return {
      ...none,
      found: true,
      plainLyrics: best.plainLyrics ?? lines.map((l) => l.text).join('\n'),
      match,
    };
  }

  const sync = await getPreviewSync(previewUrl, lines, durSec);
  if (sync.offsetSec === null) {
    return {
      ...none,
      found: true,
      plainLyrics: best.plainLyrics ?? lines.map((l) => l.text).join('\n'),
      match,
    };
  }

  const off = sync.offsetSec;
  const windowEnd = sync.previewDurSec + 0.8;
  const shifted: LrcLine[] = [];
  for (const l of lines) {
    const t = l.time - off;
    if (t > windowEnd) continue; // after the clip cut
    if (t < -6) continue; // fully sung before the clip cut
    shifted.push({
      time: Math.max(0, t),
      end: undefined,
      text: l.text,
      sub: l.sub,
      words: Array.isArray(l.words)
        ? l.words.map((w) => ({ ...w, t: Math.max(0, w.t - off), end: undefined }))
        : undefined,
    });
  }
  if (shifted.length === 0) {
    return { ...none, found: true, plainLyrics: asPlain(), match };
  }

  const tagSafe = (s: string): string => s.replace(/[\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    found: true,
    synced: true,
    lrc: serializeLrc({ title: tagSafe(match.title ?? ''), artist: tagSafe(match.artist ?? ''), lines: shifted }),
    plainLyrics: best.plainLyrics ?? null,
    offsetSec: off,
    confidence: sync.confidence,
    match,
  };
}

/* ------------------------------------------------------------------ */
/* charts (trending)                                                   */
/* ------------------------------------------------------------------ */

interface RssSong {
  artistName?: string;
  id?: string;
  name?: string;
  albumName?: string;
  artworkUrl100?: string;
}

async function fetchRss(geo: 'il' | 'us'): Promise<RssSong[]> {
  const data = await getJson<{ feed?: { results?: RssSong[] } }>(
    `https://rss.applemarketingtools.com/api/v2/${geo}/music/most-played/30/songs.json`,
    10000,
  );
  const results = data?.feed?.results;
  return Array.isArray(results) ? results : [];
}

const CURATED: Array<[string, string]> = [
  ['Queen', 'Bohemian Rhapsody'],
  ['Journey', "Don't Stop Believin'"],
  ['ABBA', 'Dancing Queen'],
  ['Adele', 'Hello'],
  ['Lady Gaga', 'Shallow'],
  ['Ed Sheeran', 'Perfect'],
  ['Whitney Houston', 'I Will Always Love You'],
  ['Coldplay', 'Fix You'],
  ['Toto', 'Africa'],
  ['The Beatles', 'Hey Jude'],
  ['אריק איינשטיין', 'עוף גוזל'],
  ['עידן רייכל', 'ממעמקים'],
  ['שלמה ארצי', 'תתארו לכם'],
  ['משינה', 'אתה מוכרח לנוח'],
];

async function curatedFallback(): Promise<DiscoverSong[]> {
  const out: DiscoverSong[] = [];
  const queue = [...CURATED];
  const worker = async (): Promise<void> => {
    while (queue.length > 0 && out.length < 14) {
      const item = queue.shift();
      if (!item) break;
      const [artist, title] = item;
      const r = await itunesSearch(`${artist} ${title}`, 1, 'IL');
      if (r[0]) out.push(r[0]);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

export async function getCharts(geo: 'il' | 'us' = 'il'): Promise<DiscoverSong[]> {
  const rss = await fetchRss(geo);
  let songs: DiscoverSong[] = [];
  if (rss.length > 0) {
    const ids = rss
      .map((r) => r.id)
      .filter((id): id is string => typeof id === 'string' && /^\d+$/.test(id))
      .slice(0, 30);
    const byId = new Map<string, DiscoverSong>();
    for (const s of await itunesLookup(ids)) byId.set(String(s.trackId), s);
    for (const r of rss) {
      const s = r.id ? byId.get(r.id) : undefined;
      if (s && !songs.some((x) => x.trackId === s.trackId)) songs.push(s);
    }
    songs = songs.slice(0, 24);
  }
  if (songs.length === 0) {
    const cached = memGet<DiscoverSong[]>(`charts-fallback:${geo}`);
    songs = cached ?? (await curatedFallback());
    if (!cached && songs.length > 0) memSet(`charts-fallback:${geo}`, songs, 12 * 60 * 60 * 1000);
  }
  if (songs.length === 0) return [];

  await enrichHasLrc(songs.slice(0, 10), { concurrency: 4, perCallMs: 2500, budgetMs: 4000 });
  return songs;
}

/* ------------------------------------------------------------------ */
/* play counter ("hot in the app")                                     */
/* ------------------------------------------------------------------ */

export async function logPlay(song: DiscoverSong): Promise<boolean> {
  try {
    await db.playEvent.create({
      data: {
        songKey: song.id,
        title: song.title.slice(0, 300),
        artist: song.artist.slice(0, 300),
        artwork: (song.artworkSmall || song.artwork || '').slice(0, 500),
        previewUrl: song.previewUrl.slice(0, 500),
        durationMs: Math.max(0, Math.round(song.durationMs)) || 0,
      },
    });
    return true;
  } catch {
    return false;
  }
}

export async function getHot(limit = 12): Promise<Array<DiscoverSong & { plays: number }>> {
  try {
    const grouped = await db.playEvent.groupBy({
      by: ['songKey'],
      _count: { songKey: true },
      orderBy: { _count: { songKey: 'desc' } },
      take: limit,
    });
    const out: Array<DiscoverSong & { plays: number }> = [];
    for (const g of grouped) {
      const row = await db.playEvent.findFirst({
        where: { songKey: g.songKey },
        orderBy: { createdAt: 'desc' },
      });
      if (!row || !row.previewUrl) continue;
      const trackId = Number(row.songKey.split(':')[1] ?? 0) || 0;
      out.push({
        id: row.songKey,
        trackId,
        title: row.title,
        artist: row.artist,
        album: '',
        artwork: row.artwork,
        artworkSmall: row.artwork,
        previewUrl: row.previewUrl,
        durationMs: row.durationMs,
        genre: null,
        hasLrc: false,
        plays: g._count.songKey,
      });
    }
    return out;
  } catch {
    return [];
  }
}
