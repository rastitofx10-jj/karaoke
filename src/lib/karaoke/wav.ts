/* TITO KARAOKE STUDIO v1.0 — WAV encode/decode + buffer mixing utilities
 * Pure client-side helpers: RIFF/WAVE PCM writer, decoder, mixdown, time strings.
 * Zero dependencies — every byte is written through DataView.
 * Browser-only: every Web Audio / DOM API access lives inside a function,
 * so importing this module during SSR build is inert.
 */

/* ---------- internal helpers ---------- */

/** Clamp a number into [lo, hi]. NaN falls through — callers guard it first. */
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Sanitize one sample: non-finite (NaN / ±Inf) becomes 0, then clamp to [-1, 1]. */
function cleanSample(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x > 1 ? 1 : x < -1 ? -1 : x;
}

/* ---------- encode ---------- */

/**
 * Encode planar float channels into a RIFF/WAVE PCM Blob (interleaved).
 *
 * - 16-bit: integer PCM (format tag 1), dither-free `round(x * 32767)`, clamped to int16.
 * - 24-bit: integer PCM (format tag 1), 3 bytes little-endian per sample.
 * - 32-bit: IEEE float (format tag 3) with the mandatory `fact` chunk.
 *
 * Channels of unequal length are padded with silence to the longest one.
 * Never throws on empty input: an empty `channels` array (or all-zero-length
 * arrays) yields a valid header-only (0 data bytes) WAV — 44 bytes for
 * 16/24-bit, 56 bytes for 32-bit float. A genuinely impossible size
 * (> 4 GB) throws a RangeError instead of emitting a corrupt file.
 *
 * @param channels Planar channel data, e.g. `[left, right]`.
 * @param sampleRate Samples per second; coerced to a positive integer (defaults 44100).
 * @param bitDepth 16, 24 or 32. Anything else at runtime falls back to 16.
 */
export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  bitDepth: 16 | 24 | 32 = 16
): Blob {
  const depth: 16 | 24 | 32 = bitDepth === 24 || bitDepth === 32 ? bitDepth : 16;
  const rate =
    Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 44100;
  const numChannels = Math.max(1, channels.length);

  // Longest channel defines the frame count; shorter ones pad with silence.
  let frames = 0;
  for (const ch of channels) {
    if (ch && ch.length > frames) frames = ch.length;
  }

  const bytesPerSample = depth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const isFloat = depth === 32;
  const factBytes = isFloat ? 12 : 0; // "fact" chunk (8 header + 4 payload)
  const headerBytes = 44 + factBytes;
  const totalBytes = headerBytes + dataBytes;

  if (totalBytes > 0xffffffff) {
    // RIFF sizes are 32-bit; refuse to emit a silently-truncated file.
    throw new RangeError(`encodeWav: result would exceed 4 GB (${totalBytes} bytes)`);
  }

  const buf = new ArrayBuffer(totalBytes);
  const view = new DataView(buf);
  let off = 0;

  const ascii = (s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off++, s.charCodeAt(i));
  };
  const u32 = (v: number): void => {
    view.setUint32(off, v, true);
    off += 4;
  };
  const u16 = (v: number): void => {
    view.setUint16(off, v, true);
    off += 2;
  };

  /* RIFF header */
  ascii('RIFF');
  u32(totalBytes - 8); // bytes after the RIFF size field
  ascii('WAVE');

  /* fmt chunk (16 bytes — same layout for PCM and IEEE float) */
  ascii('fmt ');
  u32(16); // chunk size
  u16(isFloat ? 3 : 1); // 1 = integer PCM, 3 = IEEE float
  u16(numChannels);
  u32(rate);
  u32(rate * blockAlign); // byte rate
  u16(blockAlign);
  u16(depth);

  /* fact chunk — required by spec for non-PCM formats (IEEE float) */
  if (isFloat) {
    ascii('fact');
    u32(4);
    u32(frames); // sample frames per channel
  }

  /* data chunk */
  ascii('data');
  u32(dataBytes);

  /* Interleave planar -> interleaved, one write loop per depth. */
  if (depth === 16) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numChannels; c++) {
        const src = channels[c];
        const x = cleanSample(src && i < src.length ? src[i] : 0);
        // Dither-free quantization: round to nearest, then hard int16 clamp.
        const s = clamp(Math.round(x * 32767), -32768, 32767);
        view.setInt16(off, s, true);
        off += 2;
      }
    }
  } else if (depth === 24) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numChannels; c++) {
        const src = channels[c];
        const x = cleanSample(src && i < src.length ? src[i] : 0);
        const s = clamp(Math.round(x * 8388607), -8388608, 8388607);
        // 24-bit little-endian via three byte writes (values fit int32).
        view.setUint8(off, s & 0xff);
        view.setUint8(off + 1, (s >> 8) & 0xff);
        view.setUint8(off + 2, (s >> 16) & 0xff);
        off += 3;
      }
    }
  } else {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numChannels; c++) {
        const src = channels[c];
        // IEEE float32 keeps full precision; no quantization, no clamp.
        const x = src && i < src.length ? src[i] : 0;
        view.setFloat32(off, Number.isFinite(x) ? x : 0, true);
        off += 4;
      }
    }
  }

  return new Blob([buf], { type: 'audio/wav' });
}

