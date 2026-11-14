'use client';

/* TITO KARAOKE STUDIO v4.0 — lyrics editor with tap-to-sync.
 * Paste plain text → play → tap SPACE (or the big pad) on every line.
 * Nudge, apply, export standard LRC.
 * v4.0 — FORMAT AUTODETECT: a pasted LRC or SRC keeps its timestamps —
 * the editor used to flatten a ready-made LRC into plain text and make
 * the user re-tap what was already timed. Now a pasted LRC lands on the
 * sync tab fully timed (tap-to-sync remains for genuinely plain text).
 */

import { useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, Download, FileText, Play, RotateCcw, Save } from 'lucide-react';
import { useKaraoke } from '@/store/karaoke';
import { useKaraokeEngine, getEngine } from '@/hooks/use-engine';
import { DICTS } from '@/lib/karaoke/i18n';
import { parseLrc, serializeLrc } from '@/lib/karaoke/lrc';
import { formatTime } from '@/lib/karaoke/wav';
import { cn } from '@/lib/utils';

interface EditLine {
  text: string;
  time: number | null;
}

export function LyricsEditor({ open, onClose }: { open: boolean; onClose: () => void }) {
  const actions = useKaraokeEngine();
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const song = useKaraoke((s) => s.song);
  const playing = useKaraoke((s) => s.playing);

  /* seeded once per mount (the parent mounts this dialog fresh every open) */
  const [tab, setTab] = useState<'text' | 'sync'>(() =>
    getEngine().song?.lyrics.length ? 'sync' : 'text',
  );
  const [raw, setRaw] = useState(() => getEngine().song?.lrcRaw ?? '');
  const [lines, setLines] = useState<EditLine[]>(() => {
    const lyrics = getEngine().song?.lyrics ?? [];
    return lyrics
      .filter((l) => l.text.trim() || l.time >= 0)
      .map((l) => ({ text: l.text, time: l.time >= 0 ? l.time : null }));
  });
  const [cursor, setCursor] = useState(0);
  const syncingRef = useRef(false);

  const parseText = () => {
    /* v4.0 — autodetect: a pasted LRC/SRT carries real timestamps — keep
     * them and land straight on the timed sync tab; only genuinely plain
     * text starts from untimed lines. (parseLrc is total: malformed
     * input degrades to plain lines, never throws.) */
    const parsed = parseLrc(raw);
    const timed = parsed.lines.filter((l) => l.text.trim() && l.time >= 0);
    if (timed.length >= 3) {
      setLines(parsed.lines.map((l) => ({ text: l.text, time: l.time >= 0 ? l.time : null })));
      setCursor(timed.length);
      setTab('sync');
      return;
    }
    const ls = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((text) => ({ text, time: null as number | null }));
    setLines(ls);
    setCursor(0);
    setTab('sync');
  };

  const stamp = () => {
    const e = getEngine();
    if (!e.song) return;
    if (!e.playing) {
      void e.play();
      return;
    }
    if (cursor >= lines.length) return;
    const time = e.pos;
    setLines((prev) => prev.map((l, i) => (i === cursor ? { ...l, time } : l)));
    setCursor((c) => Math.min(lines.length, c + 1));
  };

  /* space to stamp while syncing */
  useEffect(() => {
    if (!open || tab !== 'sync') return;
    const h = (e: KeyboardEvent) => {
      if (e.code === 'Space' && (e.target as HTMLElement)?.tagName !== 'TEXTAREA' && (e.target as HTMLElement)?.tagName !== 'INPUT') {
        e.preventDefault();
        stamp();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
     
  }, [open, tab, cursor, lines.length, playing]);

  if (!open) return null;

  const nudge = (i: number, dt: number) => {
    setLines((prev) =>
      prev.map((l, j) => (j === i && l.time !== null ? { ...l, time: Math.max(0, l.time + dt) } : l)),
    );
  };

  const buildLrc = () =>
    serializeLrc({
      title: song?.title,
      artist: song?.artist,
      lines: lines
        .filter((l) => l.time !== null)
        .map((l) => ({ time: l.time as number, text: l.text })),
    });

  const apply = () => {
    actions.setLyricsRaw(buildLrc());
    onClose();
  };

  const exportLrc = () => {
    const blob = new Blob([buildLrc()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(song?.title ?? 'lyrics').replace(/[^\w\u0590-\u05FF -]/g, '')}.lrc`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t.editor}
      onClick={onClose}
    >
      <div
        className="panel flex h-full max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden"
        style={{ background: 'var(--panel2)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-title justify-between">
          <span className="flex items-center gap-2">
            <FileText />
            {t.editor} — {song?.title ?? ''}
          </span>
          <button type="button" onClick={onClose} className="text-[var(--dim)] hover:text-[var(--text)]">
            ✕
          </button>
        </div>

        {/* tabs */}
        <div className="flex gap-1 border-b border-[var(--line)] p-2">
          {(['text', 'sync'] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                'rounded px-3 py-1.5 text-[11px] font-bold transition-colors',
                tab === id ? 'bg-[var(--a-soft)] text-[var(--a)]' : 'text-[var(--dim)] hover:text-[var(--text)]',
              )}
            >
              {id === 'text' ? t.loadLrc : t.synced}
            </button>
          ))}
        </div>

        {tab === 'text' ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={t.editorHint}
              className="min-h-0 flex-1 resize-none rounded border border-[var(--line)] bg-[var(--well)] p-3 font-mono text-[12px] leading-relaxed text-[var(--text)] focus:border-[var(--a)] focus:outline-none"
              dir="auto"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-[var(--faint)]">{t.editorHint}</span>
              <button
                type="button"
                onClick={parseText}
                disabled={!raw.trim()}
                className="flex min-h-[38px] items-center gap-2 rounded border border-[color-mix(in_srgb,var(--a)_55%,transparent)] bg-[color-mix(in_srgb,var(--a)_12%,transparent)] px-4 text-xs font-bold text-[var(--a)] disabled:opacity-40"
              >
                <ArrowLeftRight size={13} />
                {t.startSync}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
            {/* the tap pad */}
            <button
              type="button"
              onClick={stamp}
              className="flex min-h-[64px] w-full items-center justify-center gap-3 rounded border border-[color-mix(in_srgb,var(--b)_50%,transparent)] bg-[color-mix(in_srgb,var(--b)_10%,transparent)] text-sm font-black tracking-widest text-[var(--b)] uppercase transition-all active:scale-[0.99]"
            >
              {playing ? <Play size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" className="-scale-x-100" />}
              {playing ? t.tapHere : t.play}
            </button>

            {/* lines */}
            <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pe-1">
              {lines.map((l, i) => (
                <div
                  key={i}
                  className={cn(
                    'flex items-center gap-2 rounded border px-2 py-1.5',
                    i === cursor
                      ? 'border-[color-mix(in_srgb,var(--a)_55%,transparent)] bg-[var(--a-soft)]'
                      : 'border-[var(--line)] bg-[var(--well)]',
                  )}
                >
                  <span className="kv w-14 shrink-0 text-[10px]" style={{ color: l.time !== null ? 'var(--a)' : 'var(--faint)' }} dir="ltr">
                    {l.time !== null ? formatTime(l.time) : '--:--'}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text)]" dir="auto">
                    {l.text}
                  </span>
                  <div className="flex shrink-0 gap-0.5">
                    <button
                      type="button"
                      onClick={() => nudge(i, -0.3)}
                      className="h-6 w-6 rounded text-[10px] text-[var(--faint)] hover:text-[var(--a)]"
                      title={t.nudgeBack}
                      dir="ltr"
                    >
                      -0.3
                    </button>
                    <button
                      type="button"
                      onClick={() => nudge(i, 0.3)}
                      className="h-6 w-6 rounded text-[10px] text-[var(--faint)] hover:text-[var(--a)]"
                      title={t.nudgeFwd}
                      dir="ltr"
                    >
                      +0.3
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCursor(i);
                        const e = getEngine();
                        if (l.time !== null) actions.seek(l.time);
                      }}
                      className="h-6 w-6 rounded text-[10px] text-[var(--faint)] hover:text-[var(--b)]"
                      title={t.load}
                    >
                      ↻
                    </button>
                  </div>
                </div>
              ))}
              {lines.length === 0 && (
                <span className="p-3 text-center text-[11px] text-[var(--faint)]">{t.editorHint}</span>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] pt-2">
              <button
                type="button"
                onClick={() => {
                  setCursor(0);
                  setLines((prev) => prev.map((l) => ({ ...l, time: null })));
                }}
                className="flex min-h-[34px] items-center gap-1.5 rounded border border-[var(--line2)] bg-[var(--panel)] px-3 text-[11px] font-bold text-[var(--dim)] hover:text-[var(--text)]"
              >
                <RotateCcw size={12} />
                {t.startSync}
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={exportLrc}
                  disabled={!lines.some((l) => l.time !== null)}
                  className="flex min-h-[34px] items-center gap-1.5 rounded border border-[var(--line2)] bg-[var(--panel)] px-3 text-[11px] font-bold text-[var(--dim)] hover:text-[var(--text)] disabled:opacity-40"
                >
                  <Download size={12} />
                  {t.exportLrc}
                </button>
                <button
                  type="button"
                  onClick={apply}
                  disabled={!lines.some((l) => l.time !== null)}
                  className="flex min-h-[34px] items-center gap-1.5 rounded border border-[color-mix(in_srgb,var(--good)_50%,transparent)] bg-[color-mix(in_srgb,var(--good)_12%,transparent)] px-3 text-[11px] font-bold text-[var(--good)] disabled:opacity-40"
                >
                  <Save size={12} />
                  {t.applySync}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
