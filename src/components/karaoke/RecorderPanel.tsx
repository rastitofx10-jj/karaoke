'use client';

import { useEffect, useRef, useState } from 'react';
import { Circle, Disc3, Download, Library, Play, Save, Search, Trash2, Upload, FileText } from 'lucide-react';
import { useKaraoke } from '@/store/karaoke';
import { useKaraokeEngine } from '@/hooks/use-engine';
import { DICTS } from '@/lib/karaoke/i18n';
import { formatTime } from '@/lib/karaoke/wav';
import { Panel, Chip } from './controls';
import { rankColor } from '@/store/karaoke';
import { cn } from '@/lib/utils';

export function RecorderPanel() {
  const actions = useKaraokeEngine();
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const recording = useKaraoke((s) => s.recording);
  const recSec = useKaraoke((s) => s.recSec);
  const micActive = useKaraoke((s) => s.micActive);
  const takes = useKaraoke((s) => s.takes);
  const song = useKaraoke((s) => s.song);

  useEffect(() => {
    if (song) void actions.refreshTakes(song.id);
     
  }, [song?.id]);

  return (
    <Panel title={t.recorder} icon={<Disc3 />}>
      <div className="flex flex-col gap-3 p-3">
        <button
          type="button"
          onClick={() => actions.toggleRecording()}
          disabled={!song}
          className={cn(
            'flex min-h-[44px] items-center justify-center gap-2.5 rounded border text-sm font-black tracking-wider uppercase transition-all disabled:opacity-40',
            recording
              ? 'border-[color-mix(in_srgb,var(--crit)_65%,transparent)] bg-[color-mix(in_srgb,var(--crit)_16%,transparent)] text-[var(--crit)]'
              : 'border-[color-mix(in_srgb,var(--crit)_45%,transparent)] bg-[var(--panel2)] text-[var(--dim)] hover:text-[var(--crit)]',
          )}
          aria-pressed={recording}
        >
          <Circle size={14} fill={recording ? 'currentColor' : 'none'} className={recording ? 'rec-dot' : ''} />
          {recording ? `${t.recording} ${formatTime(recSec)}` : t.rec}
        </button>
        {!micActive && (
          <p className="text-center text-[10px] text-[var(--faint)]">{t.mic}</p>
        )}

        {/* takes */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[9px] tracking-[0.14em] text-[var(--faint)] uppercase">
            {t.takes} {takes.length ? `(${takes.length})` : ''}
          </span>
          <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
            {takes.length === 0 && <span className="text-[11px] text-[var(--faint)]">{t.noTakes}</span>}
            {takes.map((tk) => (
              <div
                key={tk.id}
                className="flex items-center gap-2 rounded border border-[var(--line)] bg-[var(--well)] px-2 py-1.5"
              >
                <button
                  type="button"
                  onClick={() => void actions.playTake(tk.id)}
                  className="flex h-7 w-7 items-center justify-center rounded bg-[var(--panel2)] text-[var(--dim)] transition-colors hover:text-[var(--a)]"
                  title={t.playTake}
                >
                  <Play size={11} />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px] font-semibold text-[var(--text)]">{tk.songTitle}</div>
                  <div className="kv text-[9px] text-[var(--faint)]" dir="ltr">
                    {formatTime(tk.durationSec)} · {new Date(tk.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <span className="kv text-sm font-black" style={{ color: rankColor(tk.rank) }}>
                  {tk.score}
                </span>
                <button
                  type="button"
                  onClick={() => void actions.deleteTakeById(tk.id)}
                  className="flex h-7 w-7 items-center justify-center rounded text-[var(--faint)] transition-colors hover:text-[var(--crit)]"
                  title={t.delete}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}

export function LibraryPanel() {
  const actions = useKaraokeEngine();
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const songs = useKaraoke((s) => s.songs);
  const song = useKaraoke((s) => s.song);
  const [q, setQ] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const lrcRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void actions.refreshLibrary();
     
  }, []);

  const filtered = q
    ? songs.filter(
        (s) =>
          s.title.toLowerCase().includes(q.toLowerCase()) ||
          (s.artist ?? '').toLowerCase().includes(q.toLowerCase()),
      )
    : songs;

  return (
    <Panel
      title={t.library}
      icon={<Library />}
      className="min-h-[220px]"
      actions={
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => lrcRef.current?.click()}
            disabled={!song}
            className="flex items-center gap-1 rounded border border-[var(--line2)] bg-[var(--panel2)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--dim)] transition-colors hover:text-[var(--a)] disabled:opacity-30"
            title={t.loadLrc}
          >
            <FileText size={10} /> LRC
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1 rounded border border-[var(--line2)] bg-[var(--panel2)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--dim)] transition-colors hover:text-[var(--a)]"
          >
            <Upload size={10} /> {t.load}
          </button>
        </div>
      }
    >
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void actions.loadAudioFile(f);
          e.target.value = '';
        }}
      />
      <input
        ref={lrcRef}
        type="file"
        accept=".lrc,.srt,.txt,text/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            void f.text().then((raw) => actions.setLyricsRaw(raw, f.name));
          }
          e.target.value = '';
        }}
      />
      <div className="flex flex-col gap-2 p-3">
        <div className="relative">
          <Search size={12} className="absolute top-1/2 right-2.5 -translate-y-1/2 text-[var(--faint)]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t.searchSong}
            className="h-8 w-full rounded border border-[var(--line)] bg-[var(--well)] ps-3 pe-8 text-xs text-[var(--text)] placeholder:text-[var(--faint)] focus:border-[var(--a)] focus:outline-none"
          />
        </div>
        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto lg:max-h-[420px]">
          {filtered.length === 0 && (
            <span className="px-1 py-2 text-[11px] text-[var(--faint)]">{t.emptyLibrary}</span>
          )}
          {filtered.map((s) => (
            <div
              key={s.id}
              className={cn(
                'group flex items-center gap-2 rounded border px-2 py-1.5 transition-colors',
                song?.id === s.id
                  ? 'border-[color-mix(in_srgb,var(--a)_45%,transparent)] bg-[var(--a-soft)]'
                  : 'border-[var(--line)] bg-[var(--well)] hover:border-[var(--line2)]',
              )}
            >
              <button
                type="button"
                onClick={() => void actions.loadFromLibrary(s.id)}
                className="min-w-0 flex-1 text-start"
              >
                <div className="truncate text-[12px] font-semibold text-[var(--text)]">{s.title}</div>
                <div className="kv text-[9px] text-[var(--faint)]" dir="ltr">
                  {formatTime(s.durationSec)}
                  {s.hasLrc ? ' · LRC' : ''}
                  {s.hasMelody ? ' · ★' : ''}
                  {` · ${(s.sizeBytes / 1048576).toFixed(1)}MB`}
                </div>
              </button>
              <button
                type="button"
                onClick={() => void actions.deleteSongFromLibrary(s.id)}
                className="flex h-7 w-7 items-center justify-center rounded text-[var(--faint)] opacity-0 transition-all group-hover:opacity-100 hover:text-[var(--crit)]"
                title={t.delete}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

/* ---------- results modal ---------- */

export function ResultsModal() {
  const actions = useKaraokeEngine();
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const open = useKaraoke((s) => s.resultsOpen);
  const lastTake = useKaraoke((s) => s.lastTake);
  if (!open || !lastTake) return null;
  const r = lastTake.score;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t.finalResult}
      onClick={() => useKaraoke.getState().patch({ resultsOpen: false })}
    >
      <div
        className="panel w-full max-w-md overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--panel2)' }}
      >
        <div className="panel-title justify-between">
          <span>{t.finalResult}</span>
          <button
            type="button"
            onClick={() => useKaraoke.getState().patch({ resultsOpen: false })}
            className="text-[var(--dim)] hover:text-[var(--text)]"
          >
            ✕
          </button>
        </div>
        <div className="flex flex-col items-center gap-4 p-6">
          <div className="text-7xl leading-none font-black glow-b" style={{ color: rankColor(r.rank) }}>
            {r.overall}
          </div>
          <div className="text-xl font-black" style={{ color: rankColor(r.rank) }}>
            {t.ranks[r.rank]}
          </div>
          <div className="grid w-full grid-cols-2 gap-2 text-center">
            {[
              [t.pitch, r.pitchScore],
              [t.timing, r.timingScore],
              [t.coverage, r.coverage],
            ].map(([k, v]) => (
              <div key={k as string} className="rounded border border-[var(--line)] bg-[var(--well)] p-2">
                <div className="text-[9px] tracking-wider text-[var(--faint)] uppercase">{k}</div>
                <div className="kv text-lg font-bold text-[var(--text)]">{v}</div>
              </div>
            ))}
            <div className="rounded border border-[var(--line)] bg-[var(--well)] p-2">
              <div className="text-[9px] tracking-wider text-[var(--faint)] uppercase">{t.avgCents}</div>
              <div className="kv text-lg font-bold text-[var(--text)]" dir="ltr">
                {r.avgCents}¢
              </div>
            </div>
          </div>
          <div className="kv text-[10px] text-[var(--faint)]">
            {t.notesHit}: {r.notesHit}/{r.notesTotal} · {formatTime(lastTake.durationSec)}
          </div>
          <div className="flex w-full gap-2">
            <button
              type="button"
              onClick={() => void actions.saveCurrentTake()}
              className="flex min-h-[40px] flex-1 items-center justify-center gap-2 rounded border border-[color-mix(in_srgb,var(--good)_50%,transparent)] bg-[color-mix(in_srgb,var(--good)_12%,transparent)] text-xs font-bold text-[var(--good)]"
            >
              <Save size={13} /> {t.saveTake}
            </button>
            <button
              type="button"
              onClick={() => actions.downloadTake()}
              className="flex min-h-[40px] items-center justify-center gap-2 rounded border border-[var(--line2)] bg-[var(--panel)] px-3 text-xs font-bold text-[var(--dim)] hover:text-[var(--text)]"
            >
              <Download size={13} /> WAV
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              useKaraoke.getState().patch({ resultsOpen: false });
              actions.seek(0);
              actions.play();
            }}
            className="text-[11px] font-bold text-[var(--a)] hover:underline"
          >
            {t.singAgain}
          </button>
        </div>
      </div>
    </div>
  );
}
