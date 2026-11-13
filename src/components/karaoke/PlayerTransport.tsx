'use client';

import { useCallback, useEffect, useRef } from 'react';
import { Pause, Play, Repeat, Square, Upload, Flag, XCircle } from 'lucide-react';
import { useKaraoke } from '@/store/karaoke';
import { useKaraokeEngine } from '@/hooks/use-engine';
import { DICTS } from '@/lib/karaoke/i18n';
import { formatTime } from '@/lib/karaoke/wav';
import { cn } from '@/lib/utils';

/** Waveform seek bar: peaks + position + loop region + drag seeking. */
export function WaveformSeek({ height = 56 }: { height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const pos = useKaraoke((s) => s.pos);
  const duration = useKaraoke((s) => s.duration);
  const loopA = useKaraoke((s) => s.loopA);
  const loopB = useKaraoke((s) => s.loopB);
  const actions = useKaraokeEngine();

  const timeAtEvent = useCallback(
    (e: React.PointerEvent) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      // RTL: time flows right → left
      const frac = 1 - x / rect.width;
      return Math.max(0, Math.min(1, frac)) * duration;
    },
    [duration],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = wrap.clientWidth;
    const h = height;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const peaks = useKaraoke.getState().peaks;
    const dur = duration || 1;
    const playedFrac = duration ? Math.min(1, pos / dur) : 0;

    // loop region
    if (loopA !== null && loopB !== null) {
      const aX = w - (loopA / dur) * w;
      const bX = w - (loopB / dur) * w;
      ctx.fillStyle = 'rgba(242, 86, 143, 0.12)';
      ctx.fillRect(bX, 0, aX - bX, h);
      ctx.strokeStyle = 'rgba(242, 86, 143, 0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(aX, 0); ctx.lineTo(aX, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(bX, 0); ctx.lineTo(bX, h); ctx.stroke();
    }

    // peaks
    if (peaks && peaks.length) {
      const n = peaks.length;
      const mid = h / 2;
      for (let x = 0; x < w; x++) {
        const frac = 1 - x / w; // RTL: right = 0
        const idx = Math.min(n - 1, Math.floor(frac * n));
        const v = peaks[idx];
        const bar = Math.max(1, v * (h * 0.92));
        const played = frac <= playedFrac;
        ctx.fillStyle = played ? 'var(--a)' : '#2c333f';
        // canvas can't read CSS vars — resolve once
        ctx.fillStyle = played ? '#f5a83b' : '#2c333f';
        ctx.fillRect(x, mid - bar / 2, 1, bar);
      }
    } else {
      // no song — flat line
      ctx.fillStyle = '#222833';
      ctx.fillRect(0, height / 2 - 1, w, 2);
    }

    // playhead (RTL: right = time 0)
    if (duration) {
      const x = w - playedFrac * w;
      ctx.fillStyle = '#f2568f';
      ctx.fillRect(x - 1, 0, 2, h);
      ctx.fillStyle = 'rgba(242, 86, 143, 0.25)';
      ctx.fillRect(x - 4, 0, 8, 3);
      ctx.fillRect(x - 4, h - 3, 8, 3);
    }
  }, [pos, duration, loopA, loopB, height]);

  useEffect(() => {
    draw();
    const onResize = () => draw();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [draw]);

  return (
    <div
      ref={wrapRef}
      className="relative w-full cursor-pointer touch-none rounded-md bg-[var(--well)]"
      onPointerDown={(e) => {
        draggingRef.current = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        actions.seek(timeAtEvent(e));
      }}
      onPointerMove={(e) => {
        if (draggingRef.current) actions.seek(timeAtEvent(e));
      }}
      onPointerUp={() => {
        draggingRef.current = false;
      }}
      role="slider"
      aria-label="seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(pos)}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') actions.seek(Math.max(0, pos - 5));
        if (e.key === 'ArrowLeft') actions.seek(Math.min(duration, pos + 5));
      }}
    >
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}

