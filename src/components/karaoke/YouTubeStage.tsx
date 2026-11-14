'use client';

/* TITO KARAOKE STUDIO v3.3 — the full-song YouTube stage.
 * v3.0 made full songs possible; v3.1 made them the DEFAULT; v3.2 made
 * them honest; v3.3 makes them BULLETPROOF where it matters — in the
 * browser, the only place embeddability can be verified:
 *
 *   • the PROBE GATE: every server-ranked candidate is mounted as a tiny
 *     MUTED iframe and played in parallel; the first source that actually
 *     starts (PLAYING + clock ticking) is promoted to the live session.
 *     Embed-blocked sources (iframe error 150/101 — the #1 full-song
 *     killer, invisible to every server-side probe) die in ~1s without
 *     ever reaching the user; walled/silent sources fall to the 10s
 *     deadline. Only a source that PLAYS becomes the session.
 *   • the live session starts MUTED (autoplay policy) so the clock, the
 *     lyrics and the mic pipeline all run from the first second; one tap
 *     on the "tap for sound" overlay turns the audio on (the tap is the
 *     user gesture the browser demands).
 *   • the stall watchdog still cascades sources that die mid-session.
 *   • variant toggle: original song ⇄ karaoke (instrumental) backing
 *     track — a true karaoke machine when the upload exists.
 *   • a preview fallback is honest about itself: a clear notice plus
 *     a "try the full song again" door, not just a 29s surprise.
 */

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, AudioLines, Link2, Loader2, Mic2, MousePointerClick, Music2, RotateCcw, Timer, Volume2, Youtube, Activity } from 'lucide-react';
import { toast } from 'sonner';
import { useKaraoke } from '@/store/karaoke';
import { useKaraokeEngine, getEngine } from '@/hooks/use-engine';
import { DICTS } from '@/lib/karaoke/i18n';
import { createYtPlayer, parseYtId, ytActivePlayer, ytStallFails } from '@/lib/karaoke/yt';
import type { YtPlayer } from '@/lib/karaoke/yt';
import type { YtCandidate } from '@/lib/karaoke/discover-types';
import { NetworkDoctor } from './NetworkDoctor';
import { cn } from '@/lib/utils';

