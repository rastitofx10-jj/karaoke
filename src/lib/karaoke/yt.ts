/* TITO KARAOKE STUDIO v3.0 — YouTube IFrame bridge (browser only)
 * Full-song playback: the YT player owns the clock, the store follows.
 * The engine's mic chain (pitch ribbon, scoring, recording) keeps running —
 * only the music track comes from the iframe instead of Web Audio.
 */

export interface YtPlayer {
  getCurrentTime(): number;
  getDuration(): number;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setVolume(volume: number): void;
  /** v3.3 — muted-autoplay support: probes and the live session both start
   *  muted (autoplay policy) and unmute on the user's tap. */
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  destroy(): void;
  getPlayerState(): number;
}

interface YtNamespace {
  Player: new (el: HTMLElement, opts: Record<string, unknown>) => YtPlayer;
  PlayerState: {
    UNSTARTED: number;
    ENDED: number;
    PLAYING: number;
    PAUSED: number;
    BUFFERING: number;
    CUED: number;
  };
}

/** The live player of the current full-song session (null when inactive). */
export const ytActivePlayer: { current: YtPlayer | null } = { current: null };

/** Consecutive stall-cascade failures (player claims PLAYING but the clock
 * never moves — the bot-wall / dead-embed fingerprint). Three in a row means
 * the ENVIRONMENT blocks embeds, not one bad video: stop cascading and fall
 * back to the preview instead of burning ~30s on the remaining sources.
 * Real onError events (embed-disabled etc.) reset it — those are per-video. */
export const ytStallFails: { count: number } = { count: 0 };

let ytPromise: Promise<YtNamespace> | null = null;

function loadYtApi(): Promise<YtNamespace> {
  if (typeof window === 'undefined') return Promise.reject(new Error('SSR'));
  const w = window as unknown as { YT?: YtNamespace; onYouTubeIframeAPIReady?: () => void };
  if (w.YT?.Player) return Promise.resolve(w.YT);
  if (!ytPromise) {
    ytPromise = new Promise<YtNamespace>((resolve, reject) => {
      const prev = w.onYouTubeIframeAPIReady;
      w.onYouTubeIframeAPIReady = () => {
        prev?.();
        if (w.YT?.Player) resolve(w.YT);
        else reject(new Error('YT namespace missing'));
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      s.onerror = () => reject(new Error('script load failed'));
      document.head.appendChild(s);
      setTimeout(() => {
        if (!w.YT?.Player) reject(new Error('YT timeout'));
      }, 10000);
    });
  }
  return ytPromise;
}

/** Loads the API and creates a player in `el`. Rejects on pre-ready failure;
 * `onError` keeps firing after ready (embed-block errors arrive late).
 * `muted` starts the player pre-muted (autoplay-policy-safe). */
export async function createYtPlayer(
  el: HTMLElement,
  videoId: string,
  onState: (ev: { data: number }) => void,
  onError?: (code: number) => void,
  opts?: { muted?: boolean },
): Promise<YtPlayer> {
  const YT = await loadYtApi();
  return new Promise<YtPlayer>((resolve, reject) => {
    let settled = false;
    const player = new YT.Player(el, {
      videoId,
      playerVars: { playsinline: 1, rel: 0, modestbranding: 1, ...(opts?.muted ? { mute: 1 } : {}) },
      events: {
        onReady: () => {
          if (opts?.muted) {
            try {
              player.mute();
            } catch {
              /* non-fatal — the mute=1 playerVar already covers it */
            }
          }
          settled = true;
          resolve(player);
        },
        onStateChange: onState,
        onError: (ev: { data: number }) => {
          onError?.(ev.data);
          if (!settled) reject(new Error('player error'));
        },
      },
    });
  });
}

/** Accepts full URLs (watch/shorts/youtu.be/embed) or a bare 11-char ID. */
export function parseYtId(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  const m = t.match(/(?:youtu\.be\/|v=|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(t)) return t;
  return null;
}
