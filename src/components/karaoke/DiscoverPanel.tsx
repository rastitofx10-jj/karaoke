'use client';

/* TITO KARAOKE STUDIO v2.0 — the DISCOVER panel.
 * Instant catalog search (debounced, skeletons, lyrics badges),
 * trending charts, "hot in the app", recent searches — one click streams
 * the song into the engine with AI-synced lyrics. No file imports needed.
 */

import { useEffect, useRef } from 'react';
import {
  Flame,
  Loader2,
  Music2,
  Play,
  Search,
  SearchX,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import { useKaraoke } from '@/store/karaoke';
import { useKaraokeEngine } from '@/hooks/use-engine';
import { DICTS } from '@/lib/karaoke/i18n';
import type { DiscoverSong } from '@/lib/karaoke/discover-types';
import { fmtSongDuration } from '@/lib/karaoke/discover-types';
import { Panel } from './controls';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------ */
/* one result row                                                      */
/* ------------------------------------------------------------------ */

function SongRow({ song, rank }: { song: DiscoverSong; rank?: number }) {
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const actions = useKaraokeEngine();
  const busy = useKaraoke((s) => s.discoverBusyId) === song.id;
  const plays = 'plays' in song && typeof song.plays === 'number' ? song.plays : null;

  return (
    <button
      type="button"
      onClick={() => void actions.loadDiscoverSong(song)}
      disabled={busy}
      title={`${song.artist} · ${song.title}`}
      className="group flex w-full items-center gap-2.5 rounded border border-transparent p-1.5 text-start transition-all hover:border-[var(--line)] hover:bg-[var(--panel2)] focus-visible:border-[var(--a)] disabled:cursor-wait disabled:opacity-60"
    >
      <span className="relative h-11 w-11 shrink-0 overflow-hidden rounded border border-[var(--line)] bg-[var(--well)]">
        {song.artworkSmall || song.artwork ? (
          <img
            src={song.artworkSmall || song.artwork}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center">
            <Music2 size={16} aria-hidden className="text-[var(--faint)]" />
          </span>
        )}
        <span className="absolute inset-0 flex items-center justify-center bg-black/60 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          {busy ? (
            <Loader2 size={15} className="animate-spin text-[var(--a)]" />
          ) : (
            <Play size={15} className="text-white" fill="currentColor" />
          )}
        </span>
        {typeof rank === 'number' && (
          <span className="absolute bottom-0 start-0 bg-black/70 px-1 text-[9px] font-black text-[var(--a)]">
            {rank}
          </span>
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-bold text-[var(--text)]">{song.title}</span>
          {(song.fullSources?.length ?? 0) > 0 && (
            <span
              className="kv flex shrink-0 items-center rounded-full border border-[color-mix(in_srgb,var(--good)_45%,transparent)] bg-[color-mix(in_srgb,var(--good)_12%,transparent)] px-1.5 py-px text-[8.5px] font-black text-[var(--good)]"
              title={t.fullHint}
            >
              {t.fullBadge}
            </span>
          )}
          {song.hasLrc && (
            <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--a-soft)] px-1.5 py-px text-[8.5px] font-black text-[var(--a)]">
              <Sparkles size={8} aria-hidden />
              {t.hasLyrics}
            </span>
          )}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--dim)]">
          <span className="truncate">{song.artist}</span>
          <span aria-hidden className="text-[var(--faint)]">·</span>
          <span className="shrink-0 tabular-nums text-[var(--faint)]">{fmtSongDuration(song.durationMs)}</span>
          {plays !== null && plays > 0 && (
            <>
              <span aria-hidden className="text-[var(--faint)]">·</span>
              <span className="flex shrink-0 items-center gap-0.5 text-[var(--b)]">
                <Flame size={8} aria-hidden />
                {plays}
              </span>
            </>
          )}
        </span>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* section header                                                      */
/* ------------------------------------------------------------------ */

