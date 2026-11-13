/* TITO KARAOKE STUDIO v2.0 — GET /api/discover/search
 * Instant song search: iTunes catalog + LRCLIB lyrics availability badge.
 * Cached 10 minutes in memory per (country, query).
 */

import { NextRequest, NextResponse } from 'next/server';
import { dedupe, enrichHasLrc, itunesSearch, memGet, memSet } from '@/lib/karaoke/discover-server';
import type { DiscoverSong } from '@/lib/karaoke/discover-types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  const lang = req.nextUrl.searchParams.get('lang') === 'en' ? 'en' : 'he';
  if (q.length < 2) return NextResponse.json({ songs: [] });
  const country = lang === 'he' ? 'IL' : 'US';

  const key = `search:${country}:${q.toLowerCase()}`;
  const cached = memGet<{ songs: DiscoverSong[] }>(key);
  if (cached) return NextResponse.json(cached);

  const songs = await dedupe(key, async () => {
    const results = await itunesSearch(q, 24, country);
    await enrichHasLrc(results.slice(0, 12), { concurrency: 5, perCallMs: 3000, budgetMs: 5500 });
    return results;
  });

  const payload = { songs };
  memSet(key, payload, 30 * 60 * 1000);
  return NextResponse.json(payload);
}
