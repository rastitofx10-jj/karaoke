/* TITO KARAOKE STUDIO v1.0 — the audio engine
 * One class owns the whole Web Audio graph:
 *
 *   song source ─► splitter ─► center/side buses ─► vocal cancel / isolate mix
 *                          └─► original                    │
 *                                                        ▼
 *                                              pitch-shift worklet (key)
 *                                                        │
 *                                            song gain ─► song analyser ─► master
 *                                                        │
 *   mic ─► HPF ─► pitch tap ─► gate ─► EQ ─► comp ─► dry/verb/echo ─► mic bus
 *                                                        │                │
 *                                                        │            monitor ─► master
 *                                                        ▼
 *                                            mix bus (song + mic) ─► recorder tap
 *
 * Playback position is tracked against ctx.currentTime so speed changes,
 * seeks and the A-B loop stay exact. Mic pitch is detected pre-FX (reverb
 * would poison YIN) and scored against the scanned melody.
 */

import type { LrcLine, LrcSong, MelodyNote, MelodyTrack, MicFx, ScoreFrame, TakeSummary, VocalMode } from './types';
import { MIC_FX_DEFAULT } from './types';
import { PITCH_SHIFT_WORKLET, RECORDER_WORKLET } from './worklets';
import { YinDetector } from './pitch';
import { scanMelody, melodyAt } from './melody';
import { scoreFrames, rollingScore } from './scoring';
import { parseLyrics, withDerivedEnds } from './lrc';
import { encodeWavFromBuffer } from './wav';
import type { ScoreResult } from './types';

export interface EngineSnapshot {
  playing: boolean;
  /** song position, seconds (buffer timeline) */
  pos: number;
  duration: number;
  songLevel: number; // 0..1
  micLevel: number; // 0..1
  micPitchHz: number | null;
  micPitchMidi: number | null;
  micPitchName: string | null;
  clarity: number;
  targetMidi: number | null;
  liveScore: ScoreResult | null;
  recording: boolean;
  recSec: number;
}

export interface LoadedSong {
  id: string;
  title: string;
  artist?: string;
  buffer: AudioBuffer;
  peaks: Float32Array;
  lyrics: LrcLine[];
  lrcRaw?: string;
  melody?: MelodyTrack;
}

export interface TakeData {
  wav: Blob;
  durationSec: number;
  summary: TakeSummary;
}

const PEAK_BUCKETS = 1400;
const ROLLING_WINDOW = 12;

function semitonesToRatio(semi: number): number {
  return Math.pow(2, semi / 12);
}

function makeBlobUrl(src: string): string {
  return URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
}

/** Reverb impulse: stereo exponentially-decaying noise with predelay. */
function makeIR(ctx: BaseAudioContext, seconds: number, decay: number, predelayMs: number): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const pre = Math.floor((ctx.sampleRate * predelayMs) / 1000);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < len; i++) {
      if (i < pre) {
        d[i] = 0;
        continue;
      }
      const t = (i - pre) / (len - pre);
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
    }
  }
  return ir;
}

export class KaraokeEngine {
  ctx: AudioContext | null = null;
  ready = false;

  /* song */
  song: LoadedSong | null = null;
  private src: AudioBufferSourceNode | null = null;
  private startPos = 0;
  private startCtx = 0;
  playing = false;
  private ended = false;
  speed = 1;
  preservePitch = true;
  keySemitones = 0;
  loopA: number | null = null;
  loopB: number | null = null;

  /* vocal engine */
  mode: VocalMode = 'off';
  amount = 0.85;
  songVolume = 1;

  /* mic */
  micActive = false;
  private micStream: MediaStream | null = null;
  fx: MicFx = { ...MIC_FX_DEFAULT };

  /* scoring */
  singing = false;
  scoreFrames: ScoreFrame[] = [];
  private lastSungMidi: number | null = null;

  /* recording */
  private recChunks: Float32Array[][] = [];
  private recStartWall = 0;
  private recChannels = 2;
  private recResolve: (() => void) | null = null;

  /* graph nodes */
  private nodes: Record<string, AudioNode> = {};
  private shifter: AudioWorkletNode | null = null;
  private recNode: AudioWorkletNode | null = null;
  private workletUrls: string[] = [];
  private micDetector: YinDetector | null = null;
  private micBuf = new Float32Array(2048);
  private micLevelBuf = new Float32Array(1024);
  private songBuf = new Float32Array(2048);
  private tickCount = 0;
  private lastGateOpen = 0;

