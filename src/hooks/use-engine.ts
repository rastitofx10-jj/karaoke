'use client';

/* TITO KARAOKE STUDIO v1.0 — React binding for the audio engine.
 * One engine instance, one rAF loop feeding the store, typed actions.
 */

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { KaraokeEngine, type LoadedSong } from '@/lib/karaoke/engine';
import { decodeAudioData } from '@/lib/karaoke/wav';
import { parseLyrics, serializeLrc, withDerivedEnds } from '@/lib/karaoke/lrc';
import {
  dbReady, deleteSong, deleteTake, getSong, getTake, listSongs, listTakes,
  makeId, saveSong, saveTake, updateSong, getSetting, setSetting,
} from '@/lib/karaoke/storage';
import { useKaraoke } from '@/store/karaoke';
import { DICTS } from '@/lib/karaoke/i18n';
import type { LrcSong, RankKey, ScoreResult, TakeMeta, VocalMode } from '@/lib/karaoke/types';

let engine: KaraokeEngine | null = null;
export function getEngine(): KaraokeEngine {
  if (!engine) engine = new KaraokeEngine();
  return engine;
}

/* debug handle for live inspection (devtools / e2e) */
if (typeof window !== 'undefined') {
  (window as unknown as { __karaoke?: unknown }).__karaoke = {
    get engine() {
      return engine;
    },
    get store() {
      return useKaraoke.getState();
    },
  };
}

const lang = () => useKaraoke.getState().lang;
const t = () => DICTS[lang()];

