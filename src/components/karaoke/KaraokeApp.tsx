'use client';

/* TITO KARAOKE STUDIO v2.0 — the console layout.
 * Desktop: discover+library | stage | mic+vocal. Mobile: tabs (search first).
 * Stage mode: fullscreen lyrics overlay. Drag&drop import still works.
 * Keyboard: SPACE play · S scan · R rec · M mic · F stage · E editor · / search.
 */

import { useEffect, useRef, useState } from 'react';
import { FileMusic, Keyboard, Library, Mic2, Search, SlidersHorizontal, Theater, PencilLine, ListMusic } from 'lucide-react';
import { useKaraoke } from '@/store/karaoke';
import { useKaraokeEngine } from '@/hooks/use-engine';
import { DICTS } from '@/lib/karaoke/i18n';
import { cn } from '@/lib/utils';
import { TopBar } from './TopBar';
import { PlayerTransport } from './PlayerTransport';
import { LyricsStage } from './LyricsStage';
import { PitchRibbon } from './PitchRibbon';
import { MicConsole } from './MicConsole';
import { VocalEnginePanel, MelodyScanPanel } from './VocalEnginePanel';
import { RecorderPanel, LibraryPanel, ResultsModal } from './RecorderPanel';
import { LyricsEditor } from './LyricsEditor';
import { SpectrumCanvas } from './SpectrumCanvas';
import { DiscoverPanel } from './DiscoverPanel';
import { Chip } from './controls';

type MobileTab = 'search' | 'stage' | 'mic' | 'library' | 'rec';

