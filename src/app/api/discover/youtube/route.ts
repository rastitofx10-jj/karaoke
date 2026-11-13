/* TITO KARAOKE STUDIO v3.2 — GET /api/discover/youtube
 * Full-song resolver: scrapes YouTube search server-side (no API key),
 * drops embed-blocked sources via an oEmbed probe and returns the top
 * playback candidates for the IFrame player.
 *   variant=original (default) — the song as released
 *   variant=karaoke            — instrumental / backing-track uploads
 *   fresh=1                    — bypass the cache (user pressed "try again")
 * An empty list means "no playable full song" — the client keeps the 30s
 * preview and says so.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveYtCandidates } from '@/lib/karaoke/yt-server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const title = (req.nextUrl.searchParams.get('title') ?? '').trim().slice(0, 200);
  const artist = (req.nextUrl.searchParams.get('artist') ?? '').trim().slice(0, 200);
  const ms = Number(req.nextUrl.searchParams.get('durationMs'));
  const durationMs = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
  const variant = req.nextUrl.searchParams.get('variant') === 'karaoke' ? 'karaoke' : 'original';
  const fresh = req.nextUrl.searchParams.get('fresh') === '1';
  if (!title || !artist) return NextResponse.json({ candidates: [] });
  const candidates = await resolveYtCandidates({ title, artist, durationMs, variant, fresh });
  return NextResponse.json({ candidates });
}
