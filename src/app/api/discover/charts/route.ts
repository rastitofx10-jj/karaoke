/* TITO KARAOKE STUDIO v2.0 — GET /api/discover/charts
 * Trending songs: Apple RSS most-played (IL or US store), enriched with
 * iTunes preview clips + LRCLIB lyrics badges. Curated karaoke classics
 * as fallback. Cached 6 hours in memory.
 */

import { NextRequest, NextResponse } from 'next/server';
import { dedupe, getCharts, memGet, memSet } from '@/lib/karaoke/discover-server';
import type { DiscoverSong } from '@/lib/karaoke/discover-types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const lang = req.nextUrl.searchParams.get('lang') === 'en' ? 'en' : 'he';
  const geo = lang === 'he' ? 'il' : 'us';
  const key = `charts:${geo}`;

  const cached = memGet<{ songs: DiscoverSong[] }>(key);
  if (cached) return NextResponse.json(cached);

  const songs = await dedupe(key, () => getCharts(geo));
  const payload = { songs };
  memSet(key, payload, 6 * 60 * 60 * 1000);
  return NextResponse.json(payload);
}
