/* TITO KARAOKE STUDIO v2.0 — GET /api/discover/prepare
 * Lyrics for a search result, ready to sing:
 *   - LRCLIB lookup (best match by artist/title/duration)
 *   - AI preview sync: ASR transcript of the 30s clip is aligned against
 *     the full-song LRC, timestamps are shifted into the clip's timeline
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
  const preview = (p.get('preview') ?? '').slice(0, 600);
  const trackId = (p.get('trackId') ?? '').slice(0, 40);
  const durationMs = Number(p.get('durationMs') ?? '0') || 0;

  const none: PrepareResult = {
    found: false, synced: false, lrc: null, plainLyrics: null, offsetSec: null, confidence: 0, match: null,
  };
  if (!artist || !title) return NextResponse.json(none);

  const key = `prepare:${trackId}:${title}:${artist}`;
  const cached = memGet<PrepareResult>(key);
  if (cached) return NextResponse.json(cached);

  const result = await dedupe(key, () =>
    prepareLyrics({
      artist,
      title,
      durationMs,
      previewUrl: isAllowedPreview(preview) ? preview : undefined,
    }),
  );

  memSet(key, result, 10 * 60 * 1000);
  return NextResponse.json(result);
}
