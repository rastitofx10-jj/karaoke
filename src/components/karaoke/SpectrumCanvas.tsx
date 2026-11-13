'use client';

/* TITO KARAOKE STUDIO v1.0 — spectrum visualizer (amber→rose bars) */

import { useEffect, useRef } from 'react';
import { getEngine } from '@/hooks/use-engine';
import { useKaraoke } from '@/store/karaoke';

export function SpectrumCanvas({ height = 42 }: { height?: number }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bufRef = useRef(new Uint8Array(1024));

  useEffect(() => {
    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const st = useKaraoke.getState();
      if (!st.powered) return;
      const w = wrap.clientWidth;
      if (w < 8) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.floor(w * dpr)) {
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${height}px`;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, height);

      getEngine().spectrum(bufRef.current);
      const data = bufRef.current;
      const bars = Math.min(72, Math.floor(w / 9));
      const step = Math.floor(data.length / 5 / bars); // use the lower 80% (musical range)
      const bw = w / bars;
      for (let i = 0; i < bars; i++) {
        let v = 0;
        const base = Math.floor(Math.pow(i / bars, 1.4) * data.length * 0.8); // log-ish spacing
        for (let k = 0; k < step; k++) v = Math.max(v, data[base + k] ?? 0);
        const frac = v / 255;
        const bh = Math.max(2, frac * frac * height);
        const hue = 36 - (i / bars) * 20; // amber → rose-ish gradient handled manually below
        void hue;
        const t = i / bars;
        const r = Math.round(245 - t * 3);
        const g = Math.round(168 - t * 82);
        const b = Math.round(59 + t * 36);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.globalAlpha = 0.25 + frac * 0.75;
        ctx.fillRect(i * bw + 1, height - bh, bw - 2, bh);
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [height]);

  return (
    <div ref={wrapRef} className="w-full overflow-hidden rounded" aria-hidden>
      <canvas ref={canvasRef} className="block" style={{ height }} />
    </div>
  );
}
