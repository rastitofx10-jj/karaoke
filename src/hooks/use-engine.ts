'use client';

/* TITO KARAOKE STUDIO v2.0 — React binding for the audio engine.
 * One engine instance, one rAF loop feeding the store, typed actions.
 * v2.0 adds the DISCOVER actions: instant song search (iTunes catalog via
 * /api/discover/*), streaming preview clips into the engine, and AI-synced
 * lyrics (LRCLIB + ASR preview alignment) attached as plain LRC.
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
import type { DiscoverSong, HotSong, PrepareResult } from '@/lib/karaoke/discover-types';

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

/* ---------- discover helpers (module level, browser only) ---------- */

/** Download an official preview clip through our same-origin proxy. */
async function fetchAudioFile(song: DiscoverSong): Promise<File> {
  const res = await fetch(`/api/discover/audio?preview=${encodeURIComponent(song.previewUrl)}`);
  if (!res.ok) throw new Error('audio download failed');
  const type = res.headers.get('content-type') ?? 'audio/mp4';
  const buf = await res.arrayBuffer();
  const safeName = `${song.artist} - ${song.title}`.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80).trim();
  return new File([buf], `${safeName || 'song'}.m4a`, {
    type: type.startsWith('audio') ? type : 'audio/mp4',
  });
}

