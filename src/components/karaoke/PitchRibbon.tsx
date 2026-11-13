'use client';

/* TITO KARAOKE STUDIO v1.0 — live pitch ribbon (SingStar-style piano roll)
 * Target melody as amber bars, your voice as a glowing rose trail,
 * "now" line at 70% width, ±10 s window, key transposition applied.
 */

import { useEffect, useRef } from 'react';
import { useKaraoke } from '@/store/karaoke';
import { getEngine } from '@/hooks/use-engine';
import { midiToHz } from '@/lib/karaoke/pitch';
import { melodyAt } from '@/lib/karaoke/melody';
import { DICTS } from '@/lib/karaoke/i18n';
import { midiToNoteName } from '@/lib/karaoke/pitch';

const WINDOW_SEC = 12;

interface TrailPoint {
  t: number;
  midi: number;
}

export function PitchRibbon({ height = 120 }: { height?: number }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trailRef = useRef<TrailPoint[]>([]);
  const lastPosRef = useRef(0);

  useEffect(() => {
    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const st = useKaraoke.getState();
      const engine = getEngine();
      if (!st.powered) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = wrap.clientWidth;
      const h = height;
      if (w < 10) return;
      if (canvas.width !== Math.floor(w * dpr)) {
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const pos = st.pos;
      // detect seek backwards → drop trail
      if (pos + 1 < lastPosRef.current) trailRef.current = [];
      lastPosRef.current = pos;

      const melody = engine.song?.melody;
      const key = st.keySemitones;

      // range: melody span (or voice register) with padding
      let lo = melody ? melody.minMidi + key - 3 : 45;
      let hi = melody ? melody.maxMidi + key + 3 : 72;
      if (hi - lo < 14) {
        const mid = (hi + lo) / 2;
        lo = mid - 7;
        hi = mid + 7;
      }
      const nowX = w * 0.7;
      const secPerPx = WINDOW_SEC / w;
      const midiToY = (m: number) => h - ((m - lo) / (hi - lo)) * h;
      const tToX = (t: number) => nowX - (pos - t) / secPerPx;

      // octave grid
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.font = '9px monospace';
      ctx.fillStyle = 'rgba(154,163,178,0.5)';
      for (let m = Math.ceil(lo / 12) * 12; m <= hi; m += 12) {
        const y = midiToY(m);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        ctx.fillText(`C${Math.floor(m / 12) - 1}`, 4, y - 3);
      }

      // target notes
      if (melody) {
        const notes = melody.notes;
        // binary search window start
        let i0 = 0;
        let loI = 0;
        let hiI = notes.length - 1;
        const tFrom = pos - (nowX / secPerPx) - 1;
        while (loI <= hiI) {
          const mid = (loI + hiI) >> 1;
          if (notes[mid].end < tFrom) loI = mid + 1;
          else {
            i0 = mid;
            hiI = mid - 1;
          }
        }
        for (let i = i0; i < notes.length; i++) {
          const n = notes[i];
          if (n.t > pos + (w - nowX) / secPerPx) break;
          const x0 = tToX(n.t);
          const x1 = tToX(n.end);
          const y = midiToY(n.midi + key);
          const hit = x1 < nowX; // fully in the past
          ctx.fillStyle = hit ? 'rgba(245,168,59,0.55)' : 'rgba(245,168,59,0.85)';
          const bw = Math.max(2, x1 - x0 - 1);
          const bh = 7;
          ctx.beginPath();
          ctx.roundRect(x0, y - bh / 2, bw, bh, 3.5);
          ctx.fill();
        }
      }

      // sung trail
      if (st.micPitchMidi !== null && st.micActive) {
        const comp = engine.micLatencySec();
        trailRef.current.push({ t: pos - comp, midi: st.micPitchMidi });
      }
      const trail = trailRef.current;
      while (trail.length && trail[0].t < pos - (nowX / secPerPx)) trail.shift();
      if (trail.length > 900) trail.splice(0, trail.length - 900);
      if (trail.length) {
        ctx.lineWidth = 3.5;
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(242,86,143,0.9)';
        ctx.shadowColor = 'rgba(242,86,143,0.8)';
        ctx.shadowBlur = 6;
        ctx.beginPath();
        let started = false;
        let prevT = 0;
        for (const p of trail) {
          const x = tToX(p.t);
          const y = midiToY(p.midi);
          // gap if > 250 ms silence
          if (!started || p.t - prevT > 0.25) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
          prevT = p.t;
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
        // current dot
        const last = trail[trail.length - 1];
        if (pos - last.t < 0.3) {
          const x = tToX(last.t);
          const y = midiToY(last.midi);
          ctx.fillStyle = '#f2568f';
          ctx.shadowColor = '#f2568f';
          ctx.shadowBlur = 12;
          ctx.beginPath();
          ctx.arc(x, y, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }

      // now line
      ctx.strokeStyle = 'rgba(237,232,223,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(nowX, 0);
      ctx.lineTo(nowX, h);
      ctx.stroke();

      // labels
      ctx.font = 'bold 10px monospace';
      const your = DICTS[st.lang];
      if (st.micPitchHz) {
        ctx.fillStyle = '#f2568f';
        ctx.textAlign = 'left';
        ctx.fillText(`${your.yourPitch}: ${midiToNoteName(st.micPitchMidi ?? 60)} ${st.micPitchHz.toFixed(0)}Hz`, 6, 14);
      }
      if (st.targetMidi !== null) {
        ctx.fillStyle = '#f5a83b';
        ctx.textAlign = 'right';
        const note = melodyAt(melody ?? { notes: [], minMidi: 0, maxMidi: 0, duration: 0 }, Math.max(0, pos - engine.micLatencySec()));
        ctx.fillText(`${your.targetPitch}: ${midiToNoteName(st.targetMidi)}${note ? ` ${midiToHz(note.midi + key).toFixed(0)}Hz` : ''}`, w - 6, 14);
      }
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [height]);

  return (
    <div ref={wrapRef} className="w-full overflow-hidden rounded-md border border-[var(--line)] bg-[var(--well)]">
      <canvas ref={canvasRef} className="block" style={{ height }} />
    </div>
  );
}
