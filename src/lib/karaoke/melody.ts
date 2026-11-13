/* TITO KARAOKE STUDIO v1.0 — offline melody scanner
 * Learns the original singer's melody from a (ideally vocal-isolated) mono
 * channel: frame-wise YIN → median filter → octave fix → note segmentation.
 * Produces the SingStar-style target track the scoring engine aims at.
 * Pure + synchronous so it can run inside a Web Worker.
 */

import type { MelodyNote, MelodyTrack } from './types';
import { YinDetector, hzToMidi, midiToHz, medianOf } from './pitch';

interface VoicePoint {
  t: number;
  midi: number | null;
  clarity: number;
}

/** median window half-width in frames */
const MED_HALF = 2;
/** max run length (frames) treated by the octave fixer */
const MAX_RUN = 4096;
/** octave error tolerance in semitones around ±12 */
const OCT_TOL = 0.8;
/** note stability in semitones around the running median */
const NOTE_STABLE = 0.7;
/** min voiced frames for a kept note (~3 hops ≈ 140 ms) */
const MIN_NOTE_FRAMES = 3;
/** merge adjacent notes closer than this (semitones) */
const MERGE_SEMI = 0.35;

export function scanMelody(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: (p: number) => void,
): MelodyTrack {
  const hop = Math.max(512, Math.round(sampleRate * 0.0464));
  const windowSize = 2048;
  const detector = new YinDetector(sampleRate, windowSize);

  const totalFrames = Math.max(1, Math.floor((samples.length - windowSize) / hop) + 1);
  const points: VoicePoint[] = [];

  // ---- pass 1: frame-wise detection -----------------------------------
  for (let f = 0; f < totalFrames; f++) {
    const start = f * hop;
    const frame = samples.subarray(start, Math.min(start + windowSize, samples.length));
    if (frame.length < 512) break;
    const { hz, clarity } = detector.detect(frame);
    points.push({
      t: start / sampleRate,
      midi: hz !== null ? hzToMidi(hz) : null,
      clarity,
    });
    if (onProgress && f % 50 === 0) {
      onProgress(((f + 1) / totalFrames) * 0.55);
    }
  }

  // ---- pass 2: median filter (kills single-frame glitches) -------------
  const medians: (number | null)[] = points.map((p) => p.midi);
  for (let i = 0; i < points.length; i++) {
    if (points[i].midi === null) {
      medians[i] = null;
      continue;
    }
    const window: number[] = [];
    for (let k = -MED_HALF; k <= MED_HALF; k++) {
      const j = i + k;
      if (j >= 0 && j < points.length && points[j].midi !== null) {
        window.push(points[j].midi as number);
      }
    }
    medians[i] = window.length ? medianOf(window) : points[i].midi;
  }

  // ---- pass 3: octave fix on voiced runs -------------------------------
  // group into voiced runs first
  const runs: Array<{ from: number; to: number; median: number }> = [];
  {
    let from = -1;
    for (let i = 0; i <= medians.length; i++) {
      const voiced = i < medians.length && medians[i] !== null;
      if (voiced && from < 0) from = i;
      if (!voiced && from >= 0) {
        const seg = medians.slice(from, i).filter((v): v is number => v !== null);
        runs.push({ from, to: i, median: medianOf(seg) });
        from = -1;
      }
      if (runs.length > MAX_RUN) break;
    }
  }
  for (let r = 1; r < runs.length; r++) {
    const d = runs[r].median - runs[r - 1].median;
    if (Math.abs(d - 12) <= OCT_TOL) {
      // current run is likely an octave too high
      shiftRun(medians, runs[r], -12);
      runs[r].median -= 12;
    } else if (Math.abs(d + 12) <= OCT_TOL) {
      shiftRun(medians, runs[r], 12);
      runs[r].median += 12;
    }
  }
  if (onProgress) onProgress(0.75);

  // ---- pass 4: segment into stable notes --------------------------------
  const notes: MelodyNote[] = [];
  let noteStart = -1;
  let noteFrames = 0;
  let runMedian = 0;
  let claritySum = 0;
  let midiVals: number[] = [];

  const flush = (endIdx: number) => {
    if (noteStart >= 0 && noteFrames >= MIN_NOTE_FRAMES) {
      const midi = medianOf(midiVals);
      const lastT = points[Math.min(endIdx, points.length - 1)].t;
      notes.push({
        t: points[noteStart].t,
        end: lastT + hop / sampleRate,
        midi,
        hz: midiToHz(midi),
        clarity: claritySum / Math.max(1, noteFrames),
      });
    }
    noteStart = -1;
    noteFrames = 0;
    claritySum = 0;
    midiVals = [];
  };

  for (let i = 0; i < medians.length; i++) {
    const m = medians[i];
    if (m === null) {
      flush(i);
      continue;
    }
    if (noteStart < 0) {
      noteStart = i;
      runMedian = m;
      noteFrames = 1;
      claritySum = points[i].clarity;
      midiVals = [m];
      continue;
    }
    // running median with hysteresis against drift
    if (Math.abs(m - runMedian) <= NOTE_STABLE) {
      noteFrames++;
      claritySum += points[i].clarity;
      midiVals.push(m);
      if (noteFrames % 4 === 0) runMedian = medianOf(midiVals.slice(-12));
    } else {
      flush(i);
      noteStart = i;
      runMedian = m;
      noteFrames = 1;
      claritySum = points[i].clarity;
      midiVals = [m];
    }
  }
  flush(medians.length - 1);

  // ---- pass 5: merge near-identical adjacent notes ----------------------
  const merged: MelodyNote[] = [];
  for (const n of notes) {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(prev.midi - n.midi) < MERGE_SEMI) {
      prev.end = n.end;
      prev.clarity = (prev.clarity + n.clarity) / 2;
    } else {
      merged.push({ ...n });
    }
  }

  if (onProgress) onProgress(1);

  if (!merged.length) {
    return { notes: [], minMidi: 48, maxMidi: 72, duration: samples.length / sampleRate };
  }
  let minMidi = Infinity;
  let maxMidi = -Infinity;
  for (const n of merged) {
    if (n.midi < minMidi) minMidi = n.midi;
    if (n.midi > maxMidi) maxMidi = n.midi;
  }
  return {
    notes: merged,
    minMidi: Math.floor(minMidi),
    maxMidi: Math.ceil(maxMidi),
    duration: samples.length / sampleRate,
  };
}

function shiftRun(medians: (number | null)[], run: { from: number; to: number }, shift: number) {
  for (let i = run.from; i < run.to; i++) {
    if (medians[i] !== null) medians[i] = (medians[i] as number) + shift;
  }
}

/** Note active at time t (binary search), or null. */
export function melodyAt(track: MelodyTrack, t: number): MelodyNote | null {
  const { notes } = track;
  if (!notes.length) return null;
  let lo = 0;
  let hi = notes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const n = notes[mid];
    if (t < n.t) hi = mid - 1;
    else if (t >= n.end) lo = mid + 1;
    else return n;
  }
  return null;
}

/** New melody track shifted by whole/half semitones (key change support). */
export function transposeMelody(track: MelodyTrack, semitones: number): MelodyTrack {
  return {
    ...track,
    notes: track.notes.map((n) => ({
      ...n,
      midi: n.midi + semitones,
      hz: midiToHz(n.midi + semitones),
    })),
    minMidi: track.minMidi + semitones,
    maxMidi: track.maxMidi + semitones,
  };
}
