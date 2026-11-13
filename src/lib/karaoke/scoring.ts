/* TITO KARAOKE STUDIO v1.0 — SingStar-style scoring
 * Turns collected frames (target melody vs sung pitch) into a live rolling
 * score and a final result with a rank ladder.
 */

import type { RankKey, ScoreFrame, ScoreResult } from './types';

/** assumed seconds between collected frames (engine collects at ~30 Hz) */
export const FRAME_DT = 0.04;
/** min span (s) for a note window to count toward timing score */
const MIN_WINDOW_SEC = 0.15;
/** frame hit when |cents| <= this */
const HIT_CENTS = 60;
/** note window hit when >= this fraction of frames hit */
const WINDOW_HIT_FRAC = 0.55;
/** cents outliers beyond this ignored in the average */
const CENTS_OUTLIER = 250;

export const RANK_ORDER: RankKey[] = [
  'deaf',
  'shy',
  'warmup',
  'inTune',
  'solid',
  'bright',
  'star',
  'legend',
];

export function rankFor(overall: number): RankKey {
  if (overall < 25) return 'deaf';
  if (overall < 40) return 'shy';
  if (overall < 55) return 'warmup';
  if (overall < 68) return 'inTune';
  if (overall < 80) return 'solid';
  if (overall < 90) return 'bright';
  if (overall < 97) return 'star';
  return 'legend';
}

/** Final result over all collected frames. Never throws. */
export function scoreFrames(frames: ScoreFrame[]): ScoreResult {
  return scoreSlice(frames, 0, frames.length);
}

/** Rolling result over the last `windowSec` ending at `now`. Never throws. */
export function rollingScore(frames: ScoreFrame[], windowSec: number, now: number): ScoreResult {
  let lo = frames.length;
  while (lo > 0 && frames[lo - 1].t >= now - windowSec) lo--;
  return scoreSlice(frames, lo, frames.length);
}

function scoreSlice(frames: ScoreFrame[], from: number, to: number): ScoreResult {
  const empty: ScoreResult = {
    overall: 0,
    pitchScore: 0,
    timingScore: 0,
    coverage: 0,
    avgCents: 0,
    notesHit: 0,
    notesTotal: 0,
    rank: 'deaf',
  };
  if (from >= to) return empty;

  let scored = 0;
  let voiced = 0;
  let hitFrames = 0;
  let centsSum = 0;
  let centsCount = 0;

  // note windows: consecutive frames sharing one target value
  let winLen = 0;
  let winHit = 0;
  let windowsTotal = 0;
  let windowsHit = 0;

  const closeWindow = () => {
    if (winLen * FRAME_DT >= MIN_WINDOW_SEC) {
      windowsTotal++;
      if (winHit >= winLen * WINDOW_HIT_FRAC) windowsHit++;
    }
    winLen = 0;
    winHit = 0;
  };

  let prevTarget: number | null | undefined;

  for (let i = from; i < to; i++) {
    const f = frames[i];
    if (f.targetMidi === null) {
      closeWindow();
      prevTarget = null;
      continue;
    }
    if (prevTarget === undefined || f.targetMidi !== prevTarget) closeWindow();
    prevTarget = f.targetMidi;

    scored++;
    winLen++;
    const sung = f.sungMidi !== null && f.centsOff !== null;
    if (f.sungMidi !== null) voiced++;
    if (sung && Math.abs(f.centsOff as number) <= HIT_CENTS) {
      hitFrames++;
      winHit++;
    }
    if (sung && Math.abs(f.centsOff as number) <= CENTS_OUTLIER) {
      centsSum += Math.abs(f.centsOff as number);
      centsCount++;
    }
  }
  closeWindow();

  if (scored === 0) return empty;

  const pitchScore = (hitFrames / scored) * 100;
  const timingScore = windowsTotal > 0 ? (windowsHit / windowsTotal) * 100 : 0;
  const coverage = (voiced / scored) * 100;
  const avgCents = centsCount > 0 ? centsSum / centsCount : 0;
  const overall = clamp01((0.55 * pitchScore + 0.3 * timingScore + 0.15 * coverage) / 100) * 100;

  return {
    overall: Math.round(overall),
    pitchScore: Math.round(pitchScore),
    timingScore: Math.round(timingScore),
    coverage: Math.round(coverage),
    avgCents: Math.round(avgCents * 10) / 10,
    notesHit: windowsHit,
    notesTotal: windowsTotal,
    rank: rankFor(overall),
  };
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}
