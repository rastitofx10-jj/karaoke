'use client';

/* TITO KARAOKE STUDIO v3.0 — SearchScreen: the search-first landing (HOME).
 * One huge catalog search above everything else: a giant gradient brand
 * hero, quick category chips, and generous artwork-card grids (favorites,
 * recents, hot, trending). No file imports — search, tap a card, sing.
 * RTL-first (logical properties), dark neon console, amber + rose only.
 */

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  Clock,
  Flame,
  Heart,
  Loader2,
  Music2,
  Play,
  Radio,
  Search,
  SearchX,
  Sparkles,
  TrendingUp,
  X,
} from 'lucide-react';
import { useKaraoke } from '@/store/karaoke';
import { useKaraokeEngine } from '@/hooks/use-engine';
import { DICTS } from '@/lib/karaoke/i18n';
import type { DiscoverSong } from '@/lib/karaoke/discover-types';
import { fmtSongDuration } from '@/lib/karaoke/discover-types';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------ */
/* quick-search categories — fixed list, labels per language           */
/* ------------------------------------------------------------------ */

const CATEGORIES: ReadonlyArray<{ he: string; en: string; term: string; icon: typeof Flame }> = [
  { he: 'להיטים', en: 'Hits', term: 'top hits', icon: Flame },
  { he: 'מוזיקה ישראלית', en: 'Israeli', term: 'מוזיקה ישראלית', icon: Radio },
  { he: 'פופ', en: 'Pop', term: 'pop', icon: Music2 },
  { he: 'רוק', en: 'Rock', term: 'rock', icon: Sparkles },
  { he: 'בלדות', en: 'Ballads', term: 'ballads', icon: Play },
  { he: 'אהבה', en: 'Love', term: 'love songs', icon: Heart },
  { he: 'מסיבה', en: 'Party', term: 'party hits', icon: TrendingUp },
  { he: 'שנות ה-80', en: '80s', term: '80s hits', icon: Clock },
  { he: 'שנות ה-90', en: '90s', term: '90s hits', icon: Clock },
  { he: 'קלאסיקה', en: 'Classics', term: 'karaoke classics', icon: Clock },
];

/* one responsive card grid to rule every section */
const GRID = 'grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5';

/* ------------------------------------------------------------------ */
/* section header — icon + label + rule line                            */
/* ------------------------------------------------------------------ */

