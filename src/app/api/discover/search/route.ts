/* TITO KARAOKE STUDIO v5.0 — GET /api/discover/search
 * Instant song search, now with FULL-LENGTH DNA:
 *   1. iTunes catalog (metadata, artwork, official durations) — in parallel
 *      with SoundCloud + Audius full-track searches for the SAME query;
 *   2. provider tracks are matched to catalog rows (title/artist/duration)
 *      and attached as `fullSources` — click plays the REAL FULL SONG;
 *   3. strong unmatched full tracks become standalone rows (guaranteed full);
 *   4. LRCLIB lyrics badges for the catalog half.
 * Cached 30 minutes in memory per (country, query).
 */

import { NextRequest, NextResponse } from 'next/server';
import { dedupe, enrichHasLrc, itunesSearch, memGet, memSet } from '@/lib/karaoke/discover-server';
import { attachFullSources, audiusSearch, scSearch, standaloneRows } from '@/lib/karaoke/full-server';
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
    /* catalog + both full-length providers, all at once */
    const [results, sc, au] = await Promise.all([
      itunesSearch(q, 24, country),
      scSearch(q, 18).catch(() => []),
      audiusSearch(q, 8).catch(() => []),
    ]);
    /* attach matched full sources to catalog rows… */
    attachFullSources(results, sc, au);
    /* …and keep the best unmatched full tracks as standalone rows */
    const standalone = standaloneRows(sc, results, 5);
    await enrichHasLrc(results.slice(0, 12), { concurrency: 5, perCallMs: 3000, budgetMs: 5500 });
    return [...results, ...standalone];
  });

  const payload = { songs };
  memSet(key, payload, 30 * 60 * 1000);
  return NextResponse.json(payload);
}
