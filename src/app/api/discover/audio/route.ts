/* TITO KARAOKE STUDIO v2.0 — GET /api/discover/audio
 * Same-origin proxy for official iTunes 30s preview clips, so the browser
 * can fetch + decodeAudioData them without CORS. Apple hosts only
 * (SSRF-guarded), streamed through with long-lived cache headers.
 */

import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

const UA = 'TitoKaraokeStudio/2.0 (browser karaoke; +https://localhost)';

export async function GET(req: NextRequest) {
  const preview = (req.nextUrl.searchParams.get('preview') ?? '').slice(0, 600);

  let target: URL;
  try {
    target = new URL(preview);
  } catch {
    return new Response('bad url', { status: 400 });
  }
  if (target.protocol !== 'https:') return new Response('bad protocol', { status: 400 });
  const h = target.hostname.toLowerCase();
  if (!h.endsWith('.apple.com') && !h.endsWith('.mzstatic.com') && !h.endsWith('.akamai.net')) {
    return new Response('host not allowed', { status: 403 });
  }

  try {
    const res = await fetch(target.toString(), {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(20000),
      cache: 'no-store',
    });
    if (!res.ok || !res.body) {
      return new Response('upstream unavailable', { status: 502 });
    }
    const headers = new Headers();
    headers.set('content-type', res.headers.get('content-type') ?? 'audio/mp4');
    const len = res.headers.get('content-length');
    if (len) headers.set('content-length', len);
    headers.set('cache-control', 'public, max-age=86400');
    return new Response(res.body, { status: 200, headers });
  } catch {
    return new Response('fetch failed', { status: 502 });
  }
}
