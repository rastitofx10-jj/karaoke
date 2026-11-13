'use client';

import { useEffect, useState } from 'react';
import { Mic2, Languages, Maximize, Minimize, Power, Radio, Theater } from 'lucide-react';
import { useKaraoke } from '@/store/karaoke';
import { useKaraokeEngine, getEngine } from '@/hooks/use-engine';
import { DICTS } from '@/lib/karaoke/i18n';
import { cn } from '@/lib/utils';
import { Stat } from './controls';

export function TopBar() {
  const actions = useKaraokeEngine();
  const lang = useKaraoke((s) => s.lang);
  const powered = useKaraoke((s) => s.powered);
  const micActive = useKaraoke((s) => s.micActive);
  const recording = useKaraoke((s) => s.recording);
  const song = useKaraoke((s) => s.song);
  const t = DICTS[lang];
  const [full, setFull] = useState(false);

  useEffect(() => {
    const h = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  };

  const sr = powered ? getEngine().ctx?.sampleRate ?? 0 : 0;
  const lat = powered ? getEngine().micLatencySec() * 1000 : 0;

  return (
    <header
      className="sticky top-0 z-30 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-[var(--line)] bg-[var(--ink)] px-4 py-2"
      style={{ paddingTop: 'max(8px, env(safe-area-inset-top))' }}
    >
      {/* brand */}
      <div className="flex items-baseline gap-3">
        <h1
          className="text-2xl leading-none font-black tracking-wide"
          style={{ color: 'var(--a)' }}
        >
          {t.brand}
        </h1>
        <span className="kv text-[10px] tracking-[0.14em] text-[var(--faint)] uppercase">
          {t.version}
        </span>
      </div>

      {/* power */}
      <button
        type="button"
        onClick={() => (powered ? void actions.powerOff() : void actions.powerOn())}
        className={cn(
          'flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold tracking-wider uppercase transition-all',
          powered
            ? 'border-[color-mix(in_srgb,var(--good)_60%,transparent)] bg-[color-mix(in_srgb,var(--good)_12%,transparent)] text-[var(--good)]'
            : 'border-[var(--line2)] bg-[var(--panel2)] text-[var(--dim)] hover:text-[var(--text)]',
        )}
        aria-pressed={powered}
      >
        <Power size={13} strokeWidth={2.5} />
        {powered ? t.on : t.power}
      </button>

      {/* now playing */}
      <div className="hidden min-w-0 items-center gap-2 md:flex">
        <Radio
          size={13}
          className={cn('shrink-0', recording ? 'rec-dot' : '', song ? 'text-[var(--b)]' : 'text-[var(--faint)]')}
        />
        <span className="max-w-[220px] truncate text-xs font-semibold text-[var(--text)]">
          {song ? song.title : t.noSong}
        </span>
        {song?.artist && (
          <span className="max-w-[140px] truncate text-[11px] text-[var(--dim)]">— {song.artist}</span>
        )}
      </div>

      {/* telemetry */}
      <div className="ms-auto hidden items-center gap-5 lg:flex">
        <Stat k={t.telemetry.sr} v={sr ? `${(sr / 1000).toFixed(1)}k` : '—'} />
        <Stat k={t.telemetry.latency} v={lat ? `${lat.toFixed(0)}ms` : '—'} />
        <Stat k={t.mic} v={micActive ? t.on : t.off} color={micActive ? 'var(--good)' : 'var(--faint)'} />
      </div>

      {/* actions */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => actions.toggleLang()}
          className="flex h-8 min-w-8 items-center justify-center gap-1.5 rounded border border-[var(--line2)] bg-[var(--panel2)] px-2 text-[11px] font-bold text-[var(--dim)] transition-colors hover:text-[var(--text)]"
          title="Language / שפה"
        >
          <Languages size={13} />
          {t.lang}
        </button>
        <button
          type="button"
          onClick={toggleFullscreen}
          className="flex h-8 w-8 items-center justify-center rounded border border-[var(--line2)] bg-[var(--panel2)] text-[var(--dim)] transition-colors hover:text-[var(--text)]"
          title={full ? t.exitFullscreen : t.fullscreen}
          aria-label={full ? t.exitFullscreen : t.fullscreen}
        >
          {full ? <Minimize size={13} /> : <Maximize size={13} />}
        </button>
        <button
          type="button"
          onClick={() => useKaraoke.getState().patch({ stageMode: !useKaraoke.getState().stageMode })}
          className={cn(
            'flex h-8 items-center justify-center gap-1.5 rounded border px-2.5 text-[11px] font-bold transition-colors',
            useKaraoke.getState().stageMode
              ? 'border-[color-mix(in_srgb,var(--b)_60%,transparent)] bg-[color-mix(in_srgb,var(--b)_14%,transparent)] text-[var(--b)]'
              : 'border-[var(--line2)] bg-[var(--panel2)] text-[var(--dim)] hover:text-[var(--text)]',
          )}
          title={t.stageMode}
        >
          <Theater size={13} />
          <span className="hidden sm:inline">{t.stageMode}</span>
        </button>
      </div>
    </header>
  );
}
