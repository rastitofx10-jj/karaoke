'use client';

import { Mic, MicOff, Headphones, AudioLines, Gauge, Waves } from 'lucide-react';
import { useKaraoke } from '@/store/karaoke';
import { useKaraokeEngine } from '@/hooks/use-engine';
import { DICTS } from '@/lib/karaoke/i18n';
import { midiToNoteName } from '@/lib/karaoke/pitch';
import { Panel, Fader, Chip, LevelMeter } from './controls';
import { cn } from '@/lib/utils';
import type { MicFx } from '@/lib/karaoke/types';

export function MicConsole() {
  const actions = useKaraokeEngine();
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const micActive = useKaraoke((s) => s.micActive);
  const fx = useKaraoke((s) => s.fx);
  const micLevel = useKaraoke((s) => s.micLevel);
  const micPitchMidi = useKaraoke((s) => s.micPitchMidi);
  const clarity = useKaraoke((s) => s.clarity);
  const targetMidi = useKaraoke((s) => s.targetMidi);
  const liveScore = useKaraoke((s) => s.liveScore);

  const set = (p: Partial<MicFx>) => actions.setFx(p);

  return (
    <Panel
      title={t.mic}
      icon={<Mic />}
      actions={
        <button
          type="button"
          onClick={() => void actions.toggleMic()}
          className={cn(
            'flex items-center gap-1.5 rounded border px-2 py-1 text-[10px] font-bold transition-colors',
            micActive
              ? 'border-[color-mix(in_srgb,var(--good)_55%,transparent)] bg-[color-mix(in_srgb,var(--good)_12%,transparent)] text-[var(--good)]'
              : 'border-[var(--line2)] bg-[var(--panel2)] text-[var(--dim)] hover:text-[var(--text)]',
          )}
        >
          {micActive ? <Mic size={11} /> : <MicOff size={11} />}
          {micActive ? t.on : t.enableMic}
        </button>
      }
    >
      <div className="flex flex-col gap-3 p-3">
        {/* live readout */}
        <div className="flex items-stretch gap-3 rounded border border-[var(--line)] bg-[var(--well)] p-2.5">
          <div className="flex min-w-[86px] flex-col items-center justify-center gap-0.5">
            <span className="text-[8px] tracking-[0.14em] text-[var(--faint)] uppercase">{t.yourPitch}</span>
            <span
              className={cn('text-xl leading-none font-black', micPitchMidi !== null ? 'text-[var(--b)] glow-b' : 'text-[var(--line2)]')}
              dir="ltr"
            >
              {micPitchMidi !== null ? midiToNoteName(micPitchMidi) : '—'}
            </span>
            <span className="kv text-[9px] text-[var(--faint)]" dir="ltr">
              {clarity > 0 ? `${Math.round(clarity * 100)}%` : ''}
            </span>
          </div>
          <div className="flex min-w-[86px] flex-col items-center justify-center gap-0.5">
            <span className="text-[8px] tracking-[0.14em] text-[var(--faint)] uppercase">{t.targetPitch}</span>
            <span
              className={cn('text-xl leading-none font-black', targetMidi !== null ? 'text-[var(--a)] glow-a' : 'text-[var(--line2)]')}
              dir="ltr"
            >
              {targetMidi !== null ? midiToNoteName(targetMidi) : '—'}
            </span>
            {liveScore && (
              <span className="kv text-[9px]" style={{ color: 'var(--good)' }} dir="ltr">
                {liveScore.overall}
              </span>
            )}
          </div>
          <div className="flex flex-1 flex-col justify-center gap-2">
            <LevelMeter level={micLevel} label="MIC" />
            <LevelMeter level={micLevel > 0.02 ? Math.min(1, micLevel * 1.6) : 0} label="GATE" />
          </div>
        </div>

        {/* presets */}
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(t.presets) as Array<keyof typeof t.presets>).map((p) => (
            <Chip key={p} onClick={() => actions.applyPreset(p)} accent="b">
              {t.presets[p]}
            </Chip>
          ))}
        </div>

        {/* fx faders */}
        <Fader
          label={t.reverb}
          value={fx.reverb}
          min={0}
          max={0.6}
          onChange={(v) => set({ reverb: v })}
          format={(v) => `${Math.round((v / 0.6) * 100)}% · ${fx.reverbPreset}`}
          accent="b"
          disabled={!micActive}
        />
        <div className="flex flex-wrap gap-1.5">
          {(['room', 'hall', 'stage', 'stadium'] as const).map((p) => (
            <Chip
              key={p}
              active={fx.reverbPreset === p}
              accent="b"
              disabled={!micActive}
              onClick={() => set({ reverbPreset: p })}
            >
              {p}
            </Chip>
          ))}
        </div>
        <Fader
          label={t.echo}
          value={fx.echo}
          min={0}
          max={0.8}
          onChange={(v) => set({ echo: v })}
          format={(v) => `${Math.round((v / 0.8) * 100)}%`}
          accent="b"
          disabled={!micActive}
        />
        {fx.echo > 0.01 && (
          <Fader
            label={t.echoTime}
            value={fx.echoTimeMs}
            min={80}
            max={600}
            step={5}
            onChange={(v) => set({ echoTimeMs: v })}
            format={(v) => `${Math.round(v)}ms`}
            accent="b"
            disabled={!micActive}
          />
        )}

        {/* EQ */}
        <div className="grid grid-cols-3 gap-2">
          <Fader label={t.low} value={fx.lowDb} min={-12} max={12} step={0.5} onChange={(v) => set({ lowDb: v })} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}dB`} disabled={!micActive} />
          <Fader label={t.mid} value={fx.midDb} min={-12} max={12} step={0.5} onChange={(v) => set({ midDb: v })} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}dB`} disabled={!micActive} />
          <Fader label={t.high} value={fx.highDb} min={-12} max={12} step={0.5} onChange={(v) => set({ highDb: v })} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}dB`} disabled={!micActive} />
        </div>

        {/* gate + comp + gain + monitor */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip active={fx.gate} onClick={() => set({ gate: !fx.gate })} accent="good" disabled={!micActive}>
            <Gauge size={11} className="me-1 inline" />
            {t.gate}
          </Chip>
          <Chip active={fx.compressor} onClick={() => set({ compressor: !fx.compressor })} accent="good" disabled={!micActive}>
            <AudioLines size={11} className="me-1 inline" />
            {t.comp}
          </Chip>
          <Chip
            active={fx.monitor}
            onClick={() => set({ monitor: !fx.monitor })}
            accent="crit"
            disabled={!micActive}
            title={t.monitorHint}
          >
            <Headphones size={11} className="me-1 inline" />
            {t.monitor}
          </Chip>
        </div>
        {fx.gate && (
          <Fader
            label={t.gateThr}
            value={fx.gateThresholdDb}
            min={-70}
            max={-25}
            step={1}
            onChange={(v) => set({ gateThresholdDb: v })}
            format={(v) => `${v.toFixed(0)}dB`}
            accent="b"
            disabled={!micActive}
          />
        )}
        <Fader
          label={t.micGain}
          value={fx.micGainDb}
          min={-12}
          max={18}
          step={0.5}
          onChange={(v) => set({ micGainDb: v })}
          format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}dB`}
          disabled={!micActive}
        />
        {!micActive && (
          <p className="flex items-center gap-1.5 text-[11px] text-[var(--faint)]">
            <Waves size={12} /> {t.enableMic}
          </p>
        )}
      </div>
    </Panel>
  );
}