export function KaraokeApp() {
  const actions = useKaraokeEngine();
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const powered = useKaraoke((s) => s.powered);
  const stageMode = useKaraoke((s) => s.stageMode);
  const song = useKaraoke((s) => s.song);
  const recording = useKaraoke((s) => s.recording);
  const micActive = useKaraoke((s) => s.micActive);
  const [tab, setTab] = useState<MobileTab>('search');
  const [editorOpen, setEditorOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  /* load persisted state once */
  useEffect(() => {
    actions.loadPersistedState();
     
  }, []);

  /* keyboard shortcuts */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        actions.toggle();
      } else if (e.key === 's' || e.key === 'S') {
        void actions.scanMelody();
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

  /* drag & drop import */
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

  const tabs: Array<{ id: MobileTab; label: string; icon: React.ReactNode }> = [
    { id: 'search', label: t.searchTab, icon: <Search size={15} /> },
    { id: 'stage', label: t.lyrics, icon: <Theater size={15} /> },
    { id: 'mic', label: t.mic, icon: <Mic2 size={15} /> },
    { id: 'library', label: t.library, icon: <Library size={15} /> },
    { id: 'rec', label: t.recorder, icon: <ListMusic size={15} /> },
  ];

  return (
    <div
      ref={dropRef}
      className="flex min-h-screen flex-col bg-[var(--ink)]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <TopBar />

      {/* power gate */}
      {!powered ? (
        <main className="stage-bg flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
          <div
            className="text-5xl leading-none font-black tracking-wide sm:text-7xl"
            style={{ color: 'var(--a)' }}
          >
            {t.brand}
          </div>
          <p className="max-w-md text-sm leading-relaxed text-[var(--dim)]">{t.footer}</p>
          <button
            type="button"
            onClick={() => void actions.powerOn()}
            className="flex min-h-[52px] items-center gap-3 rounded-full border-2 border-[color-mix(in_srgb,var(--a)_60%,transparent)] bg-[color-mix(in_srgb,var(--a)_12%,transparent)] px-10 text-base font-black tracking-widest text-[var(--a)] uppercase transition-all hover:bg-[color-mix(in_srgb,var(--a)_22%,transparent)]"
          >
            ⏻ {t.power}
          </button>
          <p className="text-[11px] text-[var(--faint)]">{t.powerOn}</p>
        </main>
      ) : (
        <main className="flex min-h-0 flex-1 flex-col gap-3 p-3 pb-24 lg:h-[calc(100vh-52px)] lg:pb-3">
          {/* transport — always visible */}
          <div className="shrink-0">
            <PlayerTransport />
          </div>

          {/* desktop 3-column grid */}
          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[320px_minmax(0,1fr)_320px]">
            {/* left — discover + library + scan */}
            <div className="disc-scroll hidden min-h-0 flex-col gap-3 overflow-y-auto pe-0.5 lg:flex">
              <DiscoverPanel />
              <MelodyScanPanel />
              <LibraryPanel />
            </div>

            {/* center — the stage */}
            <div className={cn('stage-bg panel flex min-h-0 flex-col gap-2 overflow-hidden', tab !== 'stage' && 'hidden lg:flex')}>
              <LyricsStage />
              <div className="shrink-0 px-3 pb-3">
                <PitchRibbon height={110} />
              </div>
            </div>

            {/* right — mic + vocal engine + recorder */}
            <div className="hidden min-h-0 flex-col gap-3 overflow-y-auto lg:flex">
              <MicConsole />
              <VocalEnginePanel />
              <RecorderPanel />
            </div>
          </div>

          {/* mobile tabs content */}
          <div className="lg:hidden">
            {tab === 'search' && <DiscoverPanel />}
            {tab === 'library' && (
              <div className="flex flex-col gap-3">
                <MelodyScanPanel />
                <LibraryPanel />
              </div>
            )}
            {tab === 'mic' && (
              <div className="flex flex-col gap-3">
                <MicConsole />
                <VocalEnginePanel />
              </div>
            )}
            {tab === 'rec' && <RecorderPanel />}
          </div>

          {/* spectrum strip (desktop bottom) */}
          <div className="hidden shrink-0 lg:block">
            <SpectrumCanvas height={36} />
          </div>
        </main>
      )}

      {/* editor + results */}
      {editorOpen && (
        <LyricsEditor key={song?.id ?? 'no-song'} open={editorOpen} onClose={() => setEditorOpen(false)} />
      )}
      <ResultsModal />

      {/* editor open button */}
      {powered && (
        <button
          type="button"
          onClick={() => setEditorOpen(true)}
          className="fixed bottom-24 left-4 z-20 flex h-10 w-10 items-center justify-center rounded-full border border-[var(--line2)] bg-[var(--panel2)] text-[var(--dim)] shadow-lg transition-colors hover:text-[var(--a)] lg:bottom-4"
          title={t.editor}
          aria-label={t.editor}
        >
          <PencilLine size={16} />
        </button>
      )}

      {/* mobile tab bar */}
      {powered && (
        <nav
          className="fixed inset-x-0 bottom-0 z-20 flex items-stretch gap-1 border-t border-[var(--line)] bg-[var(--ink)]/95 p-2 backdrop-blur lg:hidden"
          style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom))' }}
          aria-label="tabs"
        >
          {tabs.map((tb) => (
            <button
              key={tb.id}
              type="button"
              onClick={() => setTab(tb.id)}
              className={cn(
                'flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 rounded text-[9px] font-bold transition-colors',
                tab === tb.id ? 'bg-[var(--a-soft)] text-[var(--a)]' : 'text-[var(--faint)]',
              )}
              aria-current={tab === tb.id}
            >
              {tb.icon}
              {tb.label}
            </button>
          ))}
        </nav>
      )}

      {/* footer */}
      <footer className="mt-auto hidden shrink-0 items-center justify-between gap-4 border-t border-[var(--line)] px-4 py-1.5 lg:flex">
        <span className="text-[10px] text-[var(--faint)]">{t.footer}</span>
        <span className="kv flex items-center gap-1.5 text-[9px] text-[var(--faint)]">
          <Keyboard size={10} />
          {t.shortcuts}
        </span>
      </footer>

      {/* drag overlay */}
      {dragOver && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-[var(--ink)]/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-[var(--a)] p-10">
            <FileMusic size={36} className="text-[var(--a)]" />
            <span className="text-lg font-bold text-[var(--a)]">{t.dropHere}</span>
          </div>
        </div>
      )}

      {/* stage mode overlay */}
      {stageMode && (
        <div className="fixed inset-0 z-40 flex flex-col bg-[var(--ink)]">
          <div className="flex items-center justify-between px-4 py-2" style={{ paddingTop: 'max(8px, env(safe-area-inset-top))' }}>
            <div className="flex items-center gap-2">
              <Theater size={16} className="text-[var(--b)]" />
              <span className="text-sm font-black text-[var(--b)]">{t.stageMode}</span>
              {recording && (
                <span className="rec-dot kv text-[10px] text-[var(--crit)]">● {t.recording} {Math.floor(useKaraoke.getState().recSec)}s</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Chip active={micActive} onClick={() => void actions.toggleMic()} accent="good">
                <Mic2 size={12} className="me-1 inline" />
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
                <SlidersHorizontal size={12} />
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

      {/* song badge for empty stage hint */}
      {!powered && (
        <div className="pointer-events-none fixed bottom-3 left-1/2 -translate-x-1/2">
          <span className="kv text-[9px] tracking-widest text-[var(--faint)] uppercase">{t.version}</span>
        </div>
      )}
    </div>
  );
}