export function useKaraokeEngine() {
  const rafRef = useRef<number>(0);

  /* ------------------------- the rAF heartbeat ------------------------- */
  useEffect(() => {
    const loop = () => {
      const e = getEngine();
      if (e.ready) {
        const s = e.tick();
        const st = useKaraoke.getState();
        st.patch({
          playing: s.playing,
          pos: s.pos,
          duration: s.duration,
          songLevel: s.songLevel,
          micLevel: s.micLevel,
          micPitchMidi: s.micPitchMidi,
          micPitchHz: s.micPitchHz,
          clarity: s.clarity,
          targetMidi: s.targetMidi,
          liveScore: s.liveScore,
          recording: s.recording,
          recSec: s.recSec,
        });
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  /* song natural end → auto-finish take */
  useEffect(() => {
    const e = getEngine();
    e.onEnded = async () => {
      const st = useKaraoke.getState();
      st.patch({ playing: false });
      if (e.singing) {
        await actions.stopRecording();
      }
    };
    return () => {
      e.onEnded = null;
    };
     
  }, []);

  const actions = {
    /* ------------------------------ power ----------------------------- */
    async powerOn() {
      try {
        await getEngine().powerOn();
        useKaraoke.getState().patch({ powered: true });
      } catch {
        toast.error(t().error, { description: 'AudioContext' });
      }
    },

    async powerOff() {
      await getEngine().powerOff();
      useKaraoke.getState().patch({ powered: false, playing: false, micActive: false });
    },

    toggleLang() {
      const next = lang() === 'he' ? 'en' : 'he';
      setSetting('lang', next);
      useKaraoke.getState().patch({ lang: next });
    },

    /* ------------------------------ song ------------------------------ */
    async loadAudioFile(file: File) {
      const st = useKaraoke.getState();
      if (!st.powered) await this.powerOn();
      st.patch({ loadingFile: true });
      try {
        const data = await file.arrayBuffer();
        const buffer = await decodeAudioData(data);
        const title = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
        const e = getEngine();
        const loaded = e.loadSong(makeId(), title, buffer);
        useKaraoke.getState().patch({
          song: {
            id: loaded.id, title: loaded.title, artist: loaded.artist,
            durationSec: buffer.duration, hasLrc: loaded.lyrics.length > 0,
            hasMelody: false,
          },
          duration: buffer.duration,
          pos: 0,
          loadingFile: false,
          lastTake: null,
          peaks: loaded.peaks,
        });
        // persist to the library
        await dbReady();
        const saved = await saveSong({
          id: loaded.id,
          title: loaded.title,
          artist: loaded.artist,
          createdAt: Date.now(),
          durationSec: buffer.duration,
          hasLrc: loaded.lyrics.length > 0,
          hasMelody: false,
          sizeBytes: file.size,
          audio: file.slice(0, file.size, file.type || 'audio/mpeg'),
        });
        if (saved) actions.refreshLibrary();
        toast.success(title, { description: t().dropAudio });
      } catch {
        useKaraoke.getState().patch({ loadingFile: false });
        toast.error(t().error, { description: file.name });
      }
    },

    async loadFromLibrary(id: string) {
      const st = useKaraoke.getState();
      if (!st.powered) await this.powerOn();
      const rec = await getSong(id);
      if (!rec) return;
      try {
        const data = await rec.audio.arrayBuffer();
        const buffer = await decodeAudioData(data);
        const e = getEngine();
        e.loadSong(rec.id, rec.title, buffer, {
          artist: rec.artist,
          lrcRaw: rec.lrc,
          melody: rec.melody,
        });
        useKaraoke.getState().patch({
          song: {
            id: rec.id, title: rec.title, artist: rec.artist,
            durationSec: buffer.duration, hasLrc: !!rec.lrc,
            hasMelody: !!rec.melody,
          },
          duration: buffer.duration,
          pos: 0,
          libOpen: false,
          lastTake: null,
          peaks: e.song?.peaks ?? null,
        });
      } catch {
        toast.error(t().error, { description: rec.title });
      }
    },

    async deleteSongFromLibrary(id: string) {
      await deleteSong(id);
      actions.refreshLibrary();
      actions.refreshTakes();
    },

    async refreshLibrary() {
      if (await dbReady()) {
        useKaraoke.getState().patch({ songs: await listSongs() });
      }
    },

    async refreshTakes(songId?: string) {
      if (await dbReady()) {
        useKaraoke.getState().patch({ takes: await listTakes(songId) });
      }
    },

    /* --------------------------- transport ---------------------------- */
    play() { void getEngine().play(); },
    pause() { getEngine().pause(); },
    toggle() {
      const e = getEngine();
      if (e.playing) e.pause();
      else void e.play();
    },
    seek(t: number) { getEngine().seek(t); },
    setLoopA() {
      const e = getEngine();
      e.setLoop(e.pos, e.loopB);
      useKaraoke.getState().patch({ loopA: e.loopA });
    },
    setLoopB() {
      const e = getEngine();
      e.setLoop(e.loopA, e.pos);
      useKaraoke.getState().patch({ loopB: e.loopB });
    },
    clearLoop() {
      getEngine().setLoop(null, null);
      useKaraoke.getState().patch({ loopA: null, loopB: null });
    },

    /* -------------------------- vocal engine -------------------------- */
    setMode(mode: VocalMode, amount?: number) {
      const e = getEngine();
      e.setMode(mode, amount ?? e.amount);
      useKaraoke.getState().patch({ mode, amount: e.amount });
    },
    setAmount(amount: number) {
      getEngine().setAmount(amount);
      useKaraoke.getState().patch({ amount });
    },
    setKey(semi: number) {
      getEngine().setKey(semi);
      useKaraoke.getState().patch({ keySemitones: semi });
    },
    setSpeed(speed: number, preserve: boolean) {
      getEngine().setSpeed(speed, preserve);
      useKaraoke.getState().patch({ speed, preservePitch: preserve });
    },
    setSongVolume(v: number) {
      getEngine().setSongVolume(v);
      useKaraoke.getState().patch({ songVolume: v });
    },

    /* ------------------------------- mic ------------------------------ */
    async enableMic() {
      const st = useKaraoke.getState();
      if (!st.powered) await this.powerOn();
      const ok = await getEngine().enableMic();
      useKaraoke.getState().patch({ micActive: ok });
      if (!ok) toast.error(t().micDenied);
      return ok;
    },
    disableMic() {
      getEngine().disableMic();
      useKaraoke.getState().patch({ micActive: false });
    },
    async toggleMic() {
      if (useKaraoke.getState().micActive) this.disableMic();
      else await this.enableMic();
    },
    setFx(patch: Parameters<KaraokeEngine['setFx']>[0]) {
      getEngine().setFx(patch);
      useKaraoke.getState().setFx(patch);
    },
    applyPreset(name: 'dry' | 'tight' | 'hall' | 'big' | 'duet') {
      const fx =
        name === 'dry' ? { gate: true, compressor: false, reverb: 0, echo: 0, lowDb: 0, midDb: 0, highDb: 0 } :
        name === 'tight' ? { gate: true, compressor: true, reverb: 0.08, reverbPreset: 'room' as const, echo: 0, lowDb: 0, midDb: 1.5, highDb: 2 } :
        name === 'hall' ? { gate: true, compressor: true, reverb: 0.2, reverbPreset: 'hall' as const, echo: 0, lowDb: 0, midDb: 0, highDb: 1.5 } :
        name === 'big' ? { gate: true, compressor: true, reverb: 0.32, reverbPreset: 'stadium' as const, echo: 0.12, echoTimeMs: 320, lowDb: -1, midDb: 0.5, highDb: 2 } :
        { gate: true, compressor: true, reverb: 0.14, reverbPreset: 'stage' as const, echo: 0.28, echoTimeMs: 210, lowDb: 0, midDb: 1, highDb: 1.5 };
      this.setFx(fx);
    },

    /* -------------------------- melody scan --------------------------- */
    async scanMelody() {
      const e = getEngine();
      if (!e.song) return;
      useKaraoke.getState().patch({ scanning: true, scanProgress: 0 });
      try {
        const wasPlaying = e.playing;
        if (wasPlaying) e.pause();
        const track = await e.scanMelody((p) => {
          useKaraoke.getState().patch({ scanProgress: p });
        });
        useKaraoke.getState().patch({ scanning: false, scanProgress: 1 });
        if (track) {
          if (track.notes.length === 0) {
            toast.warning(t().melodyScan, { description: t().scanEmpty });
          } else {
            toast.success(t().melodyScan, {
              description: t().scanDone.replace('{n}', String(track.notes.length)),
            });
          }
          const st = useKaraoke.getState();
          st.patch({
            song: st.song ? { ...st.song, hasMelody: track.notes.length > 0 } : null,
          });
          await dbReady();
          await updateSong(e.song.id, { melody: track });
          actions.refreshLibrary();
        }
        if (wasPlaying) void e.play();
      } catch {
        useKaraoke.getState().patch({ scanning: false });
        toast.error(t().melodyScan);
      }
    },

    /* ----------------------------- lyrics ----------------------------- */
    setLyricsRaw(raw: string, filename?: string) {
      const e = getEngine();
      if (!e.song) return;
      const parsed: LrcSong = parseLyrics(raw, filename);
      const lines = withDerivedEnds(parsed.lines, e.duration);
      e.song.lyrics = lines;
      e.song.lrcRaw = raw;
      const st = useKaraoke.getState();
      st.patch({ song: st.song ? { ...st.song, hasLrc: lines.length > 0 } : null });
      void dbReady().then(() => updateSong(e.song!.id, { lrc: raw }));
    },
    exportLrc(): string | null {
      const e = getEngine();
      if (!e.song?.lrcRaw) return null;
      return e.song.lrcRaw;
    },
    serializeCurrent(): string {
      const e = getEngine();
      if (!e.song) return '';
      return serializeLrc({
        title: e.song.title,
        artist: e.song.artist,
        lines: e.song.lyrics,
      });
    },

    /* ---------------------------- recording --------------------------- */
    startRecording() {
      const e = getEngine();
      if (!e.ready || !e.song) return;
      if (e.startRecording()) {
        useKaraoke.getState().patch({ recording: true, lastTake: null, resultsOpen: false });
        if (!e.playing) void e.play();
      }
    },

    async stopRecording() {
      const e = getEngine();
      const take = await e.stopRecording();
      useKaraoke.getState().patch({ recording: false });
      if (!take) return;
      const result = take.summary.result;
      useKaraoke.getState().patch({
        lastTake: { wav: take.wav, durationSec: take.durationSec, score: result },
        resultsOpen: true,
      });
    },

    toggleRecording() {
      if (useKaraoke.getState().recording) void this.stopRecording();
      else this.startRecording();
    },

    async saveCurrentTake() {
      const st = useKaraoke.getState();
      const e = getEngine();
      if (!st.lastTake || !e.song) return;
      const meta: TakeMeta = {
        id: makeId(),
        songId: e.song.id,
        songTitle: e.song.title,
        createdAt: Date.now(),
        durationSec: st.lastTake.durationSec,
        score: st.lastTake.score.overall,
        rank: st.lastTake.score.rank,
      };
      await dbReady();
      const ok = await saveTake({ ...meta, wav: st.lastTake.wav });
      if (ok) {
        toast.success(t().recorder, { description: t().saved });
        actions.refreshTakes();
      }
    },

    async deleteTakeById(id: string) {
      await deleteTake(id);
      actions.refreshTakes();
    },

    async playTake(id: string) {
      const take = await getTake(id);
      if (!take) return;
      const url = URL.createObjectURL(take.wav);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      void audio.play();
    },

    downloadTake() {
      const st = useKaraoke.getState();
      if (!st.lastTake) return;
      const url = URL.createObjectURL(st.lastTake.wav);
      const a = document.createElement('a');
      a.href = url;
      a.download = `take-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.wav`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    },

    loadPersistedState() {
      const l = getSetting<('he' | 'en')>('lang', 'he');
      useKaraoke.getState().patch({ lang: l });
      actions.refreshLibrary();
      actions.refreshTakes();
    },
  };

  return actions;
}

export type KaraokeActions = ReturnType<typeof useKaraokeEngine>;
export type { ScoreResult, RankKey, LoadedSong };
