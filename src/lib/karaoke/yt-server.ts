/* TITO KARAOKE STUDIO v2.0 — YOUTUBE FULL-SONG RESOLVER (server only)
 *
 * No YouTube API key exists, so full-song candidates are resolved by
 * scraping the public search results page: fetch it with a desktop-Chrome
 * UA, slice `ytInitialData` out of the HTML with a string-literal-aware
 * balanced-brace scanner (never a whole-JSON regex), deep-walk the parsed
 * JSON for video-renderer shapes, then filter + score (duration proximity,
 * title/artist tokens, view count). The best candidate feeds the IFrame
 * player so karaoke sessions run on full songs, not 30s iTunes previews.
 *
 * Every exported function is total: any network/parse failure degrades to
 * []. Results (including empty ones) are cached 6h in memory and
 * de-duplicated in flight via discover-server helpers.
 */

import { dedupe, memGet, memSet } from '@/lib/karaoke/discover-server';
import type { YtCandidate } from '@/lib/karaoke/discover-types';

export interface YtResolveInput {
  title: string;
  artist: string;
  durationMs?: number;
}

/* ------------------------------------------------------------------ */
/* results page fetch                                                  */
/* ------------------------------------------------------------------ */

const YT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SP_VIDEOS_ONLY = '&sp=EgIQAQ%3D%3D'; // search filter: type = video