export function PlayerTransport() {
  const actions = useKaraokeEngine();
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const playing = useKaraoke((s) => s.playing);
  const pos = useKaraoke((s) => s.pos);
  const duration = useKaraoke((s) => s.duration);
  const song = useKaraoke((s) => s.song);
  const loading = useKaraoke((s) => s.loadingFile);
  const loopA = useKaraoke((s) => s.loopA);
  const loopB = useKaraoke((s) => s.loopB);
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2.5">
        {/* play / pause */}
        <button
          type="button"
          onClick={() => actions.toggle()}
          disabled={!song}
          className={cn(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-full border transition-all',
            song
              ? 'border-[color-mix(in_srgb,var(--a)_65%,transparent)] bg-[color-mix(in_srgb,var(--a)_16%,transparent)] text-[var(--a)] hover:bg-[color-mix(in_srgb,var(--a)_26%,transparent)]'
              : 'cursor-not-allowed border-[var(--line2)] text-[var(--faint)]',
          )}
          aria-label={playing ? t.pause : t.play}
        >
          {playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" className="-scale-x-100" />}
        </button>

        {/* stop */}
        <button
          type="button"
          onClick={() => {
            actions.pause();
            actions.seek(0);
          }}
          disabled={!song}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-[var(--line2)] bg-[var(--panel2)] text-[var(--dim)] transition-colors hover:text-[var(--text)] disabled:opacity-40"
          aria-label={t.stop}
        >
          <Square size={12} fill="currentColor" />
        </button>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-xs font-bold text-[var(--text)]">
              {loading ? t.loading : song ? song.title : t.noSong}
            </span>
            <span className="kv shrink-0 text-[var(--dim)]" dir="ltr">
              {formatTime(pos)} / {formatTime(duration)}
            </span>
          </div>
          <WaveformSeek />
        </div>

        {/* A-B loop */}
        <div className="flex shrink-0 flex-col gap-1">
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => actions.setLoopA()}
              disabled={!song}
              title={t.loopA}
              className={cn(
                'flex h-8 items-center gap-1 rounded border px-2 text-[10px] font-bold transition-colors disabled:opacity-40',
                loopA !== null
                  ? 'border-[color-mix(in_srgb,var(--b)_60%,transparent)] bg-[color-mix(in_srgb,var(--b)_14%,transparent)] text-[var(--b)]'
                  : 'border-[var(--line2)] bg-[var(--panel2)] text-[var(--dim)] hover:text-[var(--text)]',
              )}
            >
              <Flag size={13} /> A
            </button>
            <button
              type="button"
              onClick={() => actions.setLoopB()}
              disabled={!song}
              title={t.loopB}
              className={cn(
                'flex h-8 items-center gap-1 rounded border px-2 text-[10px] font-bold transition-colors disabled:opacity-40',
                loopB !== null
                  ? 'border-[color-mix(in_srgb,var(--b)_60%,transparent)] bg-[color-mix(in_srgb,var(--b)_14%,transparent)] text-[var(--b)]'
                  : 'border-[var(--line2)] bg-[var(--panel2)] text-[var(--dim)] hover:text-[var(--text)]',
              )}
            >
              <Flag size={13} /> B
            </button>
            {(loopA !== null || loopB !== null) && (
              <button
                type="button"
                onClick={() => actions.clearLoop()}
                title={t.clearLoop}
                className="flex h-8 w-8 items-center justify-center rounded border border-[var(--line2)] bg-[var(--panel2)] text-[var(--dim)] transition-colors hover:text-[var(--crit)]"
              >
                <XCircle size={13} />
              </button>
            )}
          </div>
          <div className="flex items-center justify-end gap-1.5 text-[9px] text-[var(--faint)]">
            <Repeat size={10} />
            {loopA !== null && loopB !== null ? `${formatTime(loopA)}–${formatTime(loopB)}` : t.abLoop}
          </div>
        </div>

        {/* load file */}
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
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded border border-[var(--line2)] bg-[var(--panel2)] px-3 text-[11px] font-bold text-[var(--dim)] transition-colors hover:text-[var(--a)]"
        >
          <Upload size={13} />
          <span className="hidden sm:inline">{t.loadFile}</span>
        </button>
      </div>
    </div>
  );
}
