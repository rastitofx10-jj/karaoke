'use client';

/* TITO KARAOKE STUDIO v4.0 — THE NETWORK DOCTOR.
 *
 * THE PROBLEM IT SOLVES: "the full song did not load" is a mystery, and
 * mysteries read as broken products. The truth is that every tier of the
 * machine depends on a different provider (LRCLIB / NetEase / iTunes /
 * YouTube-embeds / YouTube-direct-audio), and any one of them can be
 * walled for a given network at a given moment. A professional product
 * does not guess — it SHOWS the wall.
 *
 * THE IMPLEMENTATION (hunted DNA: the hunter's live health-chip pattern —
 * one panel, one status law, every provider measured in real time):
 *   • the SERVER half (/api/discover/diag) pings LRCLIB, NetEase, iTunes
 *     and the innertube direct-audio tier with real production queries;
 *   • the BROWSER half — the only honest embeddability check — mounts a
 *     tiny muted iframe of a known-embeddable, Creative-Commons video and
 *     waits for proof of life (PLAYING with a ticking clock) exactly the
 *     way the production probe gate does;
 *   • the verdict is a single human sentence that tells the user what to
 *     DO next (paste a link / import a file / tap-sync lyrics) — never
 *     just a red dot.
 *
 * Total: every check fails soft; the panel never throws, never blocks
 * the studio, and always renders an answer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Check, Loader2, RefreshCw, ShieldAlert, ShieldX, Timer, X } from 'lucide-react';
import { useKaraoke } from '@/store/karaoke';
import { DICTS } from '@/lib/karaoke/i18n';
import { createYtPlayer } from '@/lib/karaoke/yt';
import type { YtPlayer } from '@/lib/karaoke/yt';
import { cn } from '@/lib/utils';

type ProviderState = 'ok' | 'blocked' | 'slow' | 'down' | 'checking';

interface DiagRow {
  key: string;
  label: string;
  state: ProviderState;
  ms: number | null;
}

interface ServerDiag {
  at: number;
  providers: {
    lrclib: { state: 'ok' | 'blocked' | 'slow' | 'down'; ms: number | null };
    netease: { state: 'ok' | 'blocked' | 'slow' | 'down'; ms: number | null };
    itunes: { state: 'ok' | 'blocked' | 'slow' | 'down'; ms: number | null };
    ytServer: { state: 'ok' | 'blocked' | 'slow' | 'down'; ms: number | null };
  };
}

/** the browser half: a real embed probe of a known-embeddable video.
 *  PLAYING + ticking clock = ok; any onError / stall within the deadline
 *  = blocked; no answer = down. This is the EXACT question the production
 *  probe gate asks, asked with the same machinery. */
const EMBED_TEST_VIDEO = 'aqz-KE-bpKQ'; // Big Buck Bunny — CC-licensed, stable, embeddable
const EMBED_DEADLINE_MS = 9_000;

function probeEmbed(holder: HTMLElement): Promise<ProviderState> {
  return new Promise((resolve) => {
    let settled = false;
    let player: YtPlayer | null = null;
    let tick0 = -1;
    const timers: number[] = [];
    const done = (s: ProviderState) => {
      if (settled) return;
      settled = true;
      for (const id of timers) window.clearTimeout(id);
      try {
        player?.destroy();
      } catch {
        /* already gone */
      }
      holder.innerHTML = '';
      resolve(s);
    };

    createYtPlayer(
      holder,
      EMBED_TEST_VIDEO,
      (ev) => {
        /* 1 = PLAYING */
        if (ev.data === 1 && player) {
          tick0 = player.getCurrentTime();
          /* prove the clock moves — a walled player claims PLAYING
           * while showing an error card over a frozen clock */
          timers.push(
            window.setTimeout(() => {
              const t1 = player ? player.getCurrentTime() : -1;
              done(t1 > tick0 ? 'ok' : 'blocked');
            }, 900),
          );
        }
      },
      () => done('blocked'),
      { muted: true },
    )
      .then((p) => {
        player = p;
        try {
          p.playVideo();
        } catch {
          /* the deadline still decides */
        }
      })
      .catch(() => done('down'));

    timers.push(window.setTimeout(() => done('down'), EMBED_DEADLINE_MS));
  });
}