/** Lyrics + AI preview offset for a catalog song (never throws). */
async function fetchPrepare(song: DiscoverSong): Promise<PrepareResult | null> {
  try {
    const qs = new URLSearchParams({
      trackId: String(song.trackId),
      artist: song.artist,
      title: song.title,
      album: song.album,
      durationMs: String(song.durationMs),
      preview: song.previewUrl,
    });
    const res = await fetch(`/api/discover/prepare?${qs.toString()}`);
    if (!res.ok) return null;
    return (await res.json()) as PrepareResult;
  } catch {
    return null;
  }
}

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
      st.patch({ loadingFile: true, syncState: 'idle' });
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
        useKaraoke.getState().patch({ syncState: 'idle' });
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

    /* --------------------------- discover ---------------------------- */

    /** Debounced catalog search — the panel owns the debounce, this fires. */
    async searchDiscover(q: string) {
      const trimmed = q.trim();
      const st = useKaraoke.getState();
      if (trimmed.length < 2) {
        st.patch({ discoverResults: [], discoverLoading: false });
        return;
      }
      st.patch({ discoverLoading: true, discoverError: null });
      try {
        const res = await fetch(`/api/discover/search?q=${encodeURIComponent(trimmed)}&lang=${lang()}`);
        if (!res.ok) throw new Error('http');
        const data = (await res.json()) as { songs: DiscoverSong[] };
        const cur = useKaraoke.getState();
        if (cur.discoverQuery.trim() !== trimmed) return; // stale response
        cur.patch({ discoverResults: data.songs ?? [], discoverLoading: false, discoverError: null });
        if ((data.songs ?? []).length > 0) {
          const recents = [trimmed, ...cur.recentSearches.filter((r) => r !== trimmed)].slice(0, 6);
          cur.patch({ recentSearches: recents });
          setSetting('recentSearches', recents);
        }
      } catch {
        const cur = useKaraoke.getState();
        if (cur.discoverQuery.trim() === trimmed) {
          cur.patch({ discoverLoading: false, discoverError: 'network' });
        }
      }
    },

    loadRecentSearches() {
      const r = getSetting<string[]>('recentSearches', []);
      useKaraoke.getState().patch({ recentSearches: Array.isArray(r) ? r.slice(0, 6) : [] });
    },

    async loadTrending() {
      try {
        const res = await fetch(`/api/discover/charts?lang=${lang()}`);
        const data = (await res.json()) as { songs: DiscoverSong[] };
        useKaraoke.getState().patch({ trending: Array.isArray(data.songs) ? data.songs : [] });
      } catch {
        /* silent — trending is a bonus */
      }
    },

    async loadHot() {
      try {
        const res = await fetch('/api/discover/plays');
        const data = (await res.json()) as { songs: HotSong[] };
        useKaraoke.getState().patch({ hot: Array.isArray(data.songs) ? data.songs.slice(0, 6) : [] });
      } catch {
        /* silent */
      }
    },

    async logPlay(song: DiscoverSong) {
      try {
        await fetch('/api/discover/plays', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(song),
        });
      } catch {
        /* silent — counters never break playback */
      }
    },

    /**
     * The golden path: stream a catalog song into the engine.
     * Library fast-path (instant + offline) → cold download; audio starts
     * as soon as it's decoded, AI-synced lyrics attach when ready.
     */
    async loadDiscoverSong(song: DiscoverSong) {
      const st0 = useKaraoke.getState();
      if (!st0.powered) await this.powerOn();
      const id = `itunes:${song.trackId}`;
      if (useKaraoke.getState().discoverBusyId === song.id) return;
      useKaraoke.getState().patch({
        discoverBusyId: song.id,
        loadingFile: true,
        syncState: 'syncing',
        resultsOpen: false,
      });

      const applyLyrics = (prep: PrepareResult | null): void => {
        const eng = getEngine();
        if (!eng.song || eng.song.id !== id) return; // user switched songs meanwhile
        const st = useKaraoke.getState();
        if (prep?.lrc) {
          this.setLyricsRaw(prep.lrc); // updates store hasLrc + persists to library
          st.patch({ syncState: 'synced' });
          toast.success(t().syncDone, { description: `${song.artist} · ${song.title}` });
        } else if (prep?.plainLyrics) {
          this.setLyricsRaw(prep.plainLyrics);
          st.patch({ syncState: 'plain' });
          toast.info(t().syncPlain, { description: `${song.artist} · ${song.title}` });
        } else {
          st.patch({ syncState: 'none' });
          toast.warning(t().syncNone, { description: `${song.artist} · ${song.title}` });
        }
      };

      try {
        // 1. library fast-path — instant, works offline
        const existing = await dbReady().then(() => getSong(id)).catch(() => null);
        if (existing) {
          await this.loadFromLibrary(id);
          useKaraoke.getState().patch({ discoverBusyId: null, loadingFile: false });
          void getEngine().play();
          void this.logPlay(song);
          if (existing.lrc) {
            useKaraoke.getState().patch({ syncState: 'synced' });
            toast.success(t().syncDone, { description: `${song.artist} · ${song.title}` });
            return;
          }
          applyLyrics(await fetchPrepare(song));
          return;
        }

        // 2. cold path — download + decode, prepare lyrics in parallel
        const file = await fetchAudioFile(song);
        const prepPromise = fetchPrepare(song);
        const data = await file.arrayBuffer();
        const buffer = await decodeAudioData(data);
        const e = getEngine();
        const loaded = e.loadSong(id, song.title, buffer, { artist: song.artist });
        useKaraoke.getState().patch({
          song: {
            id,
            title: song.title,
            artist: song.artist,
            durationSec: buffer.duration,
            hasLrc: false,
            hasMelody: false,
          },
          duration: buffer.duration,
          pos: 0,
          loadingFile: false,
          lastTake: null,
          peaks: loaded.peaks,
          discoverBusyId: null,
          syncState: 'syncing',
        });
        await dbReady();
        const saved = await saveSong({
          id,
          title: song.title,
          artist: song.artist,
          createdAt: Date.now(),
          durationSec: buffer.duration,
          hasLrc: false,
          hasMelody: false,
          sizeBytes: file.size,
          audio: file,
        });
        if (saved) actions.refreshLibrary();
        void e.play();
        void this.logPlay(song);

        // lyrics arrive while the song is already playing
        applyLyrics(await prepPromise);
      } catch {
        useKaraoke.getState().patch({
          discoverBusyId: null,
          loadingFile: false,
          syncState: 'none',
        });
        toast.error(t().error, { description: t().networkError });
      }
    },

    /** Live lyric sync adjustment (seconds) for the loaded song. */
    nudgeSync(delta: number) {
      const e = getEngine();
      if (!e.song || e.song.lyrics.length === 0) return;
      const shift = (x: number) => Math.max(0, x + delta);
      const lines = e.song.lyrics.map((l) => ({
        ...l,
        time: shift(l.time),
        end: l.end != null ? l.end + delta : undefined,
        words: Array.isArray(l.words)
          ? l.words.map((w) => ({ ...w, t: shift(w.t), end: w.end != null ? w.end + delta : undefined }))
          : undefined,
      }));
      const raw = serializeLrc({ title: e.song.title, artist: e.song.artist, lines });
      e.song.lyrics = lines;
      e.song.lrcRaw = raw;
      void dbReady().then(() => updateSong(e.song!.id, { lrc: raw }));
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
