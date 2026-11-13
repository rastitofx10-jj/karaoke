/* TITO KARAOKE STUDIO v3.0 — GET /api/discover/prepare
 * Lyrics for a song, ready to sing, on one of two timelines:
 *
 *   mode=full (default in v3.0) — the full-song LRC, original timestamps.
 *     The YouTube full-song player and the LRC share one timeline, so the
 *     sync is exact without any AI alignment.
 *
 *   mode=preview — the 30s clip timeline. AI preview sync runs: the iTunes
 *     clip is transcribed (ASR) and the full-song LRC is shifted + clipped
 *     into the clip's window.
 *
 * Response PrepareResult — `lrc` feeds setLyricsRaw as-is.
 */

import { NextRequest, NextResponse } from 'next/server';
import { dedupe, isAllowedPreview, memGet, memSet, prepareLyrics } from '@/lib/karaoke/discover-server';
import type { PrepareResult } from '@/lib/karaoke/discover-types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const artist = (p.get('artist') ?? '').slice(0, 200);
  const title = (p.get('title') ?? '').slice(0, 200);
  const album = (p.get('album') ?? '').slice(0, 200);
  const preview = (p.get('preview') ?? '').slice(0, 600);
  const trackId = p.get('trackId') ?? '';
  const durationMs = Number(p.get('durationMs') ?? '0') || 0;
  const fullMode = p.get('mode') !== 'preview'; // default: full

  const none: PrepareResult = {
    found: false, synced: false, lrc: null, plainLyrics: null, offsetSec: null, confidence: 0, match: null,
  };
  if (!artist || !title) return NextResponse.json(none);

  const key = `prepare:${fullMode ? 'full' : 'prev'}:${trackId}:${title}:${artist}`;
  const cached = memGet<PrepareResult>(key);
  if (cached) return NextResponse.json(cached);

  const result = await dedupe(key, () =>
    prepareLyrics({
      artist,
      title,
      album,
      durationMs,
      previewUrl: fullMode ? undefined : (isAllowedPreview(preview) ? preview : undefined),
      fullMode,
    }),
  );

  /* NEGATIVE RESULTS NEVER STICK: a transient LRCLIB hiccup must not poison
   * a song for 10 minutes (the v2.0 bug that left the stage empty). */
  memSet(key, result, result.found ? 10 * 60 * 1000 : 45 * 1000);
  return NextResponse.json(result);
}