export function NetworkDoctor({ onClose }: { onClose: () => void }) {
  const lang = useKaraoke((s) => s.lang);
  const t = DICTS[lang];
  const [rows, setRows] = useState<DiagRow[]>([]);
  const [running, setRunning] = useState(false);
  const [ranAt, setRanAt] = useState<number | null>(null);
  const probeHolder = useRef<HTMLDivElement>(null);

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    const t0 = Date.now();
    setRows([
      { key: 'lrclib', label: t.diagLrclib, state: 'checking', ms: null },
      { key: 'netease', label: t.diagNetease, state: 'checking', ms: null },
      { key: 'itunes', label: t.diagItunes, state: 'checking', ms: null },
      { key: 'ytEmbed', label: t.diagYtEmbed, state: 'checking', ms: null },
      { key: 'ytServer', label: t.diagYtServer, state: 'checking', ms: null },
    ]);

    /* server half + browser half, in parallel */
    const serverPromise = fetch('/api/discover/diag')
      .then((r) => (r.ok ? (r.json() as Promise<ServerDiag>) : null))
      .catch(() => null);

    const embedPromise = probeEmbed(probeHolder.current ?? document.createElement('div'));

    const [server, embed] = await Promise.all([serverPromise, embedPromise]);

    setRows([
      {
        key: 'lrclib',
        label: t.diagLrclib,
        state: server?.providers.lrclib.state ?? 'down',
        ms: server?.providers.lrclib.ms ?? null,
      },
      {
        key: 'netease',
        label: t.diagNetease,
        state: server?.providers.netease.state ?? 'down',
        ms: server?.providers.netease.ms ?? null,
      },
      {
        key: 'itunes',
        label: t.diagItunes,
        state: server?.providers.itunes.state ?? 'down',
        ms: server?.providers.itunes.ms ?? null,
      },
      { key: 'ytEmbed', label: t.diagYtEmbed, state: embed, ms: embed === 'ok' || embed === 'blocked' ? Date.now() - t0 : null },
      {
        key: 'ytServer',
        label: t.diagYtServer,
        state: server?.providers.ytServer.state ?? 'down',
        ms: server?.providers.ytServer.ms ?? null,
      },
    ]);
    setRanAt(Date.now());
    setRunning(false);
  }, [running, t]);

  /* auto-run once on mount (deferred a tick so the effect body itself
   * never calls setState synchronously) */
  useEffect(() => {
    const id = window.setTimeout(() => void run(), 0);
    return () => window.clearTimeout(id);
  }, []);

  /* the verdict — one honest sentence, chosen by the single status law:
   *  embed wall > server wall > lyrics providers > all healthy */
  const verdict: string | null = (() => {
    if (running || rows.length === 0) return null;
    const byKey = new Map(rows.map((r) => [r.key, r.state]));
    const ytEmbed = byKey.get('ytEmbed');
    const ytServer = byKey.get('ytServer');
    const lyricsDown =
      (byKey.get('lrclib') === 'down' || byKey.get('lrclib') === 'blocked') &&
      (byKey.get('netease') === 'down' || byKey.get('netease') === 'blocked');
    if (ytEmbed === 'blocked' || ytEmbed === 'down') return t.diagVerdictEmbed;
    if (ytServer === 'blocked' || ytServer === 'down') return t.diagVerdictServer;
    if (lyricsDown) return t.diagVerdictLyrics;
    if (rows.every((r) => r.state === 'ok' || r.state === 'slow')) return t.diagVerdictAll;
    if (rows.every((r) => r.state === 'down')) return t.diagVerdictNone;
    return t.diagVerdictAll;
  })();

  const stateDot = (s: ProviderState) =>
    s === 'ok' ? 'bg-emerald-400' : s === 'slow' ? 'bg-amber-400' : s === 'checking' ? 'bg-[var(--dim)]' : 'bg-red-400';
  const stateIcon = (s: ProviderState) => {
    if (s === 'checking') return <Loader2 size={12} className="animate-spin text-[var(--dim)]" aria-hidden />;
    if (s === 'ok') return <Check size={12} className="text-emerald-400" aria-hidden />;
    if (s === 'slow') return <Timer size={12} className="text-amber-400" aria-hidden />;
    return <ShieldX size={12} className="text-red-400" aria-hidden />;
  };
  const stateLabel = (s: ProviderState) =>
    s === 'ok' ? t.diagOk : s === 'slow' ? t.diagSlow : s === 'blocked' ? t.diagBlocked : s === 'checking' ? t.diagRunning : t.diagDown;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
      <div className="flex items-center gap-2">
        <Activity size={15} className="text-[var(--b)]" aria-hidden />
        <h3 className="text-[13px] font-black text-[var(--text)]">{t.diagTitle}</h3>
        <span className="ms-auto" />
        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--line2)] bg-[var(--panel2)] px-2.5 text-[11px] font-bold text-[var(--dim)] transition-colors hover:text-[var(--text)] disabled:opacity-50"
        >
          <RefreshCw size={12} className={running ? 'animate-spin' : undefined} aria-hidden />
          {running ? t.diagRunning : t.diagRun}
        </button>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t.close}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--faint)] transition-colors hover:text-[var(--text)]"
          >
            <X size={14} aria-hidden />
          </button>
        )}
      </div>

      <p className="text-[10.5px] leading-relaxed text-[var(--faint)]">{t.diagHint}</p>

      {/* the provider table */}
      <ul className="flex flex-col gap-1.5" role="list">
        {rows.map((r) => (
          <li
            key={r.key}
            className="flex min-h-[38px] items-center gap-2.5 rounded-lg border border-[var(--line)] bg-[var(--well)] px-3"
          >
            <span className={cn('h-2 w-2 shrink-0 rounded-full', stateDot(r.state))} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-[12px] font-bold text-[var(--dim)]">{r.label}</span>
            <span className="shrink-0 tabular-nums text-[10px] text-[var(--faint)]" dir="ltr">
              {r.ms != null ? `${r.ms}ms` : ''}
            </span>
            <span className="flex w-[74px] shrink-0 items-center justify-end gap-1 text-[10.5px] font-bold text-[var(--text)]">
              {stateIcon(r.state)}
              {stateLabel(r.state)}
            </span>
          </li>
        ))}
        {rows.length === 0 && (
          <li className="flex min-h-[38px] items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--line2)] text-[11px] text-[var(--faint)]">
            <Loader2 size={12} className="animate-spin" aria-hidden />
            {t.diagRunning}
          </li>
        )}
      </ul>

      {/* the verdict — one sentence, one next action */}
      {verdict && (
        <div className="flex items-start gap-2 rounded-lg border border-[color-mix(in_srgb,var(--b)_40%,transparent)] bg-[var(--b-soft)] px-3 py-2.5">
          <ShieldAlert size={14} className="mt-0.5 shrink-0 text-[var(--b)]" aria-hidden />
          <p className="text-[11.5px] font-medium leading-relaxed text-[var(--dim)]">{verdict}</p>
        </div>
      )}

      {ranAt && <p className="text-[9px] text-[var(--faint)]">{new Date(ranAt).toLocaleTimeString()}</p>}

      {/* the hidden embed probe host — 1px, silent, aria-hidden */}
      <div ref={probeHolder} className="pointer-events-none absolute h-px w-px overflow-hidden opacity-0" aria-hidden />
    </div>
  );
}
