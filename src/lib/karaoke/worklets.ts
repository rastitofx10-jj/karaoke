/* TITO KARAOKE STUDIO v1.0 — AudioWorklet sources
 * Served as Blob URLs (self-contained, no static files, no CORS games).
 * Two processors:
 *  - pitch-shift: 2-tap granular delay-line pitch shifter (power-complementary
 *    sin²/cos² windows, linear-interpolated reads). Constant-sum crossfade,
 *    ~43 ms grain, real-time key transposition without speed change.
 *  - recorder: passthrough tap that accumulates frames and posts them to
 *    the main thread in transferable chunks.
 */

export const PITCH_SHIFT_WORKLET = /* js */ `
class PitchShiftProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }
    ];
  }
  constructor() {
    super();
    this.W = Math.max(512, Math.min(8192, Math.round(sampleRate * 0.043)));
    this.N = this.W * 4;
    this.bufs = [];
    this.write = 0;
    this.phase = 0;
  }
  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;
    if (!input || !input.length) return true;
    const ratio = params.ratio[0];
    const bypass = Math.abs(ratio - 1) < 1e-4;
    const W = this.W;
    const N = this.N;
    const chCount = output.length;
    while (this.bufs.length < chCount) this.bufs.push(new Float32Array(N));
    const frame = output[0].length;
    const TWO_PI_P = Math.PI;
    for (let i = 0; i < frame; i++) {
      const w = this.write;
      // write every channel's sample at the shared pointer
      for (let c = 0; c < chCount; c++) {
        const inCh = input[c % input.length];
        this.bufs[c][w] = inCh ? inCh[i] : 0;
      }
      if (bypass) {
        for (let c = 0; c < chCount; c++) output[c][i] = this.bufs[c][w];
      } else {
        // advance grain phase: negative drift when shifting up
        this.phase += (1 - ratio) / W;
        this.phase -= Math.floor(this.phase);
        const p1 = this.phase;
        const p2 = (this.phase + 0.5) % 1;
        const d1 = p1 * W;
        const d2 = p2 * W;
        const s1 = Math.sin(TWO_PI_P * p1);
        const s2 = Math.sin(TWO_PI_P * p2);
        for (let c = 0; c < chCount; c++) {
          const buf = this.bufs[c];
          output[c][i] =
            this.read(buf, w - d1) * s1 * s1 +
            this.read(buf, w - d2) * s2 * s2;
        }
      }
      this.write = (w + 1) % N;
    }
    return true;
  }
  read(buf, pos) {
    const N = this.N;
    let p = pos % N;
    if (p < 0) p += N;
    const i0 = Math.floor(p);
    const frac = p - i0;
    const i1 = (i0 + 1) % N;
    return buf[i0] * (1 - frac) + buf[i1] * frac;
  }
}
registerProcessor('pitch-shift', PitchShiftProcessor);
`;

export const RECORDER_WORKLET = /* js */ `
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.recording = false;
    this.blockCount = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === 'start') {
        this.chunks = [];
        this.recording = true;
        this.blockCount = 0;
      } else if (e.data.type === 'stop') {
        this.flush(true);
        this.recording = false;
      }
    };
  }
  flush(final) {
    if (!this.chunks.length) {
      if (final) this.port.postMessage({ type: 'data', final: true, channels: [] });
      return;
    }
    const channelCount = this.chunks[0].length;
    const total = this.chunks.reduce((n, chs) => n + chs[0].length, 0);
    const out = [];
    for (let c = 0; c < channelCount; c++) {
      const arr = new Float32Array(total);
      let off = 0;
      for (const chs of this.chunks) {
        arr.set(chs[c], off);
        off += chs[c].length;
      }
      out.push(arr);
    }
    this.port.postMessage(
      { type: 'data', final: !!final, channels: out },
      out.map((a) => a.buffer)
    );
    this.chunks = [];
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    // passthrough
    if (output && input && input.length) {
      for (let c = 0; c < output.length; c++) {
        const inCh = input[c % input.length];
        const outCh = output[c];
        if (inCh) for (let i = 0; i < outCh.length; i++) outCh[i] = inCh[i];
      }
    }
    if (this.recording && input && input.length) {
      const copy = [];
      for (let c = 0; c < input.length; c++) {
        const ch = input[c];
        copy.push(ch ? new Float32Array(ch) : new Float32Array(128));
      }
      this.chunks.push(copy);
      if (++this.blockCount % 40 === 0) this.flush(false);
    }
    return true;
  }
}
registerProcessor('recorder', RecorderProcessor);
`;