function SectionHead({ icon, label, note }: { icon: ReactNode; label: ReactNode; note?: string }) {
  return (
    <div className="flex items-center gap-2 py-3 text-xs font-black tracking-[0.12em] text-[var(--faint)] uppercase">
      {icon}
      <span className="shrink-0">{label}</span>
      <div aria-hidden className="h-px flex-1 bg-[var(--line)]" />
      {note !== undefined && (
        <span className="shrink-0 text-[11px] font-medium tracking-normal normal-case text-[var(--faint)]">
          {note}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* skeleton card — shown while the first search page is in flight       */
/* ------------------------------------------------------------------ */

function CardSkeleton() {
  return (
    <div className="panel rounded-xl p-2">
      <div className="aspect-square animate-pulse rounded-lg bg-[var(--panel2)]" />
      <div className="mt-2 h-3.5 w-4/5 animate-pulse rounded bg-[var(--panel2)]" />
      <div className="mt-1.5 h-2.5 w-2/5 animate-pulse rounded bg-[var(--panel2)]" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SongCard — generous, touch-friendly artwork card                     */
/* (root is a div[role=button] so the heart can be a real <button>)     */
/* ------------------------------------------------------------------ */

function SongCard({ song }: { song: DiscoverSong }) {
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const actions = useKaraokeEngine();
  const favorites = useKaraoke((s) => s.favorites);
  const busy = useKaraoke((s) => s.discoverBusyId === song.id);
  /* recompute via the engine action whenever the favorites list changes */
  const fav = useMemo(() => actions.isFavorite(song.id), [actions, song.id, favorites]);
  const plays = typeof song.plays === 'number' && song.plays > 0 ? song.plays : null;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${t.sing}: ${song.artist} · ${song.title}`}
      aria-busy={busy}
      title={`${song.artist} · ${song.title}`}
      onClick={() => void actions.loadDiscoverSong(song)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          void actions.loadDiscoverSong(song);
        }
      }}
      className="panel group relative w-full cursor-pointer rounded-xl p-2 text-start transition-all hover:border-[var(--a)] focus-visible:border-[var(--a)] focus-visible:outline-none"
    >
      {/* artwork */}
      <div className="relative aspect-square overflow-hidden rounded-lg bg-[var(--well)]">
        <img
          src={song.artwork || song.artworkSmall}
          alt={`${song.artist} · ${song.title}`}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
        />
        {/* hover / busy overlay */}
        <div
          className={cn(
            'absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/55 transition-opacity',
            busy ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
          )}
        >
          {busy ? (
            <Loader2 size={32} aria-hidden className="animate-spin text-[var(--a)]" />
          ) : (
            <>
              <Play size={34} fill="currentColor" aria-hidden className="text-[var(--a)]" />
              <span className="text-[11px] font-black tracking-widest text-[var(--a)] uppercase">
                {t.singNow}
              </span>
            </>
          )}
        </div>
      </div>

      {/* heart — real button, never triggers the card click */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          actions.toggleFavorite(song);
        }}
        aria-label={fav ? t.removeFav : t.addFav}
        aria-pressed={fav}
        className="absolute top-1.5 end-1.5 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 backdrop-blur transition-colors hover:bg-black/70"
      >
        <Heart
          size={16}
          aria-hidden
          fill={fav ? 'currentColor' : 'none'}
          className={fav ? 'text-[var(--b)]' : 'text-[var(--dim)]'}
        />
      </button>

      {/* text */}
      <p className="mt-2 line-clamp-2 text-sm leading-snug font-bold text-[var(--text)]">{song.title}</p>
      <p className="mt-0.5 truncate text-xs text-[var(--dim)]">{song.artist}</p>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--faint)]">
        <span className="shrink-0 tabular-nums">{fmtSongDuration(song.durationMs)}</span>
        {song.hasLrc && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--a-soft)] px-1.5 font-bold text-[var(--a)]">
            <Sparkles size={10} aria-hidden />
            {t.hasLyrics}
          </span>
        )}
        {plays !== null && (
          <span className="flex shrink-0 items-center gap-1 text-[var(--b)]" title={t.playCount}>
            <Flame size={10} aria-hidden />
            {plays}
          </span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* the screen                                                           */
/* ------------------------------------------------------------------ */

export function SearchScreen() {
  const lang = useKaraoke((s) => s.lang);
  const query = useKaraoke((s) => s.discoverQuery);
  const results = useKaraoke((s) => s.discoverResults);
  const loading = useKaraoke((s) => s.discoverLoading);
  const error = useKaraoke((s) => s.discoverError);
  const trending = useKaraoke((s) => s.trending);
  const hot = useKaraoke((s) => s.hot);
  const recent = useKaraoke((s) => s.recentSearches);
  const favorites = useKaraoke((s) => s.favorites);
  const actions = useKaraokeEngine();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resultsRef = useRef<HTMLElement | null>(null);

  const t = DICTS[lang];
  const trimmed = query.trim();
  const searching = trimmed.length >= 2;

  /* boot: recents + charts + hot — once.
   * (react-hooks/exhaustive-deps is off in eslint.config.mjs, so the classic
   * empty-deps boot effect below needs no suppression comment.) */
  useEffect(() => {
    actions.loadRecentSearches();
    void actions.loadTrending();
    void actions.loadHot();
  }, []);

  /* debounced catalog search — reset when under the 2-char threshold */
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      void actions.searchDiscover('');
      return;
    }
    const id = window.setTimeout(() => void actions.searchDiscover(q), 380);
    return () => window.clearTimeout(id);
  }, [query]);

  /* apply a term from a chip / recent search and glide to the results */
  const applyTerm = (term: string) => {
    useKaraoke.getState().patch({ discoverQuery: term });
    window.setTimeout(() => {
      resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 90);
  };

  return (
    <div className="stage-bg mx-auto w-full max-w-6xl px-4 sm:px-6">
      {/* hero — idle mode only */}
      {!searching && (
        <header className="py-12 text-center sm:py-16">
          <h1
            className="glow-a text-5xl leading-[1.1] font-black sm:text-7xl"
            style={{
              background: 'linear-gradient(120deg, var(--a), var(--b))',
              WebkitBackgroundClip: 'text',
              color: 'transparent',
            }}
          >
            {t.brand}
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-sm text-[var(--dim)] sm:text-base">{t.homeTagline}</p>
          <p className="mt-2 text-[11px] text-[var(--faint)]">{t.homeHint}</p>
        </header>
      )}

      {/* the search bar — always at the top, even with results on screen */}
      <div className={cn('mx-auto w-full max-w-2xl', searching && 'pt-4 sm:pt-6')}>
        <div className="relative">
          <Search
            size={20}
            aria-hidden
            className="pointer-events-none absolute start-4 top-1/2 -translate-y-1/2 text-[var(--faint)]"
          />
          <input
            ref={inputRef}
            type="text"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => useKaraoke.getState().patch({ discoverQuery: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results.length > 0) void actions.loadDiscoverSong(results[0]);
              if (e.key === 'Escape') e.currentTarget.blur();
            }}
            placeholder={t.searchPlaceholder}
            aria-label={t.searchPlaceholder}
            className="h-14 w-full rounded-2xl border border-[var(--line2)] bg-[var(--well)] ps-12 pe-14 text-base font-medium text-[var(--text)] transition-all placeholder:text-[var(--faint)] focus:border-[var(--a)] focus:shadow-[0_0_0_3px_var(--a-soft)] focus:outline-none sm:h-16 sm:text-lg"
          />
          {loading ? (
            <Loader2
              size={20}
              aria-hidden
              className="absolute end-4 top-1/2 -translate-y-1/2 animate-spin text-[var(--a)]"
            />
          ) : query !== '' ? (
            <button
              type="button"
              onClick={() => {
                useKaraoke.getState().patch({ discoverQuery: '' });
                inputRef.current?.focus();
              }}
              aria-label={lang === 'he' ? 'ניקוי חיפוש' : 'Clear search'}
              className="absolute end-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-[var(--dim)] transition-colors hover:bg-[var(--panel2)] hover:text-[var(--text)]"
            >
              <X size={18} aria-hidden />
            </button>
          ) : null}
        </div>

        {/* nudge while stuck between one character and the search threshold */}
        {!searching && trimmed.length > 0 && (
          <p className="mt-3 text-center text-[11px] text-[var(--faint)]">{t.typeMore}</p>
        )}
      </div>

      {/* quick categories — one tap away from a fresh search */}
      <div className="mt-4 flex snap-x snap-proximity gap-2 overflow-x-auto pb-2">
        {CATEGORIES.map((c) => {
          const Icon = c.icon;
          return (
            <button
              key={c.term}
              type="button"
              onClick={() => applyTerm(c.term)}
              className="flex min-h-[40px] snap-start items-center gap-1.5 rounded-full border border-[var(--line2)] bg-[var(--panel2)] px-4 py-2 text-xs font-bold whitespace-nowrap text-[var(--dim)] transition-colors hover:border-[var(--a)] hover:text-[var(--a)] sm:text-sm"
            >
              <Icon size={13} aria-hidden className="shrink-0" />
              {lang === 'he' ? c.he : c.en}
            </button>
          );
        })}
      </div>

      {searching ? (
        /* ---------------- search results ---------------- */
        <section ref={resultsRef} className="scroll-mt-4 pb-14">
          <SectionHead
            icon={<TrendingUp size={13} aria-hidden />}
            label={`${t.resultsFor} \u200F"${trimmed}"`}
            note={t.previewNote}
          />

          {error !== null ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <SearchX size={36} aria-hidden className="text-[var(--crit)]" />
              <p className="text-sm font-bold text-[var(--crit)]">{t.networkError}</p>
            </div>
          ) : loading && results.length === 0 ? (
            <div className={GRID}>
              {Array.from({ length: 10 }, (_, i) => (
                <CardSkeleton key={i} />
              ))}
            </div>
          ) : results.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <SearchX size={36} aria-hidden className="text-[var(--faint)]" />
              <p className="text-sm font-bold text-[var(--dim)]">{t.noResults}</p>
            </div>
          ) : (
            <div className={GRID}>
              {results.map((song) => (
                <SongCard key={song.id} song={song} />
              ))}
            </div>
          )}
        </section>
      ) : (
        /* ---------------- idle landing ---------------- */
        <div className="pb-14">
          {favorites.length > 0 && (
            <section>
              <SectionHead icon={<Heart size={13} aria-hidden />} label={t.favorites} />
              <div className={GRID}>
                {favorites.map((song) => (
                  <SongCard key={song.id} song={song} />
                ))}
              </div>
            </section>
          )}

          {recent.length > 0 && (
            <section>
              <SectionHead icon={<Clock size={13} aria-hidden />} label={t.recentSearches} />
              <div className="flex flex-wrap gap-2">
                {recent.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => applyTerm(r)}
                    className="flex min-h-[40px] items-center gap-1.5 rounded-full border border-[var(--line2)] bg-[var(--panel2)] px-2.5 py-1 text-[11px] font-medium text-[var(--dim)] transition-colors hover:border-[var(--a)] hover:text-[var(--a)]"
                  >
                    <Search size={11} aria-hidden className="shrink-0" />
                    {r}
                  </button>
                ))}
              </div>
            </section>
          )}

          {hot.length > 0 && (
            <section>
              <SectionHead icon={<Flame size={13} aria-hidden />} label={t.hotInApp} />
              <div className={GRID}>
                {hot.map((song) => (
                  <SongCard key={song.id} song={song} />
                ))}
              </div>
            </section>
          )}

          {trending.length > 0 && (
            <section>
              <SectionHead icon={<TrendingUp size={13} aria-hidden />} label={t.trending} />
              <div className={GRID}>
                {trending.map((song) => (
                  <SongCard key={song.id} song={song} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