function fmtSec(s: number): string {
  const v = Math.max(0, Math.round(s));
  const m = Math.floor(v / 60);
  const r = v % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* v3.3 — the PROBE GATE (v3.4: wave mode)                             */
/* Candidates play in WAVES of PROBE_BATCH, muted, in tiny hidden      */
/* iframes inside the stage box. First PLAYING source wins; every dead  */
/* source (error 150/101/100/5/2 or a failed mount) decrements the wave; */
/* when a whole wave dies the NEXT wave launches, so every ranked source*/
/* gets its chance. The gate fails only when all candidates are dead.   */
/* ------------------------------------------------------------------ */

const PROBE_BATCH = 6;
const WAVE_DEADLINE_MS = 8_000;
/** after PLAYING, wait this long for the clock to prove it moves */
const PROBE_CLOCK_GRACE_MS = 700;

function YtProbeGate({ candidates, batchKey }: { candidates: YtCandidate[]; batchKey: string }) {
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const actions = useKaraokeEngine();
  /** candidates given a verdict so far (dropped or won) — user-facing */
  const [checked, setChecked] = useState(0);
  const holderRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder || candidates.length === 0) return;
    let dead = false;
    let settled = false;
    const players = new Map<number, YtPlayer>();
    const dropped = new Set<number>();
    const timers = new Set<number>();
    let cursor = 0; // next candidate index to hand to a wave
    let waveRemaining = 0;

    const stopTimers = (): void => {
      for (const id of timers) window.clearTimeout(id);
      timers.clear();
    };
    const destroyAll = (): void => {
      for (const p of players.values()) {
        try {
          p.destroy();
        } catch {
          /* already gone */
        }
      }
      players.clear();
    };
    const cleanup = (): void => {
      stopTimers();
      destroyAll();
      holder.innerHTML = '';
    };
    const finish = (winner: { videoId: string; index: number } | null): void => {
      if (dead || settled) return;
      settled = true;
      cleanup();
      if (winner) actions.ytPromote(winner.videoId, winner.index);
      else void actions.ytProbeFailed();
    };
    const dropProbe = (i: number): void => {
      if (dropped.has(i)) return; // one verdict per probe — never double-decrement
      dropped.add(i);
      const p = players.get(i);
      if (p) {
        players.delete(i);
        try {
          p.destroy();
        } catch {
          /* already gone */
        }
      }
      waveRemaining -= 1;
      if (!dead) setChecked(dropped.size);
      if (waveRemaining <= 0) void launchWave(); // this wave is dead — next!
    };

    const launchWave = (): void => {
      if (dead || settled) return;
      const batch: Array<{ cand: YtCandidate; i: number }> = [];
      while (batch.length < PROBE_BATCH && cursor < candidates.length) {
        const cand = candidates[cursor];
        if (cand?.videoId) batch.push({ cand, i: cursor });
        cursor++;
      }
      if (batch.length === 0) {
        finish(null); // every ranked source got its chance
        return;
      }
      waveRemaining = batch.length;

      /* the wave's own deadline — slow/walled sources must not stall the gate */
      const deadline = window.setTimeout(() => {
        timers.delete(deadline);
        /* anything unresolved in this wave is dead — give the next wave a shot */
        for (const { i } of batch) if (!dropped.has(i)) dropProbe(i);
      }, WAVE_DEADLINE_MS);
      timers.add(deadline);

      for (const { cand, i } of batch) {
        /* tiny muted tiles stacked in a corner — invisible, non-interactive */
        const el = document.createElement('div');
        el.setAttribute('aria-hidden', 'true');
        el.style.cssText = `position:absolute;width:160px;height:90px;right:${(i % PROBE_BATCH) * 162}px;bottom:0;opacity:0.01;pointer-events:none;`;
        holder.appendChild(el);

        let mounted = false;
        void createYtPlayer(
          el,
          cand.videoId,
          (ev) => {
            if (ev.data === 1) {
              /* PLAYING while muted — prove the clock actually ticks before
               * committing: a bot-walled embed can claim PLAYING at a frozen 0 */
              const p = players.get(i);
              if (!p) return;
              const id = window.setTimeout(() => {
                timers.delete(id);
                if (dead || settled || !players.has(i)) return;
                try {
                  const live = players.get(i);
                  if (live?.getPlayerState() === 1 && (live.getCurrentTime() ?? 0) > 0.05) {
                    ytStallFails.count = 0; // the environment plays embeds — reset the cascade brake
                    finish({ videoId: cand.videoId, index: i });
                  }
                } catch {
                  /* iframe gone — the drop path handles it */
                }
              }, PROBE_CLOCK_GRACE_MS);
              timers.add(id);
            }
          },
          () => {
            /* embed-blocked (150/101), removed (100) or broken — this source is out */
            if (mounted) dropProbe(i);
          },
          { muted: true },
        )
          .then((p) => {
            if (dead || settled) {
              try {
                p.destroy();
              } catch {
                /* noop */
              }
              return;
            }
            mounted = true;
            players.set(i, p);
            try {
              p.mute();
              p.playVideo(); // muted autoplay — allowed without a gesture
            } catch {
              dropProbe(i);
            }
          })
          .catch(() => {
            if (!mounted) dropProbe(i);
          });
      }
    };

    holder.innerHTML = '';
    launchWave();

    return () => {
      dead = true;
      stopTimers();
      destroyAll();
      holder.innerHTML = '';
    };
  }, [batchKey]);

  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-[var(--line2)] bg-black">
      <div className="relative aspect-video w-full">
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[var(--ink)]/60 backdrop-blur-[2px]">
          <Loader2 size={30} className="animate-spin text-[var(--b)]" aria-hidden />
          <p className="text-[13px] font-bold text-[var(--text)]">{t.probingSources}</p>
          <p className="text-[11px] text-[var(--dim)]" dir="ltr">
            {Math.min(checked + Math.min(PROBE_BATCH, Math.max(0, candidates.length - checked)), candidates.length)} / {candidates.length} {t.probingCount}
          </p>
        </div>
        <div ref={holderRef} className="h-full w-full" aria-hidden />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* the live session — one mounted player per videoId (keyed resets all) */
/* ------------------------------------------------------------------ */

