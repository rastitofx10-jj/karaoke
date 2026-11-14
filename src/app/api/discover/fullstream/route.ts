/* TITO KARAOKE STUDIO v5.0 — GET /api/discover/fullstream
 * THE FULL SONG, BYTES IN HAND: provider id in, complete audio out.
 *
 *   p=soundcloud|sc|audius|au & id=TRACKID      → full audio bytes
 *   … & probe=1                                  → 200 {ok,bytes,mime}
 *   … & transcode=1                              → mp3 fallback (ffmpeg)
 *     used when the browser rejects the fMP4 concat on first decode
 *
 * The server does ALL the external talking (client_id, signed playlists,
 * segment fetch) — the browser only ever talks to this same-origin route,
 * so blocked networks can't stand between the user and the full song.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getFullAudio, isFullProvider, normalizeProvider, transcodeToMp3 } from '@/lib/karaoke/full-server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const providerRaw = (p.get('p') ?? p.get('provider') ?? '').trim();
  const id = (p.get('id') ?? '').trim();
  const probe = p.get('probe') === '1';
  const transcode = p.get('transcode') === '1';

  if (!isFullProvider(providerRaw) || id.length === 0 || id.length > 64) {
    return NextResponse.json({ ok: false, error: 'bad params' }, { status: 400 });
  }
  const provider = normalizeProvider(providerRaw);
  if (provider === 'soundcloud' && !/^\d{1,32}$/.test(id)) {
    return NextResponse.json({ ok: false, error: 'bad id' }, { status: 400 });
  }
  if (provider === 'audius' && !/^[a-zA-Z0-9]{1,64}$/.test(id)) {
    return NextResponse.json({ ok: false, error: 'bad id' }, { status: 400 });
  }

  const audio = await getFullAudio(provider, id);
  if (!audio) {
    return probe
      ? NextResponse.json({ ok: false })
      : NextResponse.json({ ok: false, error: 'no audio' }, { status: 502 });
  }

  if (probe) {
    return NextResponse.json({ ok: true, bytes: audio.bytes.byteLength, mime: audio.mime });
  }

  if (transcode) {
    const mp3 = await transcodeToMp3(audio.bytes);
    if (!mp3) {
      return NextResponse.json({ ok: false, error: 'transcode failed' }, { status: 502 });
    }
    return new Response(new Uint8Array(mp3), {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(mp3.byteLength),
        'Cache-Control': 'private, max-age=3600',
      },
    });
  }

  return new Response(new Uint8Array(audio.bytes), {
    status: 200,
    headers: {
      'Content-Type': audio.mime,
      'Content-Length': String(audio.bytes.byteLength),
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
