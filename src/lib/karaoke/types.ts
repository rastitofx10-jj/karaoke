/* TITO KARAOKE STUDIO v1.0 — shared types
 * The one vocabulary every engine, store and panel speaks.
 */

/* ---------- lyrics ---------- */

/** A single word with enhanced (word-level) timing, seconds. */
export interface LrcWord {
  t: number;
  end?: number;
  text: string;
}

/** One synced lyric line. `time` in seconds. `end` derived or measured. */
export interface LrcLine {
  time: number;
  end?: number;
  text: string;
  words?: LrcWord[];
  /** translation / second language line, shown under the main line */
  sub?: string;
}

export interface LrcSong {
  title?: string;
  artist?: string;
  album?: string;
  by?: string;
  /** global offset in milliseconds (LRC [offset:]) — positive shifts earlier */
  offsetMs?: number;
  lines: LrcLine[];
}

/* ---------- melody / pitch ---------- */

export interface MelodyNote {
  /** seconds */
  t: number;
  end: number;
  midi: number;
  hz: number;
  clarity: number;
}

export interface MelodyTrack {
  notes: MelodyNote[];
  minMidi: number;
  maxMidi: number;
  /** seconds — length of scanned source */
  duration: number;
}

export interface PitchFrame {
  /** seconds within song timeline */
  t: number;
  /** detected fundamental, null when unvoiced */
  hz: number | null;
  midi: number | null;
  clarity: number;
}

/* ---------- scoring ---------- */

export interface ScoreFrame {
  t: number;
  targetMidi: number | null;
  sungMidi: number | null;
  /** signed cent deviation when both present */
  centsOff: number | null;
}

export type RankKey =
  | 'deaf'
  | 'shy'
  | 'warmup'
  | 'inTune'
  | 'solid'
  | 'bright'
  | 'star'
  | 'legend';

export interface ScoreResult {
  /** 0..100 */
  overall: number;
  pitchScore: number;
  timingScore: number;
  coverage: number;
  /** cents, absolute average when on target */
  avgCents: number;
  notesHit: number;
  notesTotal: number;
  rank: RankKey;
}

/* ---------- library / persistence ---------- */

export interface SongMeta {
  id: string;
  title: string;
  artist?: string;
  createdAt: number;
  durationSec: number;
  hasLrc: boolean;
  hasMelody: boolean;
  sizeBytes: number;
}

export interface SongRecord extends SongMeta {
  audio: Blob;
  lrc?: string;
  melody?: MelodyTrack;
}

export interface TakeMeta {
  id: string;
  songId: string;
  songTitle: string;
  createdAt: number;
  durationSec: number;
  score: number;
  rank: RankKey;
}

export interface TakeRecord extends TakeMeta {
  wav: Blob;
}

/* ---------- engine settings ---------- */

export type VocalMode = 'off' | 'karaoke' | 'isolate';

export interface MicFx {
  gate: boolean;
  gateThresholdDb: number;
  lowDb: number;
  midDb: number;
  highDb: number;
  compressor: boolean;
  reverb: number; // 0..1 wet
  reverbPreset: 'room' | 'hall' | 'stage' | 'stadium';
  echo: number; // 0..1 wet
  echoTimeMs: number;
  micGainDb: number;
  monitor: boolean;
}

export const MIC_FX_DEFAULT: MicFx = {
  gate: true,
  gateThresholdDb: -50,
  lowDb: 0,
  midDb: 0,
  highDb: 0,
  compressor: true,
  reverb: 0.18,
  reverbPreset: 'hall',
  echo: 0,
  echoTimeMs: 260,
  micGainDb: 0,
  monitor: false,
};

/* ---------- results of a sung take (in memory) ---------- */

export interface TakeSummary {
  startedAt: number;
  endedAt: number;
  frames: ScoreFrame[];
  result: ScoreResult;
}
