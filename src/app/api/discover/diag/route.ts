/* TITO KARAOKE STUDIO v6.0 — GET /api/discover/diag
 * The Network Doctor, server half: live pings of every provider the
 * product depends on, each with latency, each total (never throws).
 * The client half (src/components/karaoke/NetworkDoctor.tsx) adds the
 * one check only a browser can make — the YouTube embed probe.
 *
 *   GET /api/discover/diag  →  200 {
 *     at: number,
 *     ffmpeg: boolean,                  // transcode fallback availability
 *     providers: {
 *       soundcloud: ProviderState,   // FULL-LENGTH tier 1 (v5.0)
 *       audius:     ProviderState,   // FULL-LENGTH tier 1 (v5.0)
 *       lrclib:     ProviderState,   // synced lyrics (stage 1-3)
 *       netease:    ProviderState,   // synced lyrics (stage 4)
 *       itunes:     ProviderState,   // catalog + 30s previews
 *       ytServer:   ProviderState,   // direct-audio tier (innertube)
 *     } }
 *
 * Every check is a real question the product asks in production — not a
 * synthetic ping: provider searches with hard timeouts, all answered
 * 'ok' | 'blocked' | 'slow' | 'down' with the measured latency.
 */

import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { scSearch, audiusSearch } from '@/lib/karaoke/full-server';
import { resolveDirectAudio } from '@/lib/karaoke/yt-audio-server';

export const dynamic = 'force-dynamic';

export interface ProviderState {
  /** ok — answered; blocked — the provider is up but walled for us;
   *  slow — answered over the SLOW_MS bar; down — no answer at all */
  state: 'ok' | 'blocked' | 'slow' | 'down';
  /** measured round-trip in ms (null when no answer) */
  ms: number | null;
}

/** over this, a provider that still answers is 'slow' (honest, not binary) */
const SLOW_MS = 3500;
const TIMEOUT_MS = 7000;

async function timedFetch(url: string, init?: RequestInit): Promise<{ ok: boolean; ms: number }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        ...(init?.headers ?? {}),
      },
    });
    return { ok: res.ok, ms: Date.now() - t0 };
  } catch {
    return { ok: false, ms: Date.now() - t0 };
  }
}

function verdict(answered: boolean, ms: number): ProviderState {
  if (!answered) return { state: 'down', ms: null };
  if (ms > SLOW_MS) return { state: 'slow', ms };
  return { state: 'ok', ms };
}

/** SoundCloud — the tier-1 full-length catalog: a real search (the exact
 *  call loadDiscoverSong makes). A dead client_id reads as 'blocked'
 *  because the host answers but the API refuses — the doctor must not
 *  mistake a key rotation for a network wall. */
async function checkSoundcloud(): Promise<ProviderState> {
  const t0 = Date.now();
  try {
    const tracks = await scSearch('hello adele', 3);
    const ms = Date.now() - t0;
    if (tracks.length > 0) return verdict(true, ms);
    /* answered (no throw) but zero usable tracks — walled or rotated */
    return { state: 'blocked', ms };
  } catch {
    return { state: 'down', ms: Date.now() - t0 };
  }
}

/** Audius — the second tier-1 full-length catalog, same honesty law. */
async function checkAudius(): Promise<ProviderState> {
  const t0 = Date.now();
  try {
    const tracks = await audiusSearch('hello', 3);
    const ms = Date.now() - t0;
    if (tracks.length > 0) return verdict(true, ms);
    return { state: 'blocked', ms };
  } catch {
    return { state: 'down', ms: Date.now() - t0 };
  }
}

/** LRCLIB — a real search (the exact call the lyric cascade makes) */
async function checkLrclib(): Promise<ProviderState> {
  const r = await timedFetch('https://lrclib.net/api/search?track_name=hello&artist_name=adele');
  return verdict(r.ok, r.ms);
}

/** NetEase — a real search via the same public endpoint stage 4 uses */
async function checkNetease(): Promise<ProviderState> {
  const r = await timedFetch(
    'https://music.163.com/api/search/get?s=hello&type=1&offset=0&limit=1',
    { headers: { Referer: 'https://music.163.com' } },
  );
  return verdict(r.ok, r.ms);
}

/** iTunes — the catalog search every discover query starts from */
async function checkItunes(): Promise<ProviderState> {
  const r = await timedFetch('https://itunes.apple.com/search?term=hello&limit=1');
  return verdict(r.ok, r.ms);
}

/** The direct-audio tier — a real innertube probe of a known-good video.
 *  This is the check that explains "the full song did not load" when the
 *  datacenter IP is walled: innertube answers, but with a bot-check. */
async function checkYtServer(): Promise<ProviderState> {
  const t0 = Date.now();
  try {
    const src = await resolveDirectAudio('aqz-KE-bpKQ'); // Big Buck Bunny — embeddable, stable, Creative Commons
    const ms = Date.now() - t0;
    if (src) return verdict(true, ms);
    /* answered, but no stream = walled (bot-check / login wall) */
    return { state: 'blocked', ms };
  } catch {
    return { state: 'down', ms: null };
  }
}

/* ffmpeg availability — cached for the process lifetime (it cannot change
 * without a restart). It powers the transcode fallback when a browser
 * rejects SoundCloud's fMP4 concat; a missing ffmpeg is a degradation the
 * doctor should speak about, not hide. */
let ffmpegCache: boolean | null = null;
function ffmpegAvailable(): Promise<boolean> {
  if (ffmpegCache !== null) return Promise.resolve(ffmpegCache);
  return new Promise((resolve) => {
    try {
      execFile('ffmpeg', ['-version'], { timeout: 4000 }, (err) => {
        ffmpegCache = !err;
        resolve(ffmpegCache);
      });
    } catch {
      ffmpegCache = false;
      resolve(false);
    }
  });
}

export async function GET() {
  const [soundcloud, audius, lrclib, netease, itunes, ytServer, ffmpeg] = await Promise.all([
    checkSoundcloud(),
    checkAudius(),
    checkLrclib(),
    checkNetease(),
    checkItunes(),
    checkYtServer(),
    ffmpegAvailable(),
  ]);
  return NextResponse.json({
    at: Date.now(),
    ffmpeg,
    providers: { soundcloud, audius, lrclib, netease, itunes, ytServer },
  });
}
