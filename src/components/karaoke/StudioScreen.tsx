'use client';

/* TITO KARAOKE STUDIO v3.0 — the STUDIO screen.
 * One screen, one job: you, the lyrics, the mic.
 *   top bar: back · song · badges · actions
 *   stage:   the lyrics (big, word-synced) + pitch ribbon
 *   tools:   full song (YouTube) · mic · vocal engine · recorder
 * The transport sits under the stage — always reachable on mobile.
 */

import { ArrowRight, Heart, Loader2, PencilLine, RotateCcw, SearchX, Share2, Sparkles, Theater } from 'lucide-react';
import { useKaraoke } from '@/store/karaoke';
import { useKaraokeEngine } from '@/hooks/use-engine';
import { DICTS } from '@/lib/karaoke/i18n';
import { PlayerTransport } from './PlayerTransport';
import { LyricsStage } from './LyricsStage';
import { PitchRibbon } from './PitchRibbon';
import { MicConsole } from './MicConsole';
import { VocalEnginePanel, MelodyScanPanel } from './VocalEnginePanel';
import { RecorderPanel, LibraryPanel } from './RecorderPanel';
import { YouTubeStage } from './YouTubeStage';
import { cn } from '@/lib/utils';

export function StudioScreen({ onOpenEditor }: { onOpenEditor: () => void }) {
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const actions = useKaraokeEngine();
  const song = useKaraoke((s) => s.song);
  const loading = useKaraoke((s) => s.loadingFile);
  const activeDiscover = useKaraoke((s) => s.activeDiscover);
  const syncState = useKaraoke((s) => s.syncState);
  const ytActive = useKaraoke((s) => s.ytActive);
  const directActive = useKaraoke((s) => s.directActive);
  const directResolving = useKaraoke((s) => s.directResolving);
  const micActive = useKaraoke((s) => s.micActive);
  const recording = useKaraoke((s) => s.recording);
  const liveScore = useKaraoke((s) => s.liveScore);
  const favorites = useKaraoke((s) => s.favorites);

  const isFav = activeDiscover ? favorites.some((f) => f.id === activeDiscover.id) : false;
  const ytResolving = useKaraoke((s) => s.ytResolving);
  const ytProbing = useKaraoke((s) => s.ytProbing);
  /* the preview badge only appears once the session is really preview-only */
  const showPreviewBadge = Boolean(
    activeDiscover && !ytActive && !ytResolving && !ytProbing && !directActive && !directResolving,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* ---------------------------------------------------------- top bar */}
      <header className="panel flex flex-wrap items-center gap-2 p-2">
        <button
          type="button"
          onClick={() => actions.goHome()}
          className="flex min-h-[44px] items-center gap-1.5 rounded-lg border border-[var(--line2)] bg-[var(--panel2)] px-3 text-[12px] font-bold text-[var(--dim)] transition-colors hover:text-[var(--a)]"
          aria-label={t.backHome}
        >
          <ArrowRight size={15} aria-hidden />
          <span className="hidden sm:inline">{t.backHome}</span>
        </button>

        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          {activeDiscover ? (
            <img
              src={activeDiscover.artworkSmall || activeDiscover.artwork}
              alt=""
              className="h-11 w-11 shrink-0 rounded-lg border border-[var(--line)] object-cover"
            />
          ) : (
            <span className="h-11 w-11 shrink-0 rounded-lg border border-[var(--line)] bg-[var(--well)]" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-black text-[var(--text)]">
              {loading ? t.loading : song ? song.title : t.noSong}
            </div>
            <div className="truncate text-[11px] text-[var(--dim)]">
              {song?.artist ?? ''}
            </div>
          </div>
        </div>

        {/* badges */}
        <div className="flex flex-wrap items-center gap-1.5">
          {showPreviewBadge && (
            <span className="kv rounded-full border border-[color-mix(in_srgb,var(--warn)_45%,transparent)] bg-[color-mix(in_srgb,var(--warn)_10%,transparent)] px-2 py-0.5 text-[10px] font-bold text-[var(--warn)]">
              {t.previewBadge}
            </span>
          )}
          {ytActive && (
            <span className="kv rounded-full border border-[color-mix(in_srgb,var(--b)_50%,transparent)] bg-[var(--b-soft)] px-2 py-0.5 text-[10px] font-bold text-[var(--b)]">
              {t.fullSong}
            </span>
          )}
          {directActive && (
            <span className="kv rounded-full border border-[color-mix(in_srgb,var(--b)_50%,transparent)] bg-[var(--b-soft)] px-2 py-0.5 text-[10px] font-bold text-[var(--b)]">
              {t.directLive}
            </span>
          )}
          {ytResolving && !ytActive && (
            <span className="flex items-center gap-1 rounded-full border border-[color-mix(in_srgb,var(--b)_50%,transparent)] bg-[var(--b-soft)] px-2 py-0.5 text-[10px] font-bold text-[var(--b)]">
              <Loader2 size={10} className="animate-spin" aria-hidden />
              {t.resolvingFull}
            </span>
          )}
          {syncState === 'synced' && (
            <span className="flex items-center gap-1 rounded-full bg-[var(--a-soft)] px-2 py-0.5 text-[10px] font-black text-[var(--a)]">
              <Sparkles size={10} aria-hidden />
              {t.synced}
            </span>
          )}
          {syncState === 'syncing' && (
            <span className="flex items-center gap-1 rounded-full bg-[var(--panel2)] px-2 py-0.5 text-[10px] font-bold text-[var(--dim)]">
              <Loader2 size={10} className="animate-spin" aria-hidden />
              {t.syncAI}
            </span>
          )}
        </div>

        {/* actions */}
        <div className="flex items-center gap-1.5">
          {activeDiscover && (
            <button
              type="button"
              onClick={() => actions.toggleFavorite(activeDiscover)}
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-lg border transition-colors',
                isFav
                  ? 'border-[color-mix(in_srgb,var(--b)_55%,transparent)] bg-[var(--b-soft)] text-[var(--b)]'
                  : 'border-[var(--line2)] bg-[var(--panel2)] text-[var(--dim)] hover:text-[var(--b)]',
              )}
              aria-label={isFav ? t.removeFav : t.addFav}
              title={isFav ? t.removeFav : t.addFav}
            >
              <Heart size={16} fill={isFav ? 'currentColor' : 'none'} aria-hidden />
            </button>
          )}
          {activeDiscover && (
            <button
              type="button"
              onClick={() => void actions.shareSong()}
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--line2)] bg-[var(--panel2)] text-[var(--dim)] transition-colors hover:text-[var(--a)]"
              aria-label={t.share}
              title={t.share}
            >
              <Share2 size={16} aria-hidden />
            </button>
          )}
          <button
            type="button"
            onClick={onOpenEditor}
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--line2)] bg-[var(--panel2)] text-[var(--dim)] transition-colors hover:text-[var(--a)]"
            aria-label={t.editor}
            title={t.editor}
          >
            <PencilLine size={16} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => useKaraoke.getState().patch({ stageMode: true })}
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-[color-mix(in_srgb,var(--b)_45%,transparent)] bg-[var(--b-soft)] text-[var(--b)] transition-colors hover:bg-[color-mix(in_srgb,var(--b)_20%,transparent)]"
            aria-label={t.stageMode}
            title={t.stageMode}
          >
            <Theater size={16} aria-hidden />
          </button>
        </div>
      </header>

      {/* ------------------------------------------------------ sync row */}
      {(syncState === 'syncing' || syncState === 'none') && (
        <div
          className={cn(
            'panel flex items-center gap-3 px-3 py-2',
            syncState === 'none' ? 'border-[color-mix(in_srgb,var(--crit)_35%,transparent)]' : undefined,
          )}
        >
          {syncState === 'syncing' ? (
            <>
              <Loader2 size={15} className="animate-spin text-[var(--a)]" aria-hidden />
              <span className="text-[12px] font-medium text-[var(--dim)]">{t.syncingLyrics}</span>
            </>
          ) : (
            <>
              <SearchX size={15} className="text-[var(--crit)]" aria-hidden />
              <span className="text-[12px] font-medium text-[var(--dim)]">{t.syncNone}</span>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => void actions.retryLyrics()}
                className="flex min-h-[38px] items-center gap-1.5 rounded-lg border border-[var(--line2)] bg-[var(--panel2)] px-3 text-[12px] font-bold text-[var(--dim)] transition-colors hover:text-[var(--a)]"
              >
                <RotateCcw size={13} aria-hidden />
                {t.retry}
              </button>
            </>
          )}
        </div>
      )}

      {/* ------------------------------------------------- main split view */}
      <div className="grid min-h-0 min-w-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* the stage — lyrics own the spotlight */}
        <div className="flex min-h-[46vh] min-w-0 flex-col gap-2 lg:min-h-0">
          <div className="stage-bg panel flex min-h-0 flex-1 flex-col overflow-hidden">
            <LyricsStage />
          </div>
          <div className="shrink-0">
            <PitchRibbon height={86} />
          </div>
          <div className="shrink-0">
            <PlayerTransport />
          </div>
        </div>

        {/* tools — mic, vocal engine, full song, recorder */}
        <div className="disc-scroll flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto pe-0.5">
          {/* quick mic CTA */}
          <button
            type="button"
            onClick={() => void actions.toggleMic()}
            className={cn(
              'flex min-h-[54px] w-full items-center gap-3 rounded-xl border-2 px-4 text-start transition-all',
              micActive
                ? 'border-[color-mix(in_srgb,var(--good)_55%,transparent)] bg-[color-mix(in_srgb,var(--good)_10%,transparent)]'
                : 'border-[color-mix(in_srgb,var(--b)_55%,transparent)] bg-[var(--b-soft)] hover:bg-[color-mix(in_srgb,var(--b)_20%,transparent)]',
            )}
            aria-pressed={micActive}
          >
            <span
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                micActive ? 'bg-[color-mix(in_srgb,var(--good)_25%,transparent)] text-[var(--good)]' : 'bg-[color-mix(in_srgb,var(--b)_22%,transparent)] text-[var(--b)]',
              )}
            >
              <span className="relative flex h-2.5 w-2.5">
                {micActive && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--good)] opacity-60" />}
                <span
                  className="relative inline-flex h-2.5 w-2.5 rounded-full"
                  style={{ background: micActive ? 'var(--good)' : 'var(--b)' }}
                />
              </span>
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn('block text-[13px] font-black', micActive ? 'text-[var(--good)]' : 'text-[var(--b)]')}>
                {micActive ? t.mic : t.enableMic}
              </span>
              <span className="block truncate text-[10.5px] text-[var(--faint)]">
                {micActive && liveScore
                  ? `${t.score} ${Math.round(liveScore.overall)} · ${t.ranks[liveScore.rank]}`
                  : micActive
                    ? t.yourPitch
                    : t.micHintShort}
              </span>
            </span>
            {recording && <span className="rec-dot kv text-[10px] font-bold text-[var(--crit)]">● REC</span>}
          </button>

          {activeDiscover && <YouTubeStage />}
          <MicConsole />
          <VocalEnginePanel />
          <RecorderPanel />
          <MelodyScanPanel />
          <LibraryPanel />
        </div>
      </div>
    </div>
  );
}
