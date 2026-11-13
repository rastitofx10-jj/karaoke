'use client';

/* TITO KARAOKE STUDIO v3.2 — the full-song YouTube stage.
 * v3.0 made full songs possible; v3.1 made them the DEFAULT; v3.2 makes
 * them BULLETPROOF:
 *   • the server pre-filters embed-blocked sources (oEmbed probe), so the
 *     cascade only meets playable videos;
 *   • autoplay-blocked browsers get a big "tap to start" overlay instead
 *     of a silent black rectangle (the play() call needs a user gesture
 *     the async song load may have consumed);
 *   • the stall watchdog still cascades bot-walled / frozen sources;
 *   • variant toggle: original song ⇄ karaoke (instrumental) backing
 *     track — a true karaoke machine when the upload exists;
 *   • a preview fallback is now honest about itself: a clear notice plus
 *     a "try the full song again" door, not just a 29s surprise.
 */

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Link2, Loader2, Mic2, Music2, RotateCcw, Timer, Youtube } from 'lucide-react';
import { toast } from 'sonner';
import { useKaraoke } from '@/store/karaoke';
import { useKaraokeEngine, getEngine } from '@/hooks/use-engine';
import { DICTS } from '@/lib/karaoke/i18n';
import { createYtPlayer, parseYtId, ytActivePlayer, ytStallFails } from '@/lib/karaoke/yt';
import type { YtPlayer } from '@/lib/karaoke/yt';
import { cn } from '@/lib/utils';

