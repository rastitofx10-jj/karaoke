/* TITO KARAOKE STUDIO v2.0 — DISCOVER shared types
 * Used by both the server routes and the client panels. Pure types +
 * tiny pure helpers only — safe to import from anywhere.
 */

/**
 * v5.0 — a verified FULL-LENGTH playback source (SoundCloud / Audius).
 * SoundCloud hosts millions of full-length covers, remixes and instrumentals
 * (policy ALLOW, not snipped); Audius hosts a full decentralized catalog.
 * Both stream fine from the server and are proxied same-origin to the
 * browser, then decoded into Web Audio — the whole karaoke DSP chain
 * (vocal removal, key shift, scoring) runs on the FULL song.
 */
export interface FullSource {
  /** 'soundcloud' | 'audius' */
  provider: 'soundcloud' | 'audius';
  /** Provider track id (number as string). */
  id: string;
  /** Track title on the provider (may be "Believer - Metal Cover"). */
  title: string;
  /** Uploader / artist on the provider. */
  artist: string;
  /** FULL duration in ms (>= 60s, guaranteed). */
  durationMs: number;
  /** Higher = better match to the catalog song (title/artist/duration). */
  score: number;
  /** True when this is the exact original recording (not a cover). */
  original?: boolean;
}

/** One searchable/streamable song coming from the iTunes catalog. */
export interface DiscoverSong {
  /** Stable key: `itunes:{trackId}` — also used as the library record id. */
  id: string;
  trackId: number;
  title: string;
  artist: string;
  album: string;
  /** 600x600 artwork URL. */
  artwork: string;
  /** 200x200 artwork URL (lists). */
  artworkSmall: string;
  /** Official 30s preview clip (Apple CDN, m4a). '' for standalone provider rows. */
  previewUrl: string;
  /** FULL song duration in ms (the clip itself is ~30s). */
  durationMs: number;
  genre: string | null;
  /** Enriched: synced lyrics likely exist (LRCLIB). */
  hasLrc: boolean;
  /** Only for "hot in app" results — play count. */
  plays?: number;
  /** v5.0 — verified full-length sources matched to this song. */
  fullSources?: FullSource[];
  /** v5.0 — for standalone provider rows (`sc:{id}`): the artist/title to
   * search on LRCLIB (parsed from the cover title, e.g. "Imagine Dragons" +
   * "Believer"). Undefined for plain iTunes rows. */
  lrcArtist?: string;
  lrcTitle?: string;
}

export type HotSong = DiscoverSong & { plays: number };

/** Response of /api/discover/prepare — lyrics ready to feed setLyricsRaw. */
export interface PrepareResult {
  /** Any LRCLIB record was matched. */
  found: boolean;
  /** Synced (timestamped) lyrics — only when the AI offset succeeded. */
  synced: boolean;
  /** LRC text: full-song mode = original timestamps, preview mode = shifted
   * into the 30s clip timeline. */
  lrc: string | null;
  plainLyrics: string | null;
  /** Preview start offset inside the full song, seconds (null = unknown). */
  offsetSec: number | null;
  /** 0..1 alignment confidence. */
  confidence: number;
  match: { title: string; artist: string; album: string | null } | null;
  /** mode=full only: the matched record's duration, seconds. */
  fullDurationSec?: number | null;
  /** Which lyrics provider served the record — 'lrclib' (default) or 'netease'. */
  provider?: string | null;
}

/** One full-song playback candidate resolved server-side from YouTube. */
export interface YtCandidate {
  videoId: string;
  title: string;
  channel: string;
  durationSec: number;
  /** Higher = better match (duration proximity, title/channel tokens). */
  score: number;
}

/** `3:45` for a full song duration in ms. Never throws. */
export function fmtSongDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