  onEnded: (() => void) | null = null;

  /* ------------------------------------------------------------- power */

  async powerOn(): Promise<void> {
    if (this.ready && this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;

    // worklets from blob URLs
    const url1 = makeBlobUrl(PITCH_SHIFT_WORKLET);
    const url2 = makeBlobUrl(RECORDER_WORKLET);
    this.workletUrls.push(url1, url2);
    await ctx.audioWorklet.addModule(url1);
    await ctx.audioWorklet.addModule(url2);
    this.buildGraph();
    this.ready = true;
    if (ctx.state === 'suspended') await ctx.resume();
  }

  private buildGraph(): void {
    const ctx = this.ctx as AudioContext;

    /* ---- song chain ---- */
    const songIn = ctx.createGain();
    const splitter = ctx.createChannelSplitter(2);

    // center = (L+R)/2
    const cL = ctx.createGain(); cL.gain.value = 0.5;
    const cR = ctx.createGain(); cR.gain.value = 0.5;
    const center = ctx.createGain();
    // side = L - R
    const sL = ctx.createGain(); sL.gain.value = 1;
    const sR = ctx.createGain(); sR.gain.value = -1;
    const side = ctx.createGain();

    songIn.connect(splitter);
    splitter.connect(cL, 0); splitter.connect(cR, 1);
    cL.connect(center); cR.connect(center);
    splitter.connect(sL, 0); splitter.connect(sR, 1);
    sL.connect(side); sR.connect(side);

    // karaoke bus: side + centered bass kept
    const sideHP = ctx.createBiquadFilter();
    sideHP.type = 'highpass'; sideHP.frequency.value = 90; sideHP.Q.value = 0.5;
    const centerLP = ctx.createBiquadFilter();
    centerLP.type = 'lowpass'; centerLP.frequency.value = 150; centerLP.Q.value = 0.5;
    const karaoke = ctx.createGain();
    side.connect(sideHP); sideHP.connect(karaoke);
    center.connect(centerLP); centerLP.connect(karaoke);

    // isolate bus: vocal band of the center
    const isoHP = ctx.createBiquadFilter();
    isoHP.type = 'highpass'; isoHP.frequency.value = 220; isoHP.Q.value = 0.6;
    const isoLP = ctx.createBiquadFilter();
    isoLP.type = 'lowpass'; isoLP.frequency.value = 4200; isoLP.Q.value = 0.6;
    const isoPeak = ctx.createBiquadFilter();
    isoPeak.type = 'peaking'; isoPeak.frequency.value = 2600; isoPeak.Q.value = 0.9;
    isoPeak.gain.value = 5;
    const isoOut = ctx.createGain();
    center.connect(isoHP); isoHP.connect(isoLP); isoLP.connect(isoPeak); isoPeak.connect(isoOut);

    // mode mix
    const origGain = ctx.createGain();
    const karGain = ctx.createGain();
    const isoGain = ctx.createGain();
    karGain.gain.value = 0;
    isoGain.gain.value = 0;
    songIn.connect(origGain);
    karaoke.connect(karGain);
    isoOut.connect(isoGain);
    const vocalMix = ctx.createGain();
    origGain.connect(vocalMix);
    karGain.connect(vocalMix);
    isoGain.connect(vocalMix);

    // pitch shift worklet
    const shifter = new AudioWorkletNode(ctx, 'pitch-shift', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    vocalMix.connect(shifter);

    const songGain = ctx.createGain();
    const songAnalyser = ctx.createAnalyser();
    songAnalyser.fftSize = 2048;
    songAnalyser.smoothingTimeConstant = 0.75;
    shifter.connect(songGain);
    songGain.connect(songAnalyser);
    songAnalyser.connect(ctx.destination);

    /* ---- master ---- */
    const master = ctx.createGain();
    master.connect(ctx.destination);

    /* ---- mic chain ---- */
    const micHP = ctx.createBiquadFilter();
    micHP.type = 'highpass'; micHP.frequency.value = 75; micHP.Q.value = 0.6;
    const pitchTap = ctx.createAnalyser();
    pitchTap.fftSize = 2048;
    micHP.connect(pitchTap);
    const gate = ctx.createGain();
    gate.gain.value = 0;
    pitchTap.connect(gate);
    const eqLow = ctx.createBiquadFilter();
    eqLow.type = 'lowshelf'; eqLow.frequency.value = 220;
    const eqMid = ctx.createBiquadFilter();
    eqMid.type = 'peaking'; eqMid.frequency.value = 1100; eqMid.Q.value = 0.9;
    const eqHigh = ctx.createBiquadFilter();
    eqHigh.type = 'highshelf'; eqHigh.frequency.value = 3600;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -22; comp.knee.value = 18;
    comp.ratio.value = 3.5; comp.attack.value = 0.006; comp.release.value = 0.18;
    gate.connect(eqLow); eqLow.connect(eqMid); eqMid.connect(eqHigh); eqHigh.connect(comp);

    const micDry = ctx.createGain();
    const verbSend = ctx.createGain(); verbSend.gain.value = 0;
    const verb = ctx.createConvolver();
    const verbWet = ctx.createGain();
    const echoSend = ctx.createGain(); echoSend.gain.value = 0;
    const echoDelay = ctx.createDelay(1.2);
    const echoFb = ctx.createGain(); echoFb.gain.value = 0.32;
    const echoWet = ctx.createGain();
    comp.connect(micDry);
    comp.connect(verbSend); verbSend.connect(verb); verb.connect(verbWet);
    comp.connect(echoSend); echoSend.connect(echoDelay);
    echoDelay.connect(echoFb); echoFb.connect(echoDelay);
    echoDelay.connect(echoWet);

    const micBus = ctx.createGain();
    micDry.connect(micBus); verbWet.connect(micBus); echoWet.connect(micBus);
    const micAnalyser = ctx.createAnalyser();
    micAnalyser.fftSize = 1024;
    micAnalyser.smoothingTimeConstant = 0.6;
    micBus.connect(micAnalyser);
    const micOut = ctx.createGain();
    micAnalyser.connect(micOut);
    // monitoring (speakers!) — only when explicitly enabled
    const monitor = ctx.createGain(); monitor.gain.value = 0;
    micOut.connect(monitor); monitor.connect(master);

    /* ---- mix bus + recorder tap ---- */
    const mixBus = ctx.createGain();
    songAnalyser.connect(mixBus);
    micOut.connect(mixBus);
    const recNode = new AudioWorkletNode(ctx, 'recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    mixBus.connect(recNode);
    const recSink = ctx.createGain(); recSink.gain.value = 0;
    recNode.connect(recSink); recSink.connect(ctx.destination);
    recNode.port.onmessage = (e) => {
      if (e.data?.type === 'data' && Array.isArray(e.data.channels)) {
        this.recChunks.push(e.data.channels as Float32Array[]);
        if (e.data.final && this.recResolve) {
          const r = this.recResolve;
          this.recResolve = null;
          r();
        }
      }
    };

    /* ---- spectrum analyser for the visualizer (song side) ---- */
    const vizAnalyser = ctx.createAnalyser();
    vizAnalyser.fftSize = 2048;
    vizAnalyser.smoothingTimeConstant = 0.8;
    songAnalyser.connect(vizAnalyser);

    this.nodes = {
      songIn, splitter, center, side, karaoke, isoOut, origGain, karGain, isoGain,
      vocalMix, songGain, songAnalyser, master, micHP, pitchTap, gate, eqLow, eqMid,
      eqHigh, comp, micDry, verbSend, verb, verbWet, echoSend, echoDelay, echoFb,
      echoWet, micBus, micAnalyser, micOut, monitor, mixBus, recSink, vizAnalyser,
    };
    this.shifter = shifter;
    this.recNode = recNode;
    this.micDetector = new YinDetector(ctx.sampleRate, 2048);
    this.applyMode();
    this.applyShift();
    this.applyFx();
  }

  async powerOff(): Promise<void> {
    this.pause();
    this.disableMic();
    if (this.ctx) {
      await this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
    this.ready = false;
    this.workletUrls.forEach((u) => URL.revokeObjectURL(u));
    this.workletUrls = [];
    this.nodes = {};
    this.shifter = null;
    this.recNode = null;
  }

  /* ------------------------------------------------------------ song */

  static computePeaks(buffer: AudioBuffer, buckets = PEAK_BUCKETS): Float32Array {
    const out = new Float32Array(buckets);
    const chs: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(buffer.getChannelData(c));
    const per = Math.max(1, Math.floor(buffer.length / buckets));
    for (let b = 0; b < buckets; b++) {
      const start = b * per;
      const end = Math.min(buffer.length, start + per);
      let peak = 0;
      for (let i = start; i < end; i += 2) {
        for (const ch of chs) {
          const v = Math.abs(ch[i]);
          if (v > peak) peak = v;
        }
      }
      out[b] = peak;
    }
    return out;
  }

  loadSong(
    id: string,
    title: string,
    buffer: AudioBuffer,
    opts?: { artist?: string; lrcRaw?: string; melody?: MelodyTrack },
  ): LoadedSong {
    this.stopSource();
    this.playing = false;
    this.startPos = 0;
    this.ended = false;
    const parsed: LrcSong = opts?.lrcRaw
      ? parseLyrics(opts.lrcRaw, title)
      : { lines: [] };
    const lines = withDerivedEnds(parsed.lines, buffer.duration);
    const loaded: LoadedSong = {
      id,
      title,
      artist: opts?.artist,
      buffer,
      peaks: KaraokeEngine.computePeaks(buffer),
      lyrics: lines,
      lrcRaw: opts?.lrcRaw,
      melody: opts?.melody,
    };
    this.song = loaded;
    this.scoreFrames = [];
    return loaded;
  }

  get duration(): number {
    return this.song?.buffer.duration ?? 0;
  }

  get pos(): number {
    if (!this.ctx) return this.startPos;
    if (!this.playing) return this.startPos;
    return this.startPos + (this.ctx.currentTime - this.startCtx) * this.speed;
  }

  private stopSource(): void {
    if (this.src) {
      try {
        this.src.onended = null;
        this.src.stop();
      } catch {
        /* already stopped */
      }
      this.src.disconnect();
      this.src = null;
    }
  }

  private spawnSource(offset: number): void {
    const ctx = this.ctx;
    const song = this.song;
    if (!ctx || !song || !this.ready) return;
    this.stopSource();
    const src = ctx.createBufferSource();
    src.buffer = song.buffer;
    src.playbackRate.value = this.speed;
    src.connect(this.nodes.songIn);
    const when = ctx.currentTime + 0.02;
    const off = Math.max(0, Math.min(offset, song.buffer.duration - 0.01));
    src.start(when, off);
    src.onended = () => {
      if (this.src === src && this.playing) {
        // natural end only when we didn't stop/seek ourselves
        const p = this.pos;
        if (p >= song.buffer.duration - 0.25) {
          this.playing = false;
          this.startPos = song.buffer.duration;
          this.ended = true;
          this.onEnded?.();
        }
      }
    };
    this.src = src;
    this.startPos = off;
    this.startCtx = when;
  }

  async play(): Promise<void> {
    if (!this.ctx || !this.song) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (this.ended) {
      this.startPos = 0;
      this.ended = false;
      this.scoreFrames = [];
    }
    this.spawnSource(this.pos);
    this.playing = true;
  }

  pause(): void {
    if (!this.playing) return;
    const p = this.pos;
    this.playing = false;
    this.stopSource();
    this.startPos = p;
  }

  seek(t: number): void {
    const clamped = Math.max(0, Math.min(t, this.duration));
    if (this.playing) {
      this.spawnSource(clamped);
    } else {
      this.startPos = clamped;
      this.ended = false;
    }
    this.scoreFrames = [];
  }

  setSpeed(speed: number, preservePitch = this.preservePitch): void {
    const p = this.pos;
    this.speed = Math.max(0.5, Math.min(1.5, speed));
    this.preservePitch = preservePitch;
    if (this.playing) {
      this.startPos = p;
      this.startCtx = (this.ctx as AudioContext).currentTime;
      if (this.src) this.src.playbackRate.value = this.speed;
    }
    this.applyShift();
  }

  setKey(semi: number): void {
    this.keySemitones = Math.max(-12, Math.min(12, Math.round(semi)));
    this.applyShift();
  }

  /** total pitch shift = key change, minus speed-induced shift when preserving */
  private applyShift(): void {
    if (!this.shifter) return;
    const speedShift = this.preservePitch ? 12 * Math.log2(this.speed) : 0;
    const total = this.keySemitones - speedShift;
    const ratio = semitonesToRatio(total);
    const params = this.shifter.parameters.get('ratio');
    if (params) params.value = ratio;
  }

  setLoop(a: number | null, b: number | null): void {
    this.loopA = a;
    this.loopB = b;
  }

  setSongVolume(v: number): void {
    this.songVolume = Math.max(0, Math.min(1.5, v));
    const g = this.nodes.songGain as GainNode | undefined;
    if (g && this.ctx) g.gain.setTargetAtTime(this.songVolume, this.ctx.currentTime, 0.02);
  }

  /* ------------------------------------------------------ vocal engine */

  setMode(mode: VocalMode, amount = this.amount): void {
    this.mode = mode;
    this.amount = Math.max(0, Math.min(1, amount));
    this.applyMode();
  }

  private applyMode(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const { origGain, karGain, isoGain } = this.nodes as {
      origGain: GainNode; karGain: GainNode; isoGain: GainNode;
    };
    const w = this.amount;
    const set = (n: GainNode, v: number) => n.gain.setTargetAtTime(v, t, 0.03);
    if (this.mode === 'off') {
      set(origGain, 1); set(karGain, 0); set(isoGain, 0);
    } else if (this.mode === 'karaoke') {
      set(origGain, 1 - w); set(karGain, w * 1.25); set(isoGain, 0);
    } else {
      set(origGain, 1 - w); set(isoGain, w * 1.6); set(karGain, 0);
    }
  }

  setAmount(amount: number): void {
    this.amount = Math.max(0, Math.min(1, amount));
    this.applyMode();
  }

  /* -------------------------------------------------------------- mic */

  async enableMic(): Promise<boolean> {
    if (!this.ctx || this.micActive) return this.micActive;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        return false;
      }
    }
    this.micStream = stream;
    const ctx = this.ctx;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(this.nodes.micHP as AudioNode);
    this.nodes.micSource = source;
    this.micActive = true;
    this.applyFx();
    return true;
  }

  disableMic(): void {
    if (this.nodes.micSource) {
      this.nodes.micSource.disconnect();
      delete this.nodes.micSource;
    }
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.micActive = false;
  }

  setFx(fx: Partial<MicFx>): void {
    this.fx = { ...this.fx, ...fx };
    this.applyFx();
  }

  private applyFx(): void {
    if (!this.ctx || !this.nodes.micHP) return;
    const t = this.ctx.currentTime;
    const fx = this.fx;
    const n = this.nodes as Record<string, AudioNode & { gain?: AudioParam; frequency?: AudioParam }>;
    (n.eqLow as BiquadFilterNode).gain.setTargetAtTime(fx.lowDb, t, 0.03);
    (n.eqMid as BiquadFilterNode).gain.setTargetAtTime(fx.midDb, t, 0.03);
    (n.eqHigh as BiquadFilterNode).gain.setTargetAtTime(fx.highDb, t, 0.03);
    (n.verbSend as GainNode).gain.setTargetAtTime(fx.reverb * 0.9, t, 0.05);
    (n.verbWet as GainNode).gain.setTargetAtTime(0.9, t, 0.05);
    (n.echoSend as GainNode).gain.setTargetAtTime(fx.echo * 0.7, t, 0.05);
    (n.echoDelay as DelayNode).delayTime.setTargetAtTime(fx.echoTimeMs / 1000, t, 0.1);
    (n.micOut as GainNode).gain.setTargetAtTime(Math.pow(10, fx.micGainDb / 20), t, 0.03);
    (n.monitor as GainNode).gain.setTargetAtTime(fx.monitor ? 1 : 0, t, 0.03);
    if (n.verb) {
      const table: Record<MicFx['reverbPreset'], [number, number, number]> = {
        room: [0.7, 4.5, 12],
        hall: [1.9, 3.2, 22],
        stage: [2.8, 2.6, 32],
        stadium: [4.2, 2.1, 45],
      };
      const [sec, decay, pre] = table[fx.reverbPreset];
      (n.verb as ConvolverNode).buffer = makeIR(this.ctx, sec, decay, pre);
    }
    if (!fx.gate) {
      (n.gate as GainNode).gain.setTargetAtTime(1, t, 0.01);
    }
  }

  /* --------------------------------------------------------- scanning */

  /** Offline render of the vocal-isolated center, then melody scan. */
  async scanMelody(
    onProgress?: (p: number) => void,
  ): Promise<MelodyTrack | null> {
    const song = this.song;
    if (!song) return null;
    const buf = song.buffer;
    const off = new OfflineAudioContext(1, buf.length, buf.sampleRate);
    const src = off.createBufferSource();
    src.buffer = buf;
    const hp = off.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 220; hp.Q.value = 0.6;
    const lp = off.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 4200; lp.Q.value = 0.6;
    const peak = off.createBiquadFilter();
    peak.type = 'peaking'; peak.frequency.value = 2600; peak.Q.value = 0.9;
    peak.gain.value = 5;
    src.connect(hp); hp.connect(lp); lp.connect(peak); peak.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    onProgress?.(0.08);

    // chunked scan so the UI keeps breathing
    const data = rendered.getChannelData(0);
    const segSec = 20;
    const segLen = Math.floor(segSec * rendered.sampleRate);
    const notes: MelodyNote[] = [];
    let minMidi = Infinity;
    let maxMidi = -Infinity;
    let done = 0;
    for (let s = 0; s < data.length; s += segLen) {
      const slice = data.subarray(s, Math.min(data.length, s + segLen));
      const track = scanMelody(slice, rendered.sampleRate, (p) =>
        onProgress?.(0.08 + 0.92 * ((done + p * slice.length) / data.length)),
      );
      for (const n of track.notes) {
        n.t += s / rendered.sampleRate;
        n.end += s / rendered.sampleRate;
        notes.push(n);
        if (n.midi < minMidi) minMidi = n.midi;
        if (n.midi > maxMidi) maxMidi = n.midi;
      }
      done += slice.length;
      onProgress?.(0.08 + 0.92 * (done / data.length));
      // yield to the event loop between segments
      await new Promise((r) => setTimeout(r, 0));
    }
    // merge boundary notes (same pitch, tiny gap)
    const merged: MelodyNote[] = [];
    for (const n of notes) {
      const prev = merged[merged.length - 1];
      if (prev && Math.abs(prev.midi - n.midi) < 0.35 && n.t - prev.end < 0.12) {
        prev.end = n.end;
      } else {
        merged.push(n);
      }
    }
    if (!merged.length) return { notes: [], minMidi: 48, maxMidi: 72, duration: buf.duration };
    song.melody = {
      notes: merged,
      minMidi: Math.floor(minMidi),
      maxMidi: Math.ceil(maxMidi),
      duration: buf.duration,
    };
    return song.melody;
  }

  /* -------------------------------------------------------- recording */

  startRecording(): boolean {
    if (!this.recNode) return false;
    this.recChunks = [];
    this.recStartWall = performance.now();
    this.recNode.port.postMessage({ type: 'start' });
    this.singing = true;
    this.scoreFrames = [];
    return true;
  }

  async stopRecording(): Promise<TakeData | null> {
    if (!this.recNode) return null;
    this.recNode.port.postMessage({ type: 'stop' });
    this.singing = false;
    const durationSec = (performance.now() - this.recStartWall) / 1000;
    // the worklet posts the final chunk asynchronously — wait for it
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      this.recResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.recResolve = null;
    const channels: Float32Array[][] = this.recChunks;
    this.recChunks = [];
    return this.takeFromBuffers(channels, durationSec);
  }

  private takeFromBuffers(chunks: Float32Array[][], durationSec: number): TakeData | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const summary: TakeSummary = {
      startedAt: Date.now() - durationSec * 1000,
      endedAt: Date.now(),
      frames: this.scoreFrames.slice(),
      result: scoreFrames(this.scoreFrames),
    };
    if (!chunks.length || !chunks[0].length) {
      return { wav: new Blob(), durationSec, summary };
    }
    const chCount = Math.max(...chunks.map((c) => c.length));
    const total = chunks.reduce((n, c) => n + c[0].length, 0);
    const buffer = ctx.createBuffer(chCount, Math.max(1, total), ctx.sampleRate);
    for (let c = 0; c < chCount; c++) {
      const out = buffer.getChannelData(c);
      let off = 0;
      for (const chs of chunks) {
        const src = chs[Math.min(c, chs.length - 1)];
        out.set(src, off);
        off += src.length;
      }
    }
    return { wav: encodeWavFromBuffer(buffer, 16), durationSec, summary };
  }

  /* ------------------------------------------------------------- tick */

  /** Call from a rAF loop. Returns the live snapshot + drives gate/loop. */
  tick(): EngineSnapshot {
    const ctx = this.ctx;
    const dur = this.duration;
    let pos = this.pos;
    const snap: EngineSnapshot = {
      playing: this.playing,
      pos,
      duration: dur,
      songLevel: 0,
      micLevel: 0,
      micPitchHz: null,
      micPitchMidi: null,
      micPitchName: null,
      clarity: 0,
      targetMidi: null,
      liveScore: null,
      recording: this.singing,
      recSec: this.singing ? (performance.now() - this.recStartWall) / 1000 : 0,
    };
    if (!ctx) return snap;
    this.tickCount++;

    /* A-B loop enforcement */
    if (this.playing && this.loopB !== null && pos >= this.loopB) {
      this.seek(this.loopA ?? 0);
      pos = this.loopA ?? 0;
    }

    /* song level */
    if (this.tickCount % 2 === 0) {
      const sa = this.nodes.songAnalyser as AnalyserNode;
      sa.getFloatTimeDomainData(this.songBuf);
      let sum = 0;
      for (let i = 0; i < this.songBuf.length; i++) sum += this.songBuf[i] * this.songBuf[i];
      snap.songLevel = Math.min(1, Math.sqrt(sum / this.songBuf.length) * 2.6);
    }

    /* mic pitch (pre-FX) + gate + level */
    if (this.micActive && this.micDetector) {
      const pt = this.nodes.pitchTap as AnalyserNode;
      pt.getFloatTimeDomainData(this.micBuf);
      const det = this.micDetector.detect(this.micBuf);
      const gate = this.nodes.gate as GainNode;
      const open = !this.fx.gate || det.rms > Math.pow(10, this.fx.gateThresholdDb / 20);
      const target = open ? 1 : 0;
      // hold the gate open briefly so word gaps don't chop
      if (open) this.lastGateOpen = ctx.currentTime;
      const hold = open || ctx.currentTime - this.lastGateOpen < 0.18;
      gate.gain.setTargetAtTime(hold ? target : 0, ctx.currentTime, open ? 0.005 : 0.05);
      const ma = this.nodes.micAnalyser as AnalyserNode;
      if (this.tickCount % 2 === 0) {
        ma.getFloatTimeDomainData(this.micLevelBuf);
        let sum = 0;
        for (let i = 0; i < this.micLevelBuf.length; i++) sum += this.micLevelBuf[i] * this.micLevelBuf[i];
        snap.micLevel = Math.min(1, Math.sqrt(sum / this.micLevelBuf.length) * 2.6);
      }
      if (det.hz !== null) {
        snap.micPitchHz = det.hz;
        snap.micPitchMidi = det.midi;
        snap.clarity = det.clarity;
      }
      this.lastSungMidi = det.midi;

      /* scoring against melody (key transposition applied inline) */
      if (this.playing && this.singing && this.song) {
        const track = this.song.melody;
        const comp = this.micLatencySec();
        const tSong = Math.max(0, pos - comp);
        let targetMidi: number | null = null;
        if (track) {
          const note = melodyAt(track, tSong);
          targetMidi = note ? note.midi + this.keySemitones : null;
        }
        const sung = det.hz !== null && det.rms > 0.004 ? det.midi : null;
        const cents =
          targetMidi !== null && sung !== null
            ? (sung - targetMidi) * 100
            : null;
        snap.targetMidi = targetMidi;
        const frame: ScoreFrame = { t: tSong, targetMidi, sungMidi: sung, centsOff: cents };
        this.scoreFrames.push(frame);
        snap.liveScore = rollingScore(this.scoreFrames, ROLLING_WINDOW, tSong);
      } else if (this.playing && this.song?.melody) {
        const comp = this.micLatencySec();
        const note = melodyAt(this.song.melody, Math.max(0, pos - comp));
        snap.targetMidi = note ? note.midi + this.keySemitones : null;
      }
    }
    return snap;
  }

  /** rough input+output latency estimate used to align sung frames to the song */
  micLatencySec(): number {
    const ctx = this.ctx;
    if (!ctx) return 0.08;
    const base = ctx.baseLatency || 0;
    const out = (ctx as AudioContext & { outputLatency?: number }).outputLatency || 0;
    return Math.min(0.4, Math.max(0.03, base + out + 0.02));
  }

  /** spectrum for the visualizer */
  spectrum(out: Uint8Array<ArrayBuffer>): void {
    const viz = this.nodes.vizAnalyser as AnalyserNode | undefined;
    if (viz) viz.getByteFrequencyData(out);
  }

  finalScore(): ScoreResult | null {
    return this.scoreFrames.length ? scoreFrames(this.scoreFrames) : null;
  }

  resetScore(): void {
    this.scoreFrames = [];
  }
}