/**
 * Encode an AudioBuffer to WAV by extracting its channel Float32Arrays
 * and delegating to {@link encodeWav}.
 *
 * @param buffer Any AudioBuffer (decoded file, rendered take, ...).
 * @param bitDepth 16, 24 or 32 (32 = IEEE float).
 */
export function encodeWavFromBuffer(
  buffer: AudioBuffer,
  bitDepth: 16 | 24 | 32 = 16
): Blob {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }
  return encodeWav(channels, buffer.sampleRate, bitDepth);
}

/**
 * Alias of {@link encodeWavFromBuffer} — kept as a separate export for API
 * clarity at call sites that conceptually "render a buffer to a file".
 *
 * @param buffer AudioBuffer to serialize.
 * @param bitDepth 16 or 32 (32 = IEEE float).
 */
export function renderBufferToBlob(buffer: AudioBuffer, bitDepth: 16 | 32 = 16): Blob {
  return encodeWavFromBuffer(buffer, bitDepth);
}

/* ---------- decode ---------- */

/**
 * Decode encoded audio (WAV/MP3/etc.) into an AudioBuffer using a throwaway
 * AudioContext that is closed immediately after decoding — we decode before
 * the main engine context may exist, and closing avoids hitting the
 * browser's concurrent AudioContext limit.
 *
 * Note: `decodeAudioData` detaches (consumes) the passed ArrayBuffer.
 * Rejections (unsupported codec / corrupt data) propagate to the caller.
 *
 * @param data Raw encoded audio bytes.
 */
export async function decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = new AudioContext();
  try {
    return await ctx.decodeAudioData(data);
  } finally {
    // Close even on failure; a close() on an already-dead context just rejects,
    // which we swallow.
    void ctx.close().catch(() => undefined);
  }
}

/* ---------- mixing ---------- */

/**
 * Sum two AudioBuffers into a new one: `out[i] = a[i] + b[i] * bGain`,
 * clamped to [-1, 1].
 *
 * - Output length is `max(a.length, b.length)` (b's length expressed at a's
 *   rate when rates differ).
 * - Output sample rate is `a.sampleRate`. If `b.sampleRate` differs, b is
 *   resampled with a naive linear-interpolation loop (fine for the 1..8x
 *   rate spread of real-world files; works for any ratio without throwing).
 * - Channel count is `max(a, b)` channels (min 1). Mono sources are upmixed
 *   to every output channel; missing channels of a multi-channel source stay
 *   silent.
 *
 * @param a Base buffer (defines rate + length preference).
 * @param b Overlay buffer (e.g. the recorded vocal take).
 * @param bGain Linear gain applied to b before summing (default 1).
 * @param outCtx Context used to allocate the result buffer.
 */
