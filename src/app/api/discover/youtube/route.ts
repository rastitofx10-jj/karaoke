/* TITO KARAOKE STUDIO v2.0 — GET /api/discover/youtube
 * Full-song resolver: scrapes YouTube search server-side (no API key)
 * and returns the top 5 playback candidates for the IFrame player.
 * An empty list means "no full song" — the client keeps the 30s preview.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveYtCandidates } from '@/lib/karaoke/yt-server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const title = (req.nextUrl.searchParams.get('title') ?? '').trim().slice(0, 200);
  const artist = (req.nextUrl.searchParams.get('artist') ?? '').trim().slice(0, 200);
  const ms = Number(req.nextUrl.searchParams.get('durationMs'));
  const durationMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
  if (!title || !artist) return NextResponse.json({ candidates: [] });
  const candidates = await resolveYtCandidates({ title, artist, durationMs });
  return NextResponse.json({ candidates });
}
