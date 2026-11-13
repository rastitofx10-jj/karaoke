/* TITO KARAOKE STUDIO v3.4 — GET /api/discover/stream
 * Direct-audio tier: resolve a YouTube video's audio server-side
 * (visionos innertube) and PROXY the bytes — googlevideo URLs are
 * IP-locked to this server, so the browser must fetch through us.
 * The client decodes the result into Web Audio, which unlocks the full
 * karaoke DSP chain (vocal removal, key shift, speed) on full songs.
 *
 *   id=VIDEOID            → resolve + proxy (Range passthrough)
 *   id=VIDEOID&probe=1    → resolve only: 200 {ok,title,author,bytes,mime}
 *                           or 200 {ok:false} — cheap pre-flight check
 *
 * Failures are 200 {ok:false} for the probe and 502/404 for the stream —
 * the client tier treats any non-audio answer as "next candidate".
 */

import { NextRequest, NextResponse } from 'next/server';
import { proxyDirectAudio, resolveDirectAudio } from '@/lib/karaoke/yt-audio-server';

export const dynamic = 'force-dynamic';

/** hard ceiling: a 20-minute 160kbps track ≈ 24MB — beyond this is a
 *  mistake (video format picked, livestream, etc.), refused */
const MAX_BYTES = 32 * 1024 * 1024;

export async function GET(req: NextRequest) {
  const id = (req.nextUrl.searchParams.get('id') ?? '').trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) {
    return NextResponse.json({ ok: false, error: 'bad id' }, { status: 404 });
  }
  const probe = req.nextUrl.searchParams.get('probe') === '1';

  const source = await resolveDirectAudio(id);
  if (!source) {
    if (probe) return NextResponse.json({ ok: false });
    return NextResponse.json({ ok: false, error: 'no stream' }, { status: 502 });
  }

  if (probe) {
    return NextResponse.json({
      ok: true,
      title: source.title,
      author: source.author,
      bytes: source.contentLength,
      mime: source.mimeType,
    });
  }

  if (source.contentLength > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: 'too large' }, { status: 502 });
  }

  const range = req.headers.get('range');
  const upstream = await proxyDirectAudio(source, range);
  if (!upstream || !upstream.body) {
    return NextResponse.json({ ok: false, error: 'upstream gone' }, { status: 502 });
  }

  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('content-type') ?? source.mimeType);
  headers.set('Accept-Ranges', 'bytes');
  const len = upstream.headers.get('content-length');
  if (len) headers.set('Content-Length', len);
  const cr = upstream.headers.get('content-range');
  if (cr) headers.set('Content-Range', cr);
  headers.set('Cache-Control', 'no-store');
  /* one 200/206 passthrough — the browser owns buffering + seeking */
  return new Response(upstream.body, { status: upstream.status, headers });
}
