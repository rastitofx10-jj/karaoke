/* TITO KARAOKE STUDIO v5.0 — GET /api/discover/fullsong
 * Fresh full-length source resolution for ONE catalog song — used at load
 * time when search-time sources are missing/stale, and by "try the full
 * song again". Server-side SC+Audius search scoped to the song, matched by
 * title/artist/duration. Cached: positive 15min, negative 2min.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveFullSources } from '@/lib/karaoke/full-server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const artist = (p.get('artist') ?? '').slice(0, 200);
  const title = (p.get('title') ?? '').slice(0, 200);
  const durationMs = Math.max(0, Math.round(Number(p.get('durationMs') ?? '0') || 0));
  if (!artist || !title) {
    return NextResponse.json({ sources: [] });
  }
  const sources = await resolveFullSources({ title, artist, durationMs });
  return NextResponse.json({ sources });
}
