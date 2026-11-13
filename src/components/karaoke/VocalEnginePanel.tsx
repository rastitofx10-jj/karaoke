'use client';

import { AudioWaveform, Minus, Music2, Plus, ScanSearch, Zap } from 'lucide-react';
import { useKaraoke } from '@/store/karaoke';
import { useKaraokeEngine } from '@/hooks/use-engine';
import { DICTS } from '@/lib/karaoke/i18n';
import { Panel, Fader, Chip } from './controls';
import type { VocalMode } from '@/lib/karaoke/types';

export function VocalEnginePanel() {
  const actions = useKaraokeEngine();
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const mode = useKaraoke((s) => s.mode);
  const amount = useKaraoke((s) => s.amount);
  const key = useKaraoke((s) => s.keySemitones);
  const speed = useKaraoke((s) => s.speed);
  const preserve = useKaraoke((s) => s.preservePitch);
  const volume = useKaraoke((s) => s.songVolume);
  const song = useKaraoke((s) => s.song);

  const modes: Array<{ id: VocalMode; label: string }> = [
    { id: 'off', label: t.modeOff },
    { id: 'karaoke', label: t.modeKaraoke },
    { id: 'isolate', label: t.modeIsolate },
  ];

  return (
    <Panel title={t.vocalEngine} icon={<AudioWaveform />}>
      <div className="flex flex-col gap-3 p-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t.vocalEngine}>
          {modes.map((m) => (
            <Chip
              key={m.id}
              active={mode === m.id}
              accent={m.id === 'karaoke' ? 'a' : m.id === 'isolate' ? 'b' : 'good'}
              onClick={() => actions.setMode(m.id)}
            >
              {m.label}
            </Chip>
          ))}
        </div>
        <Fader
          label={t.amount}
          value={amount}
          min={0}
          max={1}
          onChange={(v) => actions.setAmount(v)}
          format={(v) => `${Math.round(v * 100)}%`}
          disabled={mode === 'off'}
        />

        {/* key */}
        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-[10px] font-semibold tracking-wider text-[var(--dim)] uppercase">
              {t.key} · <Music2 size={10} className="inline" />
            </span>
            <span className="kv" style={{ color: 'var(--a)' }} dir="ltr">
              {key > 0 ? `+${key}` : key} {t.keySemitones}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => actions.setKey(key - 1)}
              disabled={key <= -12}
              className="flex h-9 w-9 items-center justify-center rounded border border-[var(--line2)] bg-[var(--panel2)] text-[var(--dim)] transition-colors hover:text-[var(--a)] disabled:opacity-30"
              aria-label="-1"
            >
              <Minus size={14} />
            </button>
            <input
              type="range"
              className="fader flex-1"
              min={-12}
              max={12}
              step={1}
              value={key}
              onChange={(e) => actions.setKey(Number(e.target.value))}
              style={{ ['--pct' as string]: `${((key + 12) / 24) * 100}%` }}
              aria-label={t.key}
            />
            <button
              type="button"
              onClick={() => actions.setKey(key + 1)}
              disabled={key >= 12}
              className="flex h-9 w-9 items-center justify-center rounded border border-[var(--line2)] bg-[var(--panel2)] text-[var(--dim)] transition-colors hover:text-[var(--a)] disabled:opacity-30"
              aria-label="+1"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        {/* speed */}
        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-[10px] font-semibold tracking-wider text-[var(--dim)] uppercase">{t.speed}</span>
            <span className="kv" style={{ color: 'var(--b)' }} dir="ltr">
              {speed.toFixed(2)}×
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              className="fader flex-1"
              min={0.5}
              max={1.5}
              step={0.01}
              value={speed}
              onChange={(e) => actions.setSpeed(Number(e.target.value), preserve)}
              style={{ ['--pct' as string]: `${((speed - 0.5) / 1) * 100}%`, accentColor: 'var(--b)' }}
              aria-label={t.speed}
            />
            <Chip active={preserve} onClick={() => actions.setSpeed(speed, !preserve)} accent="b">
              <Zap size={11} className="me-1 inline" />
              {t.preservePitch}
            </Chip>
          </div>
        </div>

        <Fader
          label={t.volume}
          value={volume}
          min={0}
          max={1.4}
          onChange={(v) => actions.setSongVolume(v)}
          format={(v) => `${Math.round(v * 100)}%`}
        />
        {!song && <p className="text-[11px] text-[var(--faint)]">{t.noSong}</p>}
      </div>
    </Panel>
  );
}

export function MelodyScanPanel() {
  const actions = useKaraokeEngine();
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const scanning = useKaraoke((s) => s.scanning);
  const progress = useKaraoke((s) => s.scanProgress);
  const song = useKaraoke((s) => s.song);

  return (
    <Panel title={t.melodyScan} icon={<ScanSearch />}>
      <div className="flex flex-col gap-2.5 p-3">
        <p className="text-[11px] leading-relaxed text-[var(--faint)]">{t.melodyHint}</p>
        {scanning ? (
          <div className="flex flex-col gap-2">
            <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--well)]">
              <div
                className="h-full rounded-full transition-[width] duration-200"
                style={{ width: `${Math.round(progress * 100)}%`, background: 'linear-gradient(to left, var(--a), var(--b))' }}
              />
            </div>
            <span className="kv text-[var(--a)]">
              {t.scanning} {Math.round(progress * 100)}%
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void actions.scanMelody()}
              disabled={!song}
              className="flex min-h-[38px] flex-1 items-center justify-center gap-2 rounded border border-[color-mix(in_srgb,var(--a)_55%,transparent)] bg-[color-mix(in_srgb,var(--a)_12%,transparent)] px-3 text-xs font-bold text-[var(--a)] transition-colors hover:bg-[color-mix(in_srgb,var(--a)_22%,transparent)] disabled:opacity-40"
            >
              <ScanSearch size={14} />
              {t.scan}
            </button>
            {song?.hasMelody && (
              <span className="kv px-1 text-[var(--good)]" title={t.hasMelody}>
                ✓ {t.hasMelody}
              </span>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