async function fetchSearchHtml(query: string, videosOnly: boolean): Promise<string | null> {
  try {
    const url =
      'https://www.youtube.com/results?search_query=' +
      encodeURIComponent(query) +
      (videosOnly ? SP_VIDEOS_ONLY : '');
    const res = await fetch(url, {
      headers: { 'User-Agent': YT_UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(9000),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* ytInitialData extraction                                            */
/* ------------------------------------------------------------------ */

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Balanced-brace scanner, aware of string literals + escapes. */
function extractYtInitialData(html: string): unknown {
  const marker = 'var ytInitialData = ';
  let start = html.indexOf(marker);
  if (start < 0) start = html.indexOf('window["ytInitialData"] = ');
  if (start < 0) return null;
  let i = html.indexOf('{', start);
  if (i < 0) return null;
  const from = i;
  let depth = 0;
  let quote: string | null = null; // active string literal delimiter
  for (; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === '\\') i++; // escaped char — skip the next byte
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      return safeParseJson(html.slice(from, i + 1));
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* deep walk → raw video renderers                                     */
/* ------------------------------------------------------------------ */

interface RawVideo {
  videoId: string;
  title: string;
  channel: string;
  durationSec: number;
  views: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Text node: `{ simpleText }` or `{ runs: [{ text }, ...] }` (runs joined). */
function readText(node: unknown): string {
  if (!isObj(node)) return '';
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (Array.isArray(node.runs)) {
    return node.runs
      .map((r) => (isObj(r) && typeof r.text === 'string' ? r.text : ''))
      .join('');
  }
  return '';
}

/** `4:32` / `1:02:15` → seconds. Localized separators (`:` or `,`) don't
 * matter — only the digit groups do. 0 = unusable. */
function parseDurationSec(text: string): number {
  const parts = text.match(/\d+/g);
  if (!parts || (parts.length !== 2 && parts.length !== 3)) return 0;
  const n = parts.map(Number);
  return parts.length === 2 ? n[0] * 60 + n[1] : n[0] * 3600 + n[1] * 60 + n[2];
}

/** `123,456,789 views` (any locale) → first integer, thousands-sep tolerant. */
function parseViews(text: string): number {
  const m = text.match(/\d[\d.,\s]*/);
  if (!m) return 0;
  const v = Number(m[0].replace(/\D+/g, ''));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Collect every object shaped like a video renderer (videoId + title +
 * lengthText), deduped by videoId, regardless of its renderer key name. */
function collectVideos(node: unknown, out: Map<string, RawVideo>): void {
  if (Array.isArray(node)) {
    for (const child of node) collectVideos(child, out);
    return;
  }
  if (!isObj(node)) return;
  const videoId = node.videoId;
  if (
    typeof videoId === 'string' &&
    videoId.length === 11 &&
    !out.has(videoId) &&
    isObj(node.title) &&
    isObj(node.lengthText)
  ) {
    const title = readText(node.title);
    const durationSec = parseDurationSec(readText(node.lengthText));
    if (title && durationSec > 0) {
      const owner = readText(node.ownerText) || readText(node.longBylineText);
      const views = readText(node.viewCountText);
      out.set(videoId, { videoId, title, channel: owner, durationSec, views: parseViews(views) });
    }
  }
  for (const child of Object.values(node)) collectVideos(child, out);
}

/* ------------------------------------------------------------------ */
/* filtering + scoring                                                 */
/* ------------------------------------------------------------------ */

const TITLE_EXCLUDE = [
  'live', 'reaction', 'nightcore', 'sped up', 'slowed', '8d', '1 hour',
  'compilation', 'nonstop', 'megamix', 'mix 20',
];
const TITLE_DEPRIORITIZE = ['karaoke', 'cover', 'instrumental', 'acoustic', 'piano'];
const TITLE_BONUS = ['official audio', 'lyric', 'lyrics', 'video oficial', 'hd', 'remaster'];
const FILLER_TOKENS = new Set(['official', 'video', 'audio', 'lyrics', 'hd', '4k', 'remaster']);

/** lowercase, punctuation + brackets stripped, filler words dropped. */
function normTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !FILLER_TOKENS.has(t));
}

function scoreCandidates(raw: RawVideo[], title: string, artist: string, expectedSec: number): YtCandidate[] {
  const titleToks = normTokens(title);
  const artistToks = normTokens(artist);
  // main (longest = most distinctive) artist token
  const mainArtist = artistToks.reduce((a, b) => (b.length > a.length ? b : a), '');

  const out: YtCandidate[] = [];
  for (const v of raw) {
    const tl = v.title.toLowerCase();
    if (v.durationSec < 45 || v.durationSec > 4000) continue;
    if (TITLE_EXCLUDE.some((w) => tl.includes(w))) continue;
    if (expectedSec > 0 && v.durationSec > expectedSec * 1.35 + 45) continue;

    const candToks = new Set(normTokens(v.title));
    const channelToks = new Set(normTokens(v.channel));

    // start at 30 (perfect duration match), degrade with distance
    let score =
      expectedSec > 0
        ? 30 - Math.min(30, Math.abs(v.durationSec - expectedSec) * 1.2)
        : 15;
    if (titleToks.length > 0 && titleToks.every((t) => candToks.has(t))) score += 10;
    if (mainArtist && (candToks.has(mainArtist) || channelToks.has(mainArtist))) score += 5;
    if (TITLE_BONUS.some((w) => tl.includes(w))) score += 3;
    if (TITLE_DEPRIORITIZE.some((w) => tl.includes(w))) score -= 6;
    if (v.views > 0) score += Math.log10(v.views + 10) / 2;

    out.push({
      videoId: v.videoId,
      title: v.title,
      channel: v.channel,
      durationSec: v.durationSec,
      score: Math.max(0, Math.round(score * 10) / 10),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 5);
}

/* ------------------------------------------------------------------ */
/* resolution pipeline (3 attempts, cached + deduped)                  */
/* ------------------------------------------------------------------ */

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

async function attemptSearch(query: string, videosOnly: boolean): Promise<RawVideo[] | null> {
  const html = await fetchSearchHtml(query, videosOnly);
  if (html === null) return null; // hard failure: network / http status
  const data = extractYtInitialData(html);
  if (data === null) return null; // hard failure: markup changed / bad JSON
  const videos = new Map<string, RawVideo>();
  collectVideos(data, videos);
  return [...videos.values()];
}

async function searchCandidates(title: string, artist: string, expectedSec: number): Promise<YtCandidate[]> {
  const q = `${artist} ${title}`.trim();
  // 1. videos-only filter → 2. unfiltered → 3. "audio" suffix (audio rips)
  const attempts: Array<[string, boolean]> = [
    [q, true],
    [q, false],
    [`${q} audio`, false],
  ];
  let hardFails = 0;
  for (const [query, videosOnly] of attempts) {
    const raw = await attemptSearch(query, videosOnly);
    if (raw === null) {
      hardFails++;
      continue;
    }
    const scored = scoreCandidates(raw, title, artist, expectedSec);
    if (scored.length > 0) return scored;
  }
  if (hardFails > 0) {
    console.warn(`[yt-server] no usable YouTube candidates for "${q}" (${hardFails}/${attempts.length} attempts failed)`);
  }
  return [];
}

/** Resolve full-song YouTube playback candidates for a song. Total: any
 * failure (network, parse, bad input) degrades to []. */
export async function resolveYtCandidates(input: YtResolveInput): Promise<YtCandidate[]> {
  try {
    const title = input.title.trim();
    const artist = input.artist.trim();
    if (!title || !artist) return [];
    const ms =
      typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) && input.durationMs > 0
        ? Math.floor(input.durationMs)
        : 0;

    const key = `yt:res:${artist.toLowerCase()}|${title.toLowerCase()}|${ms}`;
    const cached = memGet<YtCandidate[]>(key);
    if (cached) return cached;

    return await dedupe(key, async () => {
      const candidates = await searchCandidates(title, artist, ms / 1000);
      memSet(key, candidates, CACHE_TTL_MS); // empty lists get cached too
      return candidates;
    });
  } catch {
    return [];
  }
}