export function mixToBuffer(
  a: AudioBuffer,
  b: AudioBuffer,
  bGain = 1,
  outCtx: BaseAudioContext
): AudioBuffer {
  const rate = a.sampleRate;
  const rateB = b.sampleRate;
  const needsResample = rateB !== rate;
  const ratio = rateB / rate; // position inside b per output frame
  // b's frame count re-expressed at a's sample rate.
  const framesBAtA = Math.max(1, Math.round(b.length * (rate / rateB)));
  const length = Math.max(a.length, framesBAtA);
  // createBuffer rejects 0 channels / 0 length / >32 channels — stay in range.
  const numChannels = clamp(Math.max(a.numberOfChannels, b.numberOfChannels, 1), 1, 32);

  const out = outCtx.createBuffer(numChannels, Math.max(1, length), rate);

  /** Channel c of buf with mono upmix: missing channels reuse channel 0. */
  const chan = (buf: AudioBuffer, c: number): Float32Array | null => {
    if (c < buf.numberOfChannels) return buf.getChannelData(c);
    if (buf.numberOfChannels === 1) return buf.getChannelData(0);
    return null; // multi-channel source simply has no data for this channel
  };

  for (let c = 0; c < numChannels; c++) {
    const A = chan(a, c);
    const B = chan(b, c);
    const dst = out.getChannelData(c);

    for (let i = 0; i < length; i++) {
      const va = A && i < A.length ? A[i] : 0;

      let vb = 0;
      if (B) {
        if (needsResample) {
          // Naive linear interpolation of b at position i * (rateB / rate).
          const pos = i * ratio;
          const i0 = Math.floor(pos);
          if (i0 < B.length) {
            const s0 = B[i0];
            // Hold the last sample at the tail (no zero-dip on the final
            // fractional frame).
            const s1 = i0 + 1 < B.length ? B[i0 + 1] : s0;
            vb = s0 + (s1 - s0) * (pos - i0);
          } // else: past the end of b -> silence
        } else {
          vb = i < B.length ? B[i] : 0;
        }
      }

      let v = va + vb * bGain;
      if (!Number.isFinite(v)) v = 0;
      dst[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
  }

  return out;
}

/* ---------- time strings ---------- */

/**
 * Format seconds as `m:ss` (or `m:ss.d` when `showMs` is true).
 * Negative, NaN and Infinity inputs are clamped to 0 — never NaN, never `60:00`.
 *
 * @param sec Seconds (fractional allowed).
 * @param showMs Append one decimal digit of tenths.
 */
export function formatTime(sec: number, showMs = false): string {
  const t = Number.isFinite(sec) && sec > 0 ? sec : 0;

  if (showMs) {
    // Work in integer tenths so 1:59.96 formats as "1:59.9", never "2:00.0".
    const tenths = Math.floor(t * 10);
    const m = Math.floor(tenths / 600);
    const rem = tenths - m * 600;
    const s = Math.floor(rem / 10);
    const d = rem % 10;
    return `${m}:${s < 10 ? '0' : ''}${s}.${d}`;
  }

  const total = Math.floor(t);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/**
 * Parse a human time string into seconds. Accepts `ss`, `ss.x`, `m:ss`,
 * `mm:ss.x` (seconds part must be 0–59). Whitespace is trimmed.
 * Returns 0 for anything else — never NaN, never negative.
 *
 * @param s The time string.
 */
export function parseTimeHuman(s: string): number {
  if (typeof s !== 'string') return 0;
  const str = s.trim();
  if (!str) return 0;

  const twoPart = /^(\d+):([0-5]?\d(?:\.\d+)?)$/;
  const onePart = /^\d+(?:\.\d+)?$/;

  const m = twoPart.exec(str);
  if (m) {
    const min = Number.parseInt(m[1], 10);
    const sec = Number.parseFloat(m[2]);
    return min * 60 + sec;
  }

  if (onePart.test(str)) {
    return Number.parseFloat(str);
  }

  return 0;
}
