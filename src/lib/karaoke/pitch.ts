/* TITO KARAOKE STUDIO v1.0 — YIN pitch detection
 * The real six-step YIN (de Cheveigné & Kawahara 2002), tuned for live
 * monophonic voice: fixed search band (55–1050 Hz), preallocated buffers,
 * zero allocation inside detect().
 */

export interface PitchResult {
  /** detected fundamental, null when rejected */
  hz: number | null;
  /** continuous MIDI note number (A4 = 69), null when rejected */
  midi: number | null;
  /** 1 - d'(tau) of the chosen period, 0..1 */
  clarity: number;
  /** frame RMS level (0..~1) */
  rms: number;
}

const A4 = 440;
/** YIN absolute threshold */
const THRESHOLD = 0.12;
/** silence gate */
const RMS_GATE = 0.008;
/** human voice band */
export const MIN_HZ = 55;
export const MAX_HZ = 1050;

export class YinDetector {
  private readonly sampleRate: number;
  private readonly size: number;
  private readonly diff!: Float32Array;
  private readonly cmnd!: Float32Array;
  private readonly tauMin: number;
  private readonly tauMax: number;

  constructor(sampleRate: number, bufferSize = 2048) {
    this.sampleRate = Math.max(1, sampleRate);
    let size = 1024;
    while (size < bufferSize && size < 8192) size <<= 1;
    this.size = size;
    this.diff = new Float32Array(size);
    this.cmnd = new Float32Array(size);
    // periods for the voice band
    this.tauMin = Math.max(2, Math.floor(this.sampleRate / MAX_HZ));
    this.tauMax = Math.min(size - 2, Math.ceil(this.sampleRate / MIN_HZ));
  }

  /** Detect the fundamental of one frame (length ≤ bufferSize). */
  detect(frame: Float32Array): PitchResult {
    const n = Math.min(frame.length, this.size);
    let sumSq = 0;
    for (let i = 0; i < n; i++) sumSq += frame[i] * frame[i];
    const rms = Math.sqrt(sumSq / Math.max(1, n));
    if (rms < RMS_GATE) return { hz: null, midi: null, clarity: 0, rms };

    const { diff, cmnd } = this;
    const W = n; // integrate over the whole frame
    const tauMax = Math.min(this.tauMax, W - 2);

    // Step 1+2: difference function, then cumulative-mean normalization inline.
    diff[0] = 0;
    cmnd[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      let d = 0;
      const lim = W - tau;
      for (let j = 0; j < lim; j++) {
        const delta = frame[j] - frame[j + tau];
        d += delta * delta;
      }
      diff[tau] = d;
      runningSum += d;
      cmnd[tau] = runningSum > 0 ? (d * tau) / runningSum : 1;
    }

    // Step 3: first tau under threshold that is also a local minimum.
    let tauChosen = -1;
    for (let tau = this.tauMin; tau < tauMax; tau++) {
      if (cmnd[tau] < THRESHOLD && cmnd[tau] <= cmnd[tau + 1]) {
        tauChosen = tau;
        break;
      }
    }
    // Fallback: global minimum inside the band (heavily aperiodic frames).
    if (tauChosen < 0) {
      let best = Infinity;
      for (let tau = this.tauMin; tau <= tauMax; tau++) {
        if (cmnd[tau] < best) {
          best = cmnd[tau];
          tauChosen = tau;
        }
      }
      if (best > 0.55) return { hz: null, midi: null, clarity: Math.max(0, 1 - best), rms };
    }

    // Step 4: parabolic interpolation on cmnd around the chosen tau.
    let tauRefined = tauChosen;
    if (tauChosen > this.tauMin && tauChosen < tauMax) {
      const s0 = cmnd[tauChosen - 1];
      const s1 = cmnd[tauChosen];
      const s2 = cmnd[tauChosen + 1];
      const denom = 2 * (2 * s1 - s2 - s0);
      if (denom !== 0) {
        const shift = (s2 - s0) / denom;
        if (shift > -1 && shift < 1) tauRefined = tauChosen + shift;
      }
    }

    const hz = this.sampleRate / tauRefined;
    if (!Number.isFinite(hz) || hz < MIN_HZ || hz > MAX_HZ) {
      return { hz: null, midi: null, clarity: 0, rms };
    }
    // Step 5: clarity
    const clarity = Math.min(1, Math.max(0, 1 - cmnd[tauChosen]));
    return { hz, midi: hzToMidi(hz), clarity, rms };
  }
}

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / A4);
}

export function midiToHz(midi: number): number {
  return A4 * Math.pow(2, (midi - 69) / 12);
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToNoteName(midi: number): string {
  const m = Math.round(midi);
  const name = NOTE_NAMES[((m % 12) + 12) % 12];
  const octave = Math.floor(m / 12) - 1;
  return `${name}${octave}`;
}

export function centsBetween(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0;
  return 1200 * Math.log2(a / b);
}

/** Median of a numeric array, ignoring non-finite values. */
export function medianOf(values: number[]): number {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return 0;
  const mid = clean.length >> 1;
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}
