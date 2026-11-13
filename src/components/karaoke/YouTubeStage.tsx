'use client';

/* TITO KARAOKE STUDIO v3.0 — the full-song YouTube stage.
 * Paste a link → the video plays in sync with the lyrics; the store clock
 * follows the player (getCurrentTime), the mic chain keeps scoring pitch.
 */

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Link2, Loader2, RotateCcw, Youtube } from 'lucide-react';
import { useKaraoke } from '@/store/karaoke';
import { useKaraokeEngine } from '@/hooks/use-engine';
import { DICTS } from '@/lib/karaoke/i18n';
import { createYtPlayer, parseYtId, ytActivePlayer } from '@/lib/karaoke/yt';
import { cn } from '@/lib/utils';

export function YouTubeStage() {
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const actions = useKaraokeEngine();
  const ytActive = useKaraoke((s) => s.ytActive);
  const ytVideoId = useKaraoke((s) => s.ytVideoId);
  const recording = useKaraoke((s) => s.recording);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const holderRef = useRef<HTMLDivElement>(null);

  /* create/destroy the player when the session video changes */
  useEffect(() => {
    if (!ytActive || !ytVideoId || !holderRef.current) return;
    let dead = false;
    let poll = 0;
    /* YT replaces the element it mounts on with an iframe — so we hand it a
     * fresh child div every session and clear the wrapper on teardown. */
    const holder = holderRef.current;
    holder.innerHTML = '';
    const el = document.createElement('div');
    holder.appendChild(el);

    void createYtPlayer(el, ytVideoId, (ev) => {
      /* state events keep the store honest; polling covers the clock */
      const st = useKaraoke.getState();
      if (ev.data === 1) st.patch({ playing: true });
      else if (ev.data === 2) st.patch({ playing: false });
      else if (ev.data === 0) {
        st.patch({ playing: false });
        if (useKaraoke.getState().recording) void actions.stopRecording();
      }
    })
      .then((player) => {
        if (dead) {
          player.destroy();
          return;
        }
        ytActivePlayer.current = player;
        setBusy(false);
        void player.playVideo();
        poll = window.setInterval(() => {
          const p = ytActivePlayer.current;
          if (!p) return;
          const st = useKaraoke.getState();
          const pos = p.getCurrentTime() || 0;
          const dur = p.getDuration() || 0;
          st.patch({ pos, duration: dur > 0 ? dur : st.duration });
        }, 250);
      })
      .catch(() => {
        if (!dead) {
          setBusy(false);
          setError(true);
          useKaraoke.getState().patch({ ytActive: false, ytVideoId: null });
        }
      });

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
      holder.innerHTML = '';
    };
     
  }, [ytActive, ytVideoId]);

  const load = () => {
    const id = parseYtId(link);
    if (!id) {
      setError(true);
      return;
    }
    setError(false);
    setBusy(true);
    actions.setYt(id);
  };

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

      {!ytActive ? (
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
                  setError(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') load();
                }}
                placeholder={t.ytPlaceholder}
                aria-label={t.ytPlaceholder}
                className="h-10 w-full rounded border border-[var(--line2)] bg-[var(--well)] ps-8 pe-3 text-[12px] text-[var(--text)] placeholder:text-[var(--faint)] focus:border-[var(--b)] focus:shadow-[0_0_0_2px_var(--b-soft)] focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={load}
              className="flex h-10 shrink-0 items-center gap-1.5 rounded border border-[color-mix(in_srgb,var(--b)_55%,transparent)] bg-[var(--b-soft)] px-3 text-[12px] font-bold text-[var(--b)] transition-colors hover:bg-[color-mix(in_srgb,var(--b)_22%,transparent)]"
            >
              {t.ytLoad}
            </button>
          </div>
          <p className="text-[10.5px] leading-relaxed text-[var(--faint)]">{t.ytHint}</p>
        </>
      ) : (
        <div className="relative w-full overflow-hidden rounded-lg border border-[var(--line2)] bg-black">
          <div className={cn('relative aspect-video w-full', busy && 'flex items-center justify-center')}>
            {busy && (
              <span className="absolute inset-0 z-10 flex items-center justify-center">
                <Loader2 size={26} className="animate-spin text-[var(--b)]" aria-hidden />
              </span>
            )}
            <div ref={holderRef} className="h-full w-full [&>iframe]:absolute [&>iframe]:inset-0 [&>iframe]:h-full [&>iframe]:w-full" />
          </div>
        </div>
      )}

      {error && (
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--crit)]">
          <AlertCircle size={13} aria-hidden />
          {t.ytFail}
        </p>
      )}
    </section>
  );
}
