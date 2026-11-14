'use client';

/* TITO KARAOKE STUDIO v3.0 — THE ONE STAGE.
 * v2.0 was a mission-control console with a fake power gate, a buried search
 * and 8.5px text. v3.0 is two screens that do one thing each:
 *
 *   HOME  — the song search, front and center, big and beautiful.
 *   STUDIO— you, the lyrics, the mic. Transport always reachable.
 *
 * Keyboard: SPACE play · R record · M mic · F stage · E editor · ESC close.
 * Deep links: ?song=<b64 catalog song> drops a friend straight into the studio.
 * The console "powers on" itself the moment you pick a song — no fake door.
 */

import { useEffect, useState } from 'react';
import { FileMusic, Keyboard, Languages, Music2 } from 'lucide-react';
import { useKaraoke } from '@/store/karaoke';
import { useKaraokeEngine } from '@/hooks/use-engine';
import { DICTS } from '@/lib/karaoke/i18n';
import { cn } from '@/lib/utils';
import { SearchScreen } from './SearchScreen';
import { StudioScreen } from './StudioScreen';
import { LyricsEditor } from './LyricsEditor';
import { ResultsModal } from './RecorderPanel';
import { PlayerTransport } from './PlayerTransport';
import { LyricsStage } from './LyricsStage';
import { PitchRibbon } from './PitchRibbon';
import { Chip } from './controls';
import { Mic2, SlidersHorizontal } from 'lucide-react';
import type { DiscoverSong } from '@/lib/karaoke/discover-types';

function decodeSharedSong(raw: string): DiscoverSong | null {
  try {
    const json = decodeURIComponent(unescape(atob(decodeURIComponent(raw))));
    const s = JSON.parse(json) as DiscoverSong;
    if (s && typeof s.trackId === 'number' && typeof s.previewUrl === 'string' && typeof s.title === 'string') {
      return s;
    }
    return null;
  } catch {
    return null;
  }
}