function fmtSec(s: number): string {
  const v = Math.max(0, Math.round(s));
  const m = Math.floor(v / 60);
  const r = v % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* one mounted player per videoId — keying the component resets the    */
/* local state through the initializers, so the effect never calls     */
/* setState synchronously (lint-clean and render-cascade-free)         */
/* ------------------------------------------------------------------ */

function YtSession({ videoId }: { videoId: string }) {
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const actions = useKaraokeEngine();
  const [busy, setBusy] = useState(true);
  /** autoplay was blocked — a real click is required to start the sound */
  const [needsTap, setNeedsTap] = useState(false);
  const holderRef = useRef<HTMLDivElement>(null);
  const endsRef = useRef(0);
  const stallRef = useRef(0);
  const lastPosRef = useRef(-1);
  const tapRef = useRef(false);
  /** the user already tapped once — if that failed too, get out of the way
   * and let them press YouTube's own play button inside the iframe */
  const tappedRef = useRef(false);

  useEffect(() => {
    if (!holderRef.current) return;
    let dead = false;
    let poll = 0;
    let started = false;
    let readyAt = 0;
    endsRef.current = 0;
    stallRef.current = 0;
    lastPosRef.current = -1;
    tapRef.current = false;
    tappedRef.current = false;

    const setTap = (v: boolean): void => {
      if (tapRef.current === v) return;
      tapRef.current = v;
      setNeedsTap(v);
    };

    /* YT replaces the element it mounts on with an iframe — hand it a fresh
     * child div every session and clear the wrapper on teardown. */
    const holder = holderRef.current;
    holder.innerHTML = '';
    const el = document.createElement('div');
    holder.appendChild(el);

    /* one failure voice for the whole session: embed errors and dead
     * sources both cascade; every candidate exhausted → preview fallback.
     * A stalled clock (bot wall / dead stream) counts against the
     * ENVIRONMENT — three in a row skips the remaining sources. Real
     * onError events are per-video and reset that counter. */
    const onFail = (stalled = false): void => {
      if (dead) return;
      if (stalled) ytStallFails.count += 1;
      const st = useKaraoke.getState();
      if (st.ytSource === 'auto') {
        if (!actions.ytTryNext()) void actions.ytFailed();
      } else {
        toast.error(t.ytFail);
        actions.setYt(null, { resumePreview: true });
      }
    };

    void createYtPlayer(
      el,
      videoId,
      (ev) => {
        /* state events keep the store honest; polling covers the clock */
        const st = useKaraoke.getState();
        if (ev.data === 1) {
          st.patch({ playing: true });
          started = true;
          setTap(false);
        } else if (ev.data === 2) st.patch({ playing: false });
        else if (ev.data === 0) {
          st.patch({ playing: false });
          if (useKaraoke.getState().recording) void actions.stopRecording();
        }
      },
      () => {
        ytStallFails.count = 0; // a real per-video error, not an environment stall
        onFail(false);
      },
    )
      .then((player: YtPlayer) => {
        if (dead) {
          player.destroy();
          return;
        }
        ytActivePlayer.current = player;
        try {
          player.setVolume(100);
        } catch {
          /* some embeds hide setVolume — non-fatal */
        }
        setBusy(false);
        readyAt = Date.now();
        void player.playVideo();
        poll = window.setInterval(() => {
          const p = ytActivePlayer.current;
          if (!p) return;
          const st = useKaraoke.getState();
          const pos = p.getCurrentTime() || 0;
          const dur = p.getDuration() || 0;
          getEngine().ytPos = pos;
          st.patch({ pos, duration: dur > 0 ? dur : st.duration });
          /* the real full-song length arrives late — re-derive line ends once */
          if (dur > 0 && Math.abs(dur - endsRef.current) > 0.5) {
            endsRef.current = dur;
            actions.refreshLyricEnds(dur);
          }

          let state = -1;
          try {
            state = p.getPlayerState();
          } catch {
            state = -1;
          }

          /* autoplay watchdog: the player is ready, play() was called, but
           * the browser refused unmuted autoplay (no error fires for this).
           * Buffering (3) keeps waiting — slow networks buffer for seconds.
           * A visible tap converts to a real user gesture → sound, always.
           * After one tap that failed too, never re-cover the iframe — the
           * user needs YouTube's own play button underneath. */
          if (!started) {
            if (state === 1) {
              started = true;
              setTap(false);
            } else if (
              readyAt > 0 &&
              Date.now() - readyAt > 3200 &&
              state !== 3 &&
              !tappedRef.current
            ) {
              setTap(true);
            }
          }

          /* stall watchdog: the player claims PLAYING but the clock is frozen
           * (silent embed walls never fire onError) — cascade after 3s. */
          if (state === 1 && Math.abs(pos - lastPosRef.current) < 0.05) {
            stallRef.current += 1;
          } else {
            stallRef.current = 0;
          }
          lastPosRef.current = pos;
          if (stallRef.current >= 12) {
            if (poll) window.clearInterval(poll);
            poll = 0;
            onFail(true);
          }
        }, 250);
      })
      .catch(() => onFail());

    return () => {
      dead = true;
      if (poll) window.clearInterval(poll);
      if (ytActivePlayer.current) {
        try {
          ytActivePlayer.current.destroy();
        } catch {
          /* already gone */
        }
        ytActivePlayer.current = null;
      }
      getEngine().ytPos = null;
      holder.innerHTML = '';
    };
  }, [videoId]);

  const tapStart = (): void => {
    tappedRef.current = true;
    setNeedsTap(false);
    const p = ytActivePlayer.current;
    try {
      p.playVideo();
    } catch {
      /* the iframe may not be ready yet — YouTube's own play button stays */
    }
  };

  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-[var(--line2)] bg-black">
      <div className="relative aspect-video w-full">
        {(busy || needsTap) && (
          <span className="absolute inset-0 z-10 flex items-center justify-center">
            {busy ? (
              <Loader2 size={26} className="animate-spin text-[var(--b)]" aria-hidden />
            ) : (
              /* autoplay was blocked — a real click is the only way in */
              <button
                type="button"
                onClick={tapStart}
                className="flex min-h-[44px] items-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--b)_60%,transparent)] bg-[var(--ink)]/85 px-5 py-2.5 text-[13px] font-black text-[var(--b)] shadow-lg backdrop-blur-sm transition-transform hover:scale-[1.03]"
              >
                <Music2 size={16} aria-hidden />
                {t.tapStart}
              </button>
            )}
          </span>
        )}
        <div ref={holderRef} className="h-full w-full [&>iframe]:absolute [&>iframe]:inset-0 [&>iframe]:h-full [&>iframe]:w-full" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* the stage panel — resolving row, live session, calibration, manual  */
/* ------------------------------------------------------------------ */

export function YouTubeStage() {
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const actions = useKaraokeEngine();
  const ytActive = useKaraoke((s) => s.ytActive);
  const ytVideoId = useKaraoke((s) => s.ytVideoId);
  const ytCandidates = useKaraoke((s) => s.ytCandidates);
  const ytIndex = useKaraoke((s) => s.ytIndex);
  const ytVariant = useKaraoke((s) => s.ytVariant);
  const ytResolving = useKaraoke((s) => s.ytResolving);
  const recording = useKaraoke((s) => s.recording);
  const activeDiscover = useKaraoke((s) => s.activeDiscover);
  const [link, setLink] = useState('');
  const [badLink, setBadLink] = useState(false);

  const loadManual = () => {
    const id = parseYtId(link);
    if (!id) {
      setBadLink(true);
      return;
    }
    setBadLink(false);
    actions.setYt(id, { manual: true });
  };

  const current = ytCandidates[ytIndex] ?? null;

  return (
    <section className="panel flex flex-col gap-2 p-3" aria-label={t.fullSong}>
      <header className="flex items-center gap-2">
        <Youtube size={15} className="text-[var(--b)]" aria-hidden />
        <h2 className="text-[11px] font-black tracking-[0.14em] text-[var(--dim)] uppercase">{t.fullSong}</h2>
        {ytActive && (
          <span className="ms-auto flex items-center gap-1.5">
            {recording && <span className="rec-dot kv text-[10px] text-[var(--crit)]">● REC</span>}
            <button
              type="button"
              onClick={() => actions.setYt(null)}
              className="flex min-h-[36px] items-center gap-1.5 rounded border border-[var(--line2)] bg-[var(--panel2)] px-2.5 text-[11px] font-bold text-[var(--dim)] transition-colors hover:text-[var(--text)]"
            >
              <RotateCcw size={12} aria-hidden />
              {t.ytOff}
            </button>
          </span>
        )}
      </header>

      {/* variant toggle — original song ⇄ karaoke (instrumental) track */}
      <div className="grid grid-cols-2 gap-1.5" role="group" aria-label={t.fullSong}>
        <button
          type="button"
          onClick={() => void actions.switchYtVariant('original')}
          disabled={ytVariant === 'original' || ytResolving}
          aria-pressed={ytVariant === 'original'}
          className={cn(
            'flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border text-[11.5px] font-bold transition-colors',
            ytVariant === 'original'
              ? 'border-[color-mix(in_srgb,var(--b)_55%,transparent)] bg-[var(--b-soft)] text-[var(--b)]'
              : 'border-[var(--line2)] bg-[var(--panel2)] text-[var(--dim)] hover:text-[var(--text)]',
            ytResolving && 'opacity-60',
          )}
        >
          <Music2 size={13} aria-hidden />
          {t.varOriginal}
        </button>
        <button
          type="button"
          onClick={() => void actions.switchYtVariant('karaoke')}
          disabled={ytVariant === 'karaoke' || ytResolving}
          aria-pressed={ytVariant === 'karaoke'}
          className={cn(
            'flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border text-[11.5px] font-bold transition-colors',
            ytVariant === 'karaoke'
              ? 'border-[color-mix(in_srgb,var(--b)_55%,transparent)] bg-[var(--b-soft)] text-[var(--b)]'
              : 'border-[var(--line2)] bg-[var(--panel2)] text-[var(--dim)] hover:text-[var(--text)]',
            ytResolving && 'opacity-60',
          )}
        >
          <Mic2 size={13} aria-hidden />
          {t.varKaraoke}
        </button>
      </div>

      {/* resolving — the server is ranking full-song sources */}
      {ytResolving && !ytActive && (
        <div className="flex items-center gap-2.5 rounded-lg border border-[color-mix(in_srgb,var(--b)_40%,transparent)] bg-[var(--b-soft)] px-3 py-2.5">
          <Loader2 size={15} className="animate-spin text-[var(--b)]" aria-hidden />
          <span className="text-[12px] font-bold text-[var(--b)]">{t.resolvingFull}</span>
        </div>
      )}

      {/* live full-song session */}
      {ytActive && ytVideoId && (
        <>
          <YtSession key={ytVideoId} videoId={ytVideoId} />

          {/* source line + lyric calibration */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 text-[10.5px] text-[var(--faint)]">
              <Timer size={11} aria-hidden className="shrink-0" />
              <span className="truncate">
                {t.source}: <span className="font-bold text-[var(--dim)]">{current?.channel || 'YouTube'}</span>
              </span>
              <span className="ms-auto shrink-0 tabular-nums" dir="ltr">
                {current ? `${fmtSec(current.durationSec)} · ${ytIndex + 1}/${ytCandidates.length}` : ''}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 text-[10px] font-bold text-[var(--faint)]" title={t.calibrateHint}>
                {t.calibrate}
              </span>
              <button
                type="button"
                onClick={() => actions.nudgeSync(-0.25)}
                title={t.nudgeMinus}
                aria-label={t.nudgeMinus}
                className="flex h-8 w-9 items-center justify-center rounded border border-[var(--line2)] bg-[var(--panel2)] text-[13px] font-black text-[var(--dim)] transition-colors hover:text-[var(--a)]"
              >
                −
              </button>
              <button
                type="button"
                onClick={() => actions.nudgeSync(0.25)}
                title={t.nudgePlus}
                aria-label={t.nudgePlus}
                className="flex h-8 w-9 items-center justify-center rounded border border-[var(--line2)] bg-[var(--panel2)] text-[13px] font-black text-[var(--dim)] transition-colors hover:text-[var(--a)]"
              >
                +
              </button>
              <span className="truncate text-[9.5px] text-[var(--faint)]">{t.calibrateHint}</span>
            </div>
          </div>
        </>
      )}

      {/* preview fallback — honest about the 30s and one click from retry */}
      {!ytActive && !ytResolving && activeDiscover && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--warn)_40%,transparent)] bg-[color-mix(in_srgb,var(--warn)_9%,transparent)] px-3 py-2.5">
            <AlertCircle size={15} className="shrink-0 text-[var(--warn)]" aria-hidden />
            <span className="text-[11.5px] font-medium text-[var(--dim)]">{t.previewNotice}</span>
            <button
              type="button"
              onClick={() => void actions.retryFullSong()}
              className="ms-auto flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg border border-[color-mix(in_srgb,var(--warn)_55%,transparent)] bg-[var(--panel2)] px-2.5 text-[11px] font-bold text-[var(--warn)] transition-colors hover:bg-[color-mix(in_srgb,var(--warn)_15%,transparent)]"
            >
              <RotateCcw size={12} aria-hidden />
              {t.retryFull}
            </button>
          </div>
        </div>
      )}

      {/* manual paste — secondary, only when the auto session is off */}
      {!ytActive && !ytResolving && (
        <>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Link2 size={13} aria-hidden className="pointer-events-none absolute inset-y-0 start-2.5 my-auto text-[var(--faint)]" />
              <input
                type="url"
                dir="ltr"
                value={link}
                onChange={(e) => {
                  setLink(e.target.value);
                  setBadLink(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') loadManual();
                }}
                placeholder={t.ytPlaceholder}
                aria-label={t.ytPlaceholder}
                className="h-10 w-full rounded border border-[var(--line2)] bg-[var(--well)] ps-8 pe-3 text-[12px] text-[var(--text)] placeholder:text-[var(--faint)] focus:border-[var(--b)] focus:shadow-[0_0_0_2px_var(--b-soft)] focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={loadManual}
              className="flex h-10 shrink-0 items-center gap-1.5 rounded border border-[color-mix(in_srgb,var(--b)_55%,transparent)] bg-[var(--b-soft)] px-3 text-[12px] font-bold text-[var(--b)] transition-colors hover:bg-[color-mix(in_srgb,var(--b)_22%,transparent)]"
            >
              {t.ytLoad}
            </button>
          </div>
          <p className="text-[10.5px] leading-relaxed text-[var(--faint)]">{t.ytManualHint} · {t.ytHint}</p>
        </>
      )}

      {badLink && (
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--crit)]" role="alert">
          <AlertCircle size={13} aria-hidden />
          {t.ytFail}
        </p>
      )}
    </section>
  );
}
