/* TITO KARAOKE STUDIO v2.0 — /api/discover/plays
 * POST: log a play event (fire-and-forget from the client).
 * GET : "hot in the app" — most played songs across all users.
 * SQLite-backed; every failure degrades to an empty list, never a 500.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getHot, logPlay, memGet, memSet } from '@/lib/karaoke/discover-server';
import type { DiscoverSong, HotSong } from '@/lib/karaoke/discover-types';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<DiscoverSong>;
    if (!body || typeof body.id !== 'string' || typeof body.title !== 'string' || typeof body.artist !== 'string') {
      return NextResponse.json({ ok: false }, { status: 200 });
    }
    const ok = await logPlay({
      id: body.id,
      trackId: Number(body.trackId) || 0,
      title: body.title,
      artist: body.artist,
      album: typeof body.album === 'string' ? body.album : '',
      artwork: typeof body.artwork === 'string' ? body.artwork : '',
      artworkSmall: typeof body.artworkSmall === 'string' ? body.artworkSmall : '',
      previewUrl: typeof body.previewUrl === 'string' ? body.previewUrl : '',
      durationMs: Number(body.durationMs) || 0,
      genre: null,
      hasLrc: false,
    });
    return NextResponse.json({ ok });
  } catch {
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}

export async function GET() {
  const cached = memGet<{ songs: HotSong[] }>('hot');
  if (cached) return NextResponse.json(cached);
  const songs = await getHot(12);
  const payload = { songs };
  memSet('hot', payload, 60 * 1000);
  return NextResponse.json(payload);
}
