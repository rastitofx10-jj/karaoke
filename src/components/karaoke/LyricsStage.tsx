'use client';

/* TITO KARAOKE STUDIO v1.0 — the lyrics stage.
 * Word-level fill for enhanced LRC, sweep fill for plain lines,
 * per-line RTL/LTR, countdown dots before the next line.
 */

import { useMemo } from 'react';
import { useKaraoke } from '@/store/karaoke';
import { getEngine } from '@/hooks/use-engine';
import { DICTS } from '@/lib/karaoke/i18n';
import { activeLineIndex, lineProgress, detectDir } from '@/lib/karaoke/lrc';
import type { LrcLine } from '@/lib/karaoke/types';
import { cn } from '@/lib/utils';

function lineFontSize(text: string, big: boolean): string {
  const len = text.length;
  const base = big
    ? 'clamp(28px, min(7vw, 9vh), 64px)'
    : 'clamp(20px, min(4.2vw, 5.4vh), 40px)';
  if (len > 90) return big ? 'clamp(22px, min(5vw, 6.4vh), 44px)' : 'clamp(17px, min(3vw, 4vh), 28px)';
  if (len > 55) return big ? 'clamp(25px, min(6vw, 7.6vh), 54px)' : 'clamp(18px, min(3.4vw, 4.6vh), 32px)';
  return base;
}

function LineFill({ line, progress, big = false }: { line: LrcLine; progress: number; big?: boolean }) {
  const dir = detectDir(line.text);
  // enhanced word timing → per-word fill
  if (line.words && line.words.length > 0) {
    const n = line.words.length;
    return (
      <div dir={dir} className="stage-line text-center" style={{ fontSize: lineFontSize(line.text, big) }}>
        {line.words.map((w, i) => {
          const start = i / n;
          const end = (i + 1) / n;
          const wp = Math.min(1, Math.max(0, (progress - start) / (end - start)));
          return (
            <span key={i} className="relative mx-[0.14em] inline-block">
              <span className="fill-base">{w.text}</span>
              <span
                aria-hidden
                className="fill-sung absolute inset-0 whitespace-nowrap"
                style={{ clipPath: dir === 'rtl' ? `inset(0 0 0 ${100 - wp * 100}%)` : `inset(0 ${100 - wp * 100}% 0 0)` }}
              >
                {w.text}
              </span>
            </span>
          );
        })}
      </div>
    );
  }
  // sweep fill
  const clip = dir === 'rtl' ? `inset(0 0 0 ${100 - progress * 100}%)` : `inset(0 ${100 - progress * 100}% 0 0)`;
  return (
    <div dir={dir} className="relative text-center" style={{ fontSize: lineFontSize(line.text, big) }}>
      <span className="stage-line fill-base">{line.text}</span>
      <span aria-hidden className="stage-line fill-sung glow-a absolute inset-0" style={{ clipPath: clip }}>
        {line.text}
      </span>
    </div>
  );
}

export function LyricsStage({ big = false }: { big?: boolean }) {
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const pos = useKaraoke((s) => s.pos);
  const duration = useKaraoke((s) => s.duration);
  const song = useKaraoke((s) => s.song);
  const songLevel = useKaraoke((s) => s.songLevel);

  const lines = useMemo(() => getEngine().song?.lyrics ?? [], [song, duration]);
  const idx = lines.length ? activeLineIndex(lines, pos) : -1;
  const lastLine = lines.length ? lines[lines.length - 1] : null;
  const songOver = Boolean(
    lastLine && lastLine.end !== undefined && pos >= lastLine.end - 0.05,
  );
  const cur = songOver ? lastLine : idx >= 0 ? lines[idx] : null;
  const next = !songOver && idx >= 0 && idx + 1 < lines.length ? lines[idx + 1] : null;
  const nextNext = !songOver && idx >= 0 && idx + 2 < lines.length ? lines[idx + 2] : null;
  const firstUpcoming = !songOver && idx < 0 && lines.length ? lines[0] : null;

  const progress = songOver
    ? 1
    : cur && cur.end !== undefined
      ? lineProgress(cur, pos)
      : cur
        ? Math.min(1, Math.max(0, (pos - cur.time) / 3))
        : 0;

  // countdown: seconds until the next (or first) line
  const upcoming = next ?? firstUpcoming;
  const untilNext = upcoming ? Math.max(0, upcoming.time - pos) : null;

  if (!song) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="text-lg font-bold text-[var(--dim)]">{t.dropHere}</div>
        <div className="text-xs text-[var(--faint)]">{t.orPick} · {t.loadFile}</div>
      </div>
    );
  }
  if (!lines.length) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="text-lg font-bold text-[var(--dim)]">{t.noLyrics}</div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'relative flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-4 py-6',
        big && 'gap-10 py-10',
      )}
      aria-live="polite"
    >
      {/* dim current-previous line for context */}
      {cur && idx > 0 && (
        <div
          dir={detectDir(lines[idx - 1].text)}
          className="stage-line max-w-full truncate text-center text-[var(--line2)] opacity-60"
          style={{ fontSize: 'clamp(13px, 1.6vw, 18px)' }}
        >
          {lines[idx - 1].text}
        </div>
      )}

      {/* the active line */}
      {cur ? (
        <div key={idx} className="line-in w-full">
          <LineFill line={cur} progress={progress} big={big} />
          {cur.sub && (
            <div
              dir={detectDir(cur.sub)}
              className="mt-2 text-center text-[var(--dim)]"
              style={{ fontSize: 'clamp(13px, 1.8vw, 20px)' }}
            >
              {cur.sub}
            </div>
          )}
        </div>
      ) : (
        /* before first line — pulse countdown */
        <div className="flex flex-col items-center gap-4">
          <div
            className="stage-line text-center text-[var(--faint)]"
            style={{ fontSize: 'clamp(22px, 4vw, 44px)' }}
          >
            {song.title}
          </div>
          {untilNext !== null && untilNext < 6 && (
            <div className="flex gap-2" dir="ltr" aria-hidden>
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="h-2.5 w-2.5 rounded-full"
                  style={{
                    background: untilNext < 3 - i ? 'var(--a)' : 'var(--line2)',
                    boxShadow: untilNext < 3 - i ? '0 0 12px var(--a)' : undefined,
                    transition: 'background .2s',
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* upcoming lines */}
      <div className="flex w-full flex-col items-center gap-2">
        {upcoming && untilNext !== null && untilNext < 4 && (
          <div
            dir={detectDir(upcoming.text)}
            className={cn(
              'stage-line max-w-full text-center',
              untilNext < 2 ? 'text-[var(--dim)]' : 'text-[var(--faint)] opacity-70',
            )}
            style={{ fontSize: 'clamp(15px, 2.2vw, 26px)' }}
          >
            {upcoming.text}
          </div>
        )}
        {nextNext && (
          <div
            dir={detectDir(nextNext.text)}
            className="stage-line max-w-full truncate text-center text-[var(--faint)] opacity-50"
            style={{ fontSize: 'clamp(12px, 1.7vw, 20px)' }}
          >
            {nextNext.text}
          </div>
        )}
      </div>

      {/* subtle level bar under the stage */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5"
        aria-hidden
      >
        <div
          className="h-full"
          style={{
            width: `${Math.min(100, songLevel * 100)}%`,
            background: 'linear-gradient(to left, var(--a), var(--b))',
            opacity: 0.5,
            marginInline: 'auto',
          }}
        />
      </div>
    </div>
  );
}
