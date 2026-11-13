'use client';

/* TITO KARAOKE STUDIO v3.1 — the full-song YouTube stage.
 * v3.0 made full songs possible; v3.1 makes them the DEFAULT: the app
 * resolves the full song automatically (server-side ranking) and this stage
 * mounts the player the moment the session starts. An embed-blocked source
 * cascades to the next candidate; when all fail we fall back to the 30s
 * preview. Calibration buttons nudge the lyric timeline when a video carries
 * an intro/outro that shifts the words.
 */

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Link2, Loader2, RotateCcw, Timer, Youtube } from 'lucide-react';
import { toast } from 'sonner';
import { useKaraoke } from '@/store/karaoke';
import { useKaraokeEngine, getEngine } from '@/hooks/use-engine';
import { DICTS } from '@/lib/karaoke/i18n';
import { createYtPlayer, parseYtId, ytActivePlayer } from '@/lib/karaoke/yt';
import type { YtPlayer } from '@/lib/karaoke/yt';

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
  const holderRef = useRef<HTMLDivElement>(null);
  const endsRef = useRef(0);
  const stallRef = useRef(0);
  const lastPosRef = useRef(-1);

  useEffect(() => {
    if (!holderRef.current) return;
    let dead = false;
    let poll = 0;
    endsRef.current = 0;
    stallRef.current = 0;
    lastPosRef.current = -1;

    /* YT replaces the element it mounts on with an iframe — hand it a fresh
     * child div every session and clear the wrapper on teardown. */
    const holder = holderRef.current;
    holder.innerHTML = '';
    const el = document.createElement('div');
    holder.appendChild(el);

    /* one failure voice for the whole session: embed errors and dead
     * sources both cascade; every candidate exhausted → preview fallback. */
    const onFail = (): void => {
      if (dead) return;
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
        if (ev.data === 1) st.patch({ playing: true });
        else if (ev.data === 2) st.patch({ playing: false });
        else if (ev.data === 0) {
          st.patch({ playing: false });
          if (useKaraoke.getState().recording) void actions.stopRecording();
        }
      },
      () => onFail(),
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
          /* stall watchdog: the player claims PLAYING but the clock is frozen
           * (silent embed walls never fire onError) — cascade after 6s. */
          let state = -1;
          try {
            state = p.getPlayerState();
          } catch {
            state = -1;
          }
          if (state === 1 && Math.abs(pos - lastPosRef.current) < 0.05) {
            stallRef.current += 1;
          } else {
            stallRef.current = 0;
          }
          lastPosRef.current = pos;
          if (stallRef.current >= 24) {
            if (poll) window.clearInterval(poll);
            poll = 0;
            onFail();
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

  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-[var(--line2)] bg-black">
      <div className="relative aspect-video w-full">
        {busy && (
          <span className="absolute inset-0 z-10 flex items-center justify-center">
            <Loader2 size={26} className="animate-spin text-[var(--b)]" aria-hidden />
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
  const ytResolving = useKaraoke((s) => s.ytResolving);
  const recording = useKaraoke((s) => s.recording);
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
