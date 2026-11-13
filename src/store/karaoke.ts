'use client';

/* TITO KARAOKE STUDIO v1.0 — app state (zustand)
 * The engine owns audio; the store owns what the UI renders.
 * The rAF hook pushes engine snapshots into the store (cheap fields only).
 */

import { create } from 'zustand';
import type { MicFx, RankKey, ScoreResult, SongMeta, TakeMeta, VocalMode } from '@/lib/karaoke/types';
import { MIC_FX_DEFAULT } from '@/lib/karaoke/types';
import type { Lang } from '@/lib/karaoke/i18n';
import type { DiscoverSong, HotSong } from '@/lib/karaoke/discover-types';

/** Lifecycle of the AI lyric sync for the current song. */
export type SyncState = 'idle' | 'syncing' | 'synced' | 'plain' | 'none';

export interface UiSong {
  id: string;
  title: string;
  artist?: string;
  durationSec: number;
  hasLrc: boolean;
  hasMelody: boolean;
}

interface KaraokeState {
  /* console */
  powered: boolean;
  lang: Lang;
  stageMode: boolean;

  /* v3.0 — screen machine: HOME (search-first landing) ⇄ STUDIO (player) */
  screen: 'home' | 'studio';

  /* live snapshot (updated by rAF) */
  playing: boolean;
  pos: number;
  duration: number;
  songLevel: number;
  micLevel: number;
  micPitchMidi: number | null;
  micPitchHz: number | null;
  clarity: number;
  targetMidi: number | null;
  liveScore: ScoreResult | null;
  recording: boolean;
  recSec: number;

  /* discover (search & streaming) */
  discoverQuery: string;
  discoverResults: DiscoverSong[];
  discoverLoading: boolean;
  discoverError: string | null;
  trending: DiscoverSong[];
  hot: HotSong[];
  discoverBusyId: string | null;
  syncState: SyncState;
  recentSearches: string[];
  favorites: DiscoverSong[];
  /** the catalog song behind the current studio session (share/YT/preview) */
  activeDiscover: DiscoverSong | null;

  /* full-song YouTube mode */
  ytActive: boolean;
  ytVideoId: string | null;

  /* song */
  song: UiSong | null;
  loadingFile: boolean;
  scanning: boolean;
  scanProgress: number;
  peaks: Float32Array | null;

  /* vocal engine */
  mode: VocalMode;
  amount: number;
  keySemitones: number;
  speed: number;
  preservePitch: boolean;
  songVolume: number;
  loopA: number | null;
  loopB: number | null;

  /* mic */
  micActive: boolean;
  fx: MicFx;

  /* library */
  songs: SongMeta[];
  takes: TakeMeta[];
  libOpen: boolean;
  editorOpen: boolean;
  resultsOpen: boolean;
  lastTake: { wav: Blob; durationSec: number; score: ScoreResult } | null;

  /* actions */
  set: <K extends keyof KaraokeState>(k: K, v: KaraokeState[K]) => void;
  patch: (p: Partial<KaraokeState>) => void;
  setFx: (p: Partial<MicFx>) => void;
}

export const useKaraoke = create<KaraokeState>((set) => ({
  powered: false,
  lang: 'he',
  stageMode: false,
  screen: 'home',

  playing: false,
  pos: 0,
  duration: 0,
  songLevel: 0,
  micLevel: 0,
  micPitchMidi: null,
  micPitchHz: null,
  clarity: 0,
  targetMidi: null,
  liveScore: null,
  recording: false,
  recSec: 0,

  /* discover (search & streaming) */
  discoverQuery: '',
  discoverResults: [],
  discoverLoading: false,
  discoverError: null,
  trending: [],
  hot: [],
  discoverBusyId: null,
  syncState: 'idle',
  recentSearches: [],
  favorites: [],
  activeDiscover: null,

  ytActive: false,
  ytVideoId: null,

  song: null,
  loadingFile: false,
  scanning: false,
  scanProgress: 0,
  peaks: null,

  mode: 'off',
  amount: 0.85,
  keySemitones: 0,
  speed: 1,
  preservePitch: true,
  songVolume: 1,
  loopA: null,
  loopB: null,

  micActive: false,
  fx: { ...MIC_FX_DEFAULT },

  songs: [],
  takes: [],
  libOpen: false,
  editorOpen: false,
  resultsOpen: false,
  lastTake: null,

  set: (k, v) => set({ [k]: v } as Partial<KaraokeState>),
  patch: (p) => set(p),
  setFx: (p) => set((s) => ({ fx: { ...s.fx, ...p } })),
}));

export const rankColor = (rank: RankKey): string => {
  switch (rank) {
    case 'deaf':
      return 'var(--crit)';
    case 'shy':
      return 'var(--crit)';
    case 'warmup':
      return 'var(--warn)';
    case 'inTune':
      return 'var(--warn)';
    case 'solid':
      return 'var(--good)';
    case 'bright':
      return 'var(--good)';
    case 'star':
      return 'var(--a)';
    case 'legend':
      return 'var(--b)';
    default:
      return 'var(--dim)';
  }
};