function SectionHead({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[9px] font-black tracking-[0.14em] text-[var(--faint)] uppercase">
      {icon}
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* skeleton row                                                        */
/* ------------------------------------------------------------------ */

function RowSkeleton() {
  return (
    <div className="flex items-center gap-2.5 p-1.5">
      <span className="h-11 w-11 shrink-0 animate-pulse rounded bg-[var(--panel2)]" />
      <span className="flex w-full flex-col gap-1.5">
        <span className="h-3 w-3/5 animate-pulse rounded bg-[var(--panel2)]" />
        <span className="h-2.5 w-2/5 animate-pulse rounded bg-[var(--panel2)]" />
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* the panel                                                           */
/* ------------------------------------------------------------------ */

export function DiscoverPanel() {
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const actions = useKaraokeEngine();
  const q = useKaraoke((s) => s.discoverQuery);
  const results = useKaraoke((s) => s.discoverResults);
  const loading = useKaraoke((s) => s.discoverLoading);
  const error = useKaraoke((s) => s.discoverError);
  const trending = useKaraoke((s) => s.trending);
  const hot = useKaraoke((s) => s.hot);
  const recent = useKaraoke((s) => s.recentSearches);
  const syncState = useKaraoke((s) => s.syncState);
  const song = useKaraoke((s) => s.song);
  const inputRef = useRef<HTMLInputElement>(null);

  /* boot: recents + charts + hot */
  useEffect(() => {
    actions.loadRecentSearches();
    void actions.loadTrending();
    void actions.loadHot();
     
  }, []);

  /* debounced search */
  useEffect(() => {
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      void actions.searchDiscover('');
      return;
    }
    const id = setTimeout(() => void actions.searchDiscover(trimmed), 380);
    return () => clearTimeout(id);
     
  }, [q]);

  /* "/" focuses the search box */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
     
  }, []);

  const searching = q.trim().length >= 2;
  const showSyncRow = syncState === 'syncing' || (song !== null && syncState !== 'idle' && syncState !== 'none');
  const canNudge = !!song?.hasLrc && (syncState === 'synced' || syncState === 'plain' || syncState === 'idle');

  return (
    <Panel
      title={t.discover}
      icon={<Search size={12} aria-hidden />}
      className="min-h-[240px]"
      actions={
        <span className="flex items-center gap-1 text-[8.5px] font-bold text-[var(--faint)]">
          <kbd className="kv rounded border border-[var(--line2)] bg-[var(--well)] px-1 py-px">/</kbd>
        </span>
      }
    >
      <div className="flex h-full flex-col gap-2 p-2.5">
        {/* search box */}
        <div className="relative">
          <Search
            size={13}
            aria-hidden
            className="pointer-events-none absolute inset-y-0 start-2.5 my-auto text-[var(--faint)]"
          />
          <input
            ref={inputRef}
            type="search"
            value={q}
            onChange={(e) => useKaraoke.getState().patch({ discoverQuery: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results.length > 0) void actions.loadDiscoverSong(results[0]);
              if (e.key === 'Escape') e.currentTarget.blur();
            }}
            placeholder={t.searchPlaceholder}
            aria-label={t.searchPlaceholder}
            className="h-10 w-full rounded border border-[var(--line2)] bg-[var(--well)] ps-8 pe-3 text-[13px] font-medium text-[var(--text)] placeholder:text-[var(--faint)] focus:border-[var(--a)] focus:shadow-[0_0_0_2px_var(--a-soft)] focus:outline-none"
          />
          {loading && (
            <Loader2
              size={13}
              aria-hidden
              className="absolute inset-y-0 end-2.5 my-auto animate-spin text-[var(--a)]"
            />
          )}
        </div>

        {/* AI sync status + fine adjustment */}
        {showSyncRow && (
          <div className="flex items-center gap-2 rounded border border-[var(--line)] bg-[var(--well)] px-2 py-1.5">
            {syncState === 'syncing' ? (
              <>
                <Loader2 size={11} aria-hidden className="animate-spin text-[var(--a)]" />
                <span className="truncate text-[10px] font-medium text-[var(--dim)]">{t.syncingLyrics}</span>
              </>
            ) : (
              <>
                <Sparkles size={11} aria-hidden className="shrink-0 text-[var(--a)]" />
                <span className="shrink-0 text-[10px] font-black text-[var(--a)]">{t.syncAI}</span>
                {canNudge && (
                  <>
                    <span className="flex-1" />
                    <button
                      type="button"
                      onClick={() => actions.nudgeSync(-0.5)}
                      className="h-6 rounded border border-[var(--line2)] bg-[var(--panel2)] px-1.5 text-[9px] font-bold text-[var(--dim)] transition-colors hover:text-[var(--text)]"
                      title={t.nudgeBack}
                    >
                      −½s
                    </button>
                    <button
                      type="button"
                      onClick={() => actions.nudgeSync(-0.15)}
                      className="h-6 rounded border border-[var(--line2)] bg-[var(--panel2)] px-2 text-[10px] font-bold text-[var(--dim)] transition-colors hover:text-[var(--text)]"
                    >
                      −
                    </button>
                    <button
                      type="button"
                      onClick={() => actions.nudgeSync(0.15)}
                      className="h-6 rounded border border-[var(--line2)] bg-[var(--panel2)] px-2 text-[10px] font-bold text-[var(--dim)] transition-colors hover:text-[var(--text)]"
                    >
                      +
                    </button>
                    <button
                      type="button"
                      onClick={() => actions.nudgeSync(0.5)}
                      className="h-6 rounded border border-[var(--line2)] bg-[var(--panel2)] px-1.5 text-[9px] font-bold text-[var(--dim)] transition-colors hover:text-[var(--text)]"
                      title={t.nudgeFwd}
                    >
                      +½s
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* results / discovery */}
        <div className={cn('disc-scroll -me-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pe-1', searching && 'max-h-[420px]')}>
          {searching ? (
            <>
              {loading && results.length === 0 && (
                <>
                  <RowSkeleton />
                  <RowSkeleton />
                  <RowSkeleton />
                  <RowSkeleton />
                  <RowSkeleton />
                </>
              )}
              {!loading && error && (
                <div className="flex flex-col items-center gap-2 p-6 text-center">
                  <SearchX size={22} className="text-[var(--crit)]" aria-hidden />
                  <span className="text-[11px] text-[var(--dim)]">{t.networkError}</span>
                </div>
              )}
              {!loading && !error && results.length === 0 && (
                <div className="flex flex-col items-center gap-2 p-6 text-center">
                  <SearchX size={22} className="text-[var(--faint)]" aria-hidden />
                  <span className="text-[11px] text-[var(--dim)]">{t.noResults}</span>
                </div>
              )}
              {results.length > 0 && (
                <>
                  <SectionHead icon={<Search size={9} aria-hidden />} label={`${results.length} ${t.songs}`} />
                  {results.map((s) => (
                    <SongRow key={s.id} song={s} />
                  ))}
                </>
              )}
            </>
          ) : (
            <>
              {/* recent searches */}
              {recent.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <SectionHead icon={<Search size={9} aria-hidden />} label={t.recentSearches} />
                  <div className="flex flex-wrap gap-1">
                    {recent.map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => useKaraoke.getState().patch({ discoverQuery: r })}
                        className="rounded-full border border-[var(--line)] bg-[var(--well)] px-2 py-1 text-[10px] font-medium text-[var(--dim)] transition-colors hover:border-[var(--a)] hover:text-[var(--a)]"
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* hot in the app */}
              {hot.length > 0 && (
                <div className="flex flex-col gap-0.5">
                  <SectionHead icon={<Flame size={9} aria-hidden />} label={t.hotInApp} />
                  {hot.map((s) => (
                    <SongRow key={s.id} song={s} />
                  ))}
                </div>
              )}

              {/* trending charts */}
              {trending.length > 0 ? (
                <div className="flex flex-col gap-0.5">
                  <SectionHead icon={<TrendingUp size={9} aria-hidden />} label={t.trending} />
                  {trending.slice(0, 12).map((s, i) => (
                    <SongRow key={s.id} song={s} rank={i + 1} />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 p-6 text-center">
                  <Music2 size={22} className="animate-pulse text-[var(--faint)]" aria-hidden />
                  <span className="text-[11px] text-[var(--faint)]">{t.searchPlaceholder}</span>
                </div>
              )}

              <p className="mt-1 border-t border-[var(--line)] pt-2 text-center text-[8.5px] leading-relaxed text-[var(--faint)]">
                {t.previewNote}
              </p>
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}
