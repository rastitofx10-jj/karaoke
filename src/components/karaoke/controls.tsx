'use client';

/* TITO KARAOKE STUDIO v1.0 — shared console controls */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/* ---------- panel shell ---------- */

export function Panel({
  title, icon, children, className, actions,
}: {
  title?: string;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
}) {
  return (
    <section className={cn('panel flex min-h-0 flex-col', className)} aria-label={title}>
      {title && (
        <header className="panel-title justify-between">
          <span className="flex items-center gap-2">
            {icon}
            {title}
          </span>
          {actions}
        </header>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

/* ---------- fader (range input as console fader) ---------- */

export function Fader({
  label, value, min, max, step = 0.01, onChange, format, disabled, accent = 'a',
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  disabled?: boolean;
  accent?: 'a' | 'b';
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <label className={cn('block select-none', disabled && 'opacity-40')}>
      <span className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold tracking-wider text-[var(--dim)] uppercase">{label}</span>
        <span
          className="kv"
          style={{ color: accent === 'a' ? 'var(--a)' : 'var(--b)' }}
        >
          {format ? format(value) : value.toFixed(2)}
        </span>
      </span>
      <input
        type="range"
        className="fader"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ['--pct' as string]: `${pct}%` }}
        aria-label={label}
      />
    </label>
  );
}

/* ---------- toggle chip ---------- */

export function Chip({
  active, onClick, children, accent = 'a', disabled, title,
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  accent?: 'a' | 'b' | 'good' | 'crit';
  disabled?: boolean;
  title?: string;
}) {
  const color =
    accent === 'b' ? 'var(--b)' : accent === 'good' ? 'var(--good)' : accent === 'crit' ? 'var(--crit)' : 'var(--a)';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'rounded border px-2.5 py-1 text-xs font-semibold transition-colors',
        'min-h-[32px]',
        active
          ? 'border-transparent'
          : 'border-[var(--line2)] bg-[var(--panel2)] text-[var(--dim)] hover:text-[var(--text)]',
        disabled && 'cursor-not-allowed opacity-40',
      )}
      style={active ? { background: `color-mix(in srgb, ${color} 18%, transparent)`, color, borderColor: `color-mix(in srgb, ${color} 55%, transparent)` } : undefined}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

/* ---------- stereo level meter ---------- */

export function LevelMeter({ level, label, vertical }: { level: number; label?: string; vertical?: boolean }) {
  const pct = Math.round(Math.min(1, Math.max(0, level)) * 100);
  if (vertical) {
    return (
      <div className="flex h-full flex-col items-center gap-1" aria-label={label}>
        <div className="relative w-2.5 flex-1 overflow-hidden rounded bg-[var(--well)]">
          <div
            className="absolute bottom-0 w-full transition-[height] duration-75"
            style={{
              height: `${pct}%`,
              background: 'linear-gradient(to top, var(--good) 0%, var(--good) 62%, var(--warn) 82%, var(--crit) 100%)',
            }}
          />
        </div>
        {label && <span className="text-[8px] text-[var(--faint)]">{label}</span>}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2" aria-label={label}>
      {label && <span className="text-[9px] tracking-wider text-[var(--faint)] uppercase">{label}</span>}
      <div className="relative h-1.5 w-full overflow-hidden rounded bg-[var(--well)]">
        <div
          className="absolute inset-y-0 transition-[width] duration-75"
          style={{
            width: `${pct}%`,
            right: 0,
            background: 'linear-gradient(to left, var(--good) 0%, var(--good) 62%, var(--warn) 82%, var(--crit) 100%)',
          }}
        />
      </div>
    </div>
  );
}

/* ---------- key/value stat ---------- */

export function Stat({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] tracking-[0.12em] text-[var(--faint)] uppercase">{k}</span>
      <span className="kv" style={{ color: color ?? 'var(--text)' }}>{v}</span>
    </div>
  );
}