export function KaraokeApp() {
  const actions = useKaraokeEngine();
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const screen = useKaraoke((s) => s.screen);
  const song = useKaraoke((s) => s.song);
  const playing = useKaraoke((s) => s.playing);
  const stageMode = useKaraoke((s) => s.stageMode);
  const micActive = useKaraoke((s) => s.micActive);
  const recording = useKaraoke((s) => s.recording);
  const syncState = useKaraoke((s) => s.syncState);
  const [editorOpen, setEditorOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  /* boot: persisted state + shared deep link */
  useEffect(() => {
    actions.loadPersistedState();
    const params = new URLSearchParams(window.location.search);
    const shared = params.get('song');
    if (shared) {
      const decoded = decodeSharedSong(shared);
      if (decoded) void actions.loadDiscoverSong(decoded);
      window.history.replaceState({}, '', window.location.pathname);
    }
     
  }, []);

  /* keyboard shortcuts */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        actions.toggle();
      } else if (e.key === 'r' || e.key === 'R') {
        actions.toggleRecording();
      } else if (e.key === 'm' || e.key === 'M') {
        void actions.toggleMic();
      } else if (e.key === 'f' || e.key === 'F') {
        useKaraoke.getState().patch({ stageMode: !useKaraoke.getState().stageMode });
      } else if (e.key === 'e' || e.key === 'E') {
        setEditorOpen((v) => !v);
      } else if (e.key === 'Escape') {
        useKaraoke.getState().patch({ stageMode: false });
        setEditorOpen(false);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
     
  }, []);

  /* drag & drop import — still works, but never required */
  useEffect(() => {
    const over = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(true);
    };
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragOver(false);
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer?.files?.[0];
      if (f && (f.type.startsWith('audio') || /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(f.name))) {
        void actions.loadAudioFile(f);
      } else if (f && /\.(lrc|srt|txt)$/i.test(f.name)) {
        void f.text().then((raw) => actions.setLyricsRaw(raw, f.name));
      }
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
     
  }, []);

  const inStudio = screen === 'studio';

  return (
    <div
      className={cn(
        /* v5.0 — overflow-x-clip: decorative SVG paths (icons) can inflate
         * scrollWidth on narrow screens; the page must never side-scroll */
        'flex min-h-screen flex-col overflow-x-clip bg-[var(--ink)]',
        /* studio is a fixed-height console on desktop: tools scroll inside,
         * the stage + transport always fit the viewport. Home scrolls free. */
        inStudio && 'lg:h-screen lg:overflow-hidden',
      )}
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* -------------------------------------------------------- top bar */}
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-[var(--line)] px-3">
        <button
          type="button"
          onClick={() => actions.goHome()}
          className={cn(
            'flex items-center gap-2 rounded-lg px-2 py-1 transition-colors',
            inStudio ? 'text-[var(--dim)] hover:text-[var(--a)]' : 'text-[var(--text)]',
          )}
          aria-label={t.home}
        >
          <span className="text-[15px] font-black tracking-tight">
            <span style={{ color: 'var(--a)' }}>TITO</span>
            <span className="text-[var(--text)]"> KARAOKE</span>
          </span>
        </button>
        <span className="kv hidden rounded border border-[var(--line2)] bg-[var(--well)] px-1.5 py-px text-[9px] text-[var(--faint)] sm:inline">
          v5.0 · FULL SONGS, ALWAYS — SOUNDCLOUD · AUDIUS
        </span>

        <span className="flex-1" />

        {/* now-playing chip — jump back into the studio */}
        {song && !inStudio && (
          <button
            type="button"
            onClick={() => actions.setScreen('studio')}
            className="flex max-w-[40vw] items-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--a)_45%,transparent)] bg-[var(--a-soft)] px-3 py-1.5 text-[11px] font-bold text-[var(--a)]"
            aria-label={t.studio}
          >
            <Music2 size={12} className={playing ? 'animate-pulse' : undefined} aria-hidden />
            <span className="truncate">{song.title}</span>
          </button>
        )}

        <button
          type="button"
          onClick={() => actions.toggleLang()}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-[var(--line2)] bg-[var(--panel2)] px-3 text-[11px] font-bold text-[var(--dim)] transition-colors hover:text-[var(--text)]"
          aria-label="language"
        >
          <Languages size={14} aria-hidden />
          {t.lang}
        </button>
      </header>

      {/* ------------------------------------------------------- the main */}
      {inStudio ? (
        <main className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          <StudioScreen onOpenEditor={() => setEditorOpen(true)} />
        </main>
      ) : (
        <main className="flex flex-1 flex-col">
          <SearchScreen />
        </main>
      )}

      {/* --------------------------------------------------------- footer */}
      <footer className="mt-auto flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] px-4 py-1.5">
        <span className="text-[10px] text-[var(--faint)]">{t.footer}</span>
        <span className="kv flex items-center gap-1.5 text-[9px] text-[var(--faint)]">
          <Keyboard size={10} aria-hidden />
          {t.shortcuts}
        </span>
      </footer>

      {/* --------------------------------------------------------- modals */}
      {editorOpen && (
        <LyricsEditor key={song?.id ?? 'no-song'} open={editorOpen} onClose={() => setEditorOpen(false)} />
      )}
      <ResultsModal />

      {/* stage mode overlay — the full-screen singing view */}
      {stageMode && inStudio && (
        <div className="fixed inset-0 z-40 flex flex-col bg-[var(--ink)]">
          <div className="flex items-center justify-between px-4 py-2" style={{ paddingTop: 'max(8px, env(safe-area-inset-top))' }}>
            <div className="flex items-center gap-2">
              <span className="text-sm font-black text-[var(--b)]">{t.stageMode}</span>
              {syncState === 'none' && <span className="kv text-[10px] text-[var(--crit)]">{t.syncNone}</span>}
            </div>
            <div className="flex items-center gap-2">
              <Chip active={micActive} onClick={() => void actions.toggleMic()} accent="good">
                <Mic2 size={12} className="me-1 inline" aria-hidden />
                {micActive ? t.on : t.enableMic}
              </Chip>
              <Chip active={recording} onClick={() => actions.toggleRecording()} accent="crit">
                ● {t.rec}
              </Chip>
              <button
                type="button"
                onClick={() => useKaraoke.getState().patch({ stageMode: false })}
                className="flex h-8 items-center gap-1.5 rounded border border-[var(--line2)] bg-[var(--panel2)] px-3 text-[11px] font-bold text-[var(--dim)] hover:text-[var(--text)]"
              >
                <SlidersHorizontal size={12} aria-hidden />
                {t.close}
              </button>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <LyricsStage big />
            <div className="shrink-0 px-6 pb-4">
              <PitchRibbon height={100} />
              <div className="mt-2">
                <PlayerTransport />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* drag overlay */}
      {dragOver && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-[var(--ink)]/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-[var(--a)] p-10">
            <FileMusic size={36} className="text-[var(--a)]" aria-hidden />
            <span className="text-lg font-bold text-[var(--a)]">{t.dropHere}</span>
          </div>
        </div>
      )}
    </div>
  );
}