function YtSession({ videoId }: { videoId: string }) {
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const actions = useKaraokeEngine();
  /** player ready; not yet verified as playing */
  const [busy, setBusy] = useState(true);
  /** the muted clock actually moves (muted autoplay succeeded) */
  const [clockStarted, setClockStarted] = useState(false);
  /** overlay state: clock running but still muted (or never started) */
  const [needsTap, setNeedsTap] = useState(false);
  const holderRef = useRef<HTMLDivElement>(null);
  const endsRef = useRef(0);
  const stallRef = useRef(0);
  const lastPosRef = useRef(-1);
  /** one tap served — after it the overlay never covers YouTube's own controls */
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
    tappedRef.current = false;

    const setTap = (v: boolean): void => {
      if (dead) return;
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
        /* v3.4 — a pasted link that cannot embed gets ONE direct-audio
         * attempt for that exact video before the honest fallback */
        void actions.ytManualFailed(videoId);
      }
    };

    void createYtPlayer(
      el,
      videoId,
      (ev) => {
        const st = useKaraoke.getState();
        if (ev.data === 1) {
          st.patch({ playing: true });
          started = true;
          setClockStarted(true);
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
      /* v3.3: born muted — the clock/lyrics/mic start instantly and the
       * user's single tap turns the sound on (the gesture browsers demand) */
      { muted: true },
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
        try {
          player.playVideo(); // muted autoplay — runs without a gesture
        } catch {
          /* the watchdog below surfaces the tap if this failed */
        }
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
          let muted = true;
          try {
            state = p.getPlayerState();
            muted = p.isMuted();
          } catch {
            state = -1;
          }

          /* the sound gate: playing muted means the tap overlay stays up
           * ("tap for sound"); once the tap lands it never returns. */
          if (state === 1 && !started) {
            started = true;
            setClockStarted(true);
            setTap(false);
          }
          if (state === 1 && muted && !tappedRef.current) {
            setTap(true);
          }

          /* never-started watchdog: even muted autoplay can be hard-blocked
           * (no error fires for it) — after 3.2s of buffering-or-worse,
           * offer the tap that starts everything. */
          if (!started) {
            if (readyAt > 0 && Date.now() - readyAt > 3200 && state !== 3 && !tappedRef.current) {
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
    if (!p) return;
    try {
      p.unMute();
      p.setVolume(100);
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
              /* the sound gate — a real click is the only way to unmute */
              <button
                type="button"
                onClick={tapStart}
                className="flex min-h-[44px] items-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--b)_60%,transparent)] bg-[var(--ink)]/85 px-5 py-2.5 text-[13px] font-black text-[var(--b)] shadow-lg backdrop-blur-sm transition-transform hover:scale-[1.03]"
              >
                <Volume2 size={16} aria-hidden />
                {clockStarted ? t.tapForSound : t.tapStart}
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
/* the stage panel — resolving row, probe gate, live session, manual    */
/* ------------------------------------------------------------------ */

export function YouTubeStage({ onOpenEditor }: { onOpenEditor?: () => void }) {
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const actions = useKaraokeEngine();
  const ytActive = useKaraoke((s) => s.ytActive);
  const ytVideoId = useKaraoke((s) => s.ytVideoId);
  const ytCandidates = useKaraoke((s) => s.ytCandidates);
  const ytIndex = useKaraoke((s) => s.ytIndex);
  const ytVariant = useKaraoke((s) => s.ytVariant);
  const ytResolving = useKaraoke((s) => s.ytResolving);
  const ytProbing = useKaraoke((s) => s.ytProbing);
  const directActive = useKaraoke((s) => s.directActive);
  const directResolving = useKaraoke((s) => s.directResolving);
  const directChannel = useKaraoke((s) => s.directChannel);
  const duration = useKaraoke((s) => s.duration);
  const recording = useKaraoke((s) => s.recording);
  const activeDiscover = useKaraoke((s) => s.activeDiscover);
  const fullFailReason = useKaraoke((s) => s.fullFailReason);
  const syncState = useKaraoke((s) => s.syncState);
  const [link, setLink] = useState('');
  const [badLink, setBadLink] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);

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
  /* remount the gate whenever a fresh candidate list arrives */
  const batchKey = ytCandidates.map((c) => c.videoId).join(',');

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
          disabled={ytVariant === 'original' || ytResolving || ytProbing}
          aria-pressed={ytVariant === 'original'}
          className={cn(
            'flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border text-[11.5px] font-bold transition-colors',
            ytVariant === 'original'
              ? 'border-[color-mix(in_srgb,var(--b)_55%,transparent)] bg-[var(--b-soft)] text-[var(--b)]'
              : 'border-[var(--line2)] bg-[var(--panel2)] text-[var(--dim)] hover:text-[var(--text)]',
            (ytResolving || ytProbing) && 'opacity-60',
          )}
        >
          <Music2 size={13} aria-hidden />
          {t.varOriginal}
        </button>
        <button
          type="button"
          onClick={() => void actions.switchYtVariant('karaoke')}
          disabled={ytVariant === 'karaoke' || ytResolving || ytProbing}
          aria-pressed={ytVariant === 'karaoke'}
          className={cn(
            'flex min-h-[38px] items-center justify-center gap-1.5 rounded-lg border text-[11.5px] font-bold transition-colors',
            ytVariant === 'karaoke'
              ? 'border-[color-mix(in_srgb,var(--b)_55%,transparent)] bg-[var(--b-soft)] text-[var(--b)]'
              : 'border-[var(--line2)] bg-[var(--panel2)] text-[var(--dim)] hover:text-[var(--text)]',
            (ytResolving || ytProbing) && 'opacity-60',
          )}
        >
          <Mic2 size={13} aria-hidden />
          {t.varKaraoke}
        </button>
      </div>

      {/* resolving — the server is ranking full-song sources */}
      {ytResolving && !ytActive && !ytProbing && (
        <div className="flex items-center gap-2.5 rounded-lg border border-[color-mix(in_srgb,var(--b)_40%,transparent)] bg-[var(--b-soft)] px-3 py-2.5">
          <Loader2 size={15} className="animate-spin text-[var(--b)]" aria-hidden />
          <span className="text-[12px] font-bold text-[var(--b)]">{t.resolvingFull}</span>
        </div>
      )}

      {/* v3.3 — the probe gate verifies sources with real muted players */}
      {ytProbing && !ytActive && ytCandidates.length > 0 && (
        <YtProbeGate candidates={ytCandidates} batchKey={batchKey} />
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

      {/* v3.4 — direct-audio tier: resolving the server-side stream */}
      {directResolving && !directActive && !ytActive && !ytProbing && (
        <div className="flex items-center gap-2.5 rounded-lg border border-[color-mix(in_srgb,var(--b)_40%,transparent)] bg-[var(--b-soft)] px-3 py-2.5">
          <Loader2 size={15} className="animate-spin text-[var(--b)]" aria-hidden />
          <span className="text-[12px] font-bold text-[var(--b)]">{t.directFetching}</span>
        </div>
      )}

      {/* v3.4 — direct-audio full song: the engine owns the clock, the
          whole DSP chain (vocal removal, key shift, speed) is live */}
      {directActive && !ytActive && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5 rounded-lg border border-[color-mix(in_srgb,var(--b)_45%,transparent)] bg-[var(--b-soft)] px-3 py-2.5">
            <AudioLines size={16} className="shrink-0 text-[var(--b)]" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-black text-[var(--b)]">{t.directLive}</p>
              <p className="truncate text-[10.5px] text-[var(--dim)]">
                {t.source}: {directChannel || 'YouTube'}{duration > 0 ? ` · ${fmtSec(duration)}` : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={() => actions.setYt(null, { resumePreview: false })}
              className="flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg border border-[var(--line2)] bg-[var(--panel2)] px-2.5 text-[11px] font-bold text-[var(--dim)] transition-colors hover:text-[var(--text)]"
            >
              <RotateCcw size={12} aria-hidden />
              {t.ytOff}
            </button>
          </div>
          <p className="text-[10.5px] leading-relaxed text-[var(--faint)]">{t.directHint}</p>
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
      )}

      {/* preview fallback — honest about the 30s, the REASON it happened
          (v4.0: one law — no-sources / embeds-blocked — spoken to the user),
          and one click from both the retry and the Network Doctor */}
      {!ytActive && !ytResolving && !ytProbing && !directActive && !directResolving && activeDiscover && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--warn)_40%,transparent)] bg-[color-mix(in_srgb,var(--warn)_9%,transparent)] px-3 py-2.5">
            <AlertCircle size={15} className="shrink-0 text-[var(--warn)]" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-[11.5px] font-medium text-[var(--dim)]">{t.previewNotice}</p>
              {fullFailReason !== 'none' && (
                <p className="mt-0.5 text-[10.5px] font-bold text-[var(--warn)]">
                  {fullFailReason === 'embeds-blocked' ? t.previewCauseWall : t.previewCauseVideo}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => setDiagOpen((v) => !v)}
              aria-expanded={diagOpen}
              className="flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg border border-[var(--line2)] bg-[var(--panel2)] px-2.5 text-[11px] font-bold text-[var(--dim)] transition-colors hover:text-[var(--text)]"
            >
              <Activity size={12} aria-hidden />
              {t.diag}
            </button>
            <button
              type="button"
              onClick={() => void actions.retryFullSong()}
              className="flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg border border-[color-mix(in_srgb,var(--warn)_55%,transparent)] bg-[var(--panel2)] px-2.5 text-[11px] font-bold text-[var(--warn)] transition-colors hover:bg-[color-mix(in_srgb,var(--warn)_15%,transparent)]"
            >
              <RotateCcw size={12} aria-hidden />
              {t.retryFull}
            </button>
          </div>
          {diagOpen && <NetworkDoctor onClose={() => setDiagOpen(false)} />}
          {syncState === 'plain' && (
            <button
              type="button"
              onClick={onOpenEditor}
              className="flex min-h-[38px] items-center justify-center gap-2 rounded-lg border border-dashed border-[color-mix(in_srgb,var(--b)_45%,transparent)] bg-[var(--b-soft)] px-3 text-[11.5px] font-bold text-[var(--b)] transition-colors hover:bg-[color-mix(in_srgb,var(--b)_15%,transparent)]"
            >
              <MousePointerClick size={13} aria-hidden />
              {t.tapSyncCta}
            </button>
          )}
        </div>
      )}

      {/* manual paste — secondary, only when the auto session is off */}
      {!ytActive && !ytResolving && !ytProbing && !directActive && !directResolving && (
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
