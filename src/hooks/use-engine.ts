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
import type { DiscoverSong, HotSong, PrepareResult, YtCandidate } from '@/lib/karaoke/discover-types';
import { ytActivePlayer } from '@/lib/karaoke/yt';

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

/** Lyrics for a catalog song (never throws).
 *  mode 'full' — the full-song LRC, original timeline (YouTube playback).
 *  mode 'preview' — clip-timeline LRC via the AI preview sync (30s fallback). */
async function fetchPrepare(song: DiscoverSong, mode: 'full' | 'preview'): Promise<PrepareResult | null> {
  try {
    const qs = new URLSearchParams({
      trackId: String(song.trackId),
      artist: song.artist,
      title: song.title,
      album: song.album,
      durationMs: String(song.durationMs),
      mode,
    });
    if (mode === 'preview') qs.set('preview', song.previewUrl);
    const res = await fetch(`/api/discover/prepare?${qs.toString()}`);
    if (!res.ok) return null;
    return (await res.json()) as PrepareResult;
  } catch {
    return null;
  }
}

/** Ranked full-song YouTube candidates for a catalog song (never throws). */
async function fetchYtCandidates(song: DiscoverSong): Promise<YtCandidate[]> {
  try {
    const qs = new URLSearchParams({
      title: song.title,
      artist: song.artist,
      durationMs: String(Math.max(0, Math.round(song.durationMs)) || 0),
    });
    const res = await fetch(`/api/discover/youtube?${qs.toString()}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { candidates?: YtCandidate[] };
    return Array.isArray(data.candidates)
      ? data.candidates.filter((c) => c && typeof c.videoId === 'string' && c.videoId.length > 0)
      : [];
  } catch {
    return [];
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
        /* In YouTube mode the YT player owns the clock (pos/duration/playing);
         * the engine only feeds the mic + score channels. */
        if (st.ytActive) {
          st.patch({
            micLevel: s.micLevel,
            micPitchMidi: s.micPitchMidi,
            micPitchHz: s.micPitchHz,
            clarity: s.clarity,
            targetMidi: s.targetMidi,
            liveScore: s.liveScore,
            recording: s.recording,
            recSec: s.recSec,
          });
        } else {
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
          screen: 'studio',
          activeDiscover: null,
          ytActive: false,
          ytVideoId: null,
          ytCandidates: [],
          ytIndex: 0,
          ytResolving: false,
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
          screen: 'studio',
          activeDiscover: null,
          ytActive: false,
          ytVideoId: null,
          ytCandidates: [],
          ytIndex: 0,
          ytResolving: false,
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
    play() {
      const st = useKaraoke.getState();
      if (st.ytActive && ytActivePlayer.current) {
        ytActivePlayer.current.playVideo();
        useKaraoke.getState().patch({ playing: true });
        return;
      }
      void getEngine().play();
    },
    pause() {
      const st = useKaraoke.getState();
      if (st.ytActive && ytActivePlayer.current) {
        ytActivePlayer.current.pauseVideo();
        useKaraoke.getState().patch({ playing: false });
        return;
      }
      getEngine().pause();
    },
    toggle() {
      const st = useKaraoke.getState();
      if (st.ytActive) {
        if (st.playing) this.pause();
        else this.play();
        return;
      }
      const e = getEngine();
      if (e.playing) e.pause();
      else void e.play();
    },
    seek(t: number) {
      const st = useKaraoke.getState();
      if (st.ytActive && ytActivePlayer.current) {
        ytActivePlayer.current.seekTo(t, true);
        useKaraoke.getState().patch({ pos: t });
        return;
      }
      getEngine().seek(t);
    },
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
      try {
        const parsed: LrcSong = parseLyrics(raw, filename);
        const lines = withDerivedEnds(parsed.lines, e.duration);
        e.song.lyrics = lines;
        e.song.lrcRaw = raw;
        const st = useKaraoke.getState();
        st.patch({ song: st.song ? { ...st.song, hasLrc: lines.length > 0 } : null });
        void dbReady().then(() => updateSong(e.song!.id, { lrc: raw }));
      } catch (err) {
        /* A bad LRC payload must never silently kill the studio session —
         * this was the v2.0 path that left the stage empty. */
        console.warn('[karaoke] parseLyrics failed', err);
      }
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
        /* In full-song mode the YT player owns the music - never double-play
         * the 30s shell from the engine. */
        if (!e.playing && !useKaraoke.getState().ytActive) void e.play();
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
     * THE GOLDEN PATH (v3.1): full songs, full lyrics, zero friction.
     *   1. shell — the engine gets the 30s clip (library blob or Apple CDN)
     *      purely as a fallback surface + melody source;
     *   2. in parallel: full-song lyrics (LRCLIB, original timeline) and a
     *      ranked list of full-song YouTube sources;
     *   3. sources found → the full song plays through the YT iframe and the
     *      lyrics follow the same timeline — a real karaoke machine;
     *   4. a source is embed-blocked → the next candidate; all fail → the
     *      30s preview keeps playing with AI-synced lyrics (v2.0 behavior).
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
        /* v3.0: jump straight into the studio; remember the catalog song */
        screen: 'studio',
        activeDiscover: song,
        ytActive: false,
        ytVideoId: null,
        ytCandidates: [],
        ytIndex: 0,
        ytResolving: true,
        ytSource: 'auto',
      });

      /* all three in parallel: shell download, full lyrics, full-song sources */
      const prepFullPromise = fetchPrepare(song, 'full');
      const ytPromise = fetchYtCandidates(song);

      try {
        await this.ensureShell(song);
        void this.logPlay(song);

        /* the full song starts the moment sources are known — lyrics attach
         * while it is already playing (cold LRCLIB lookups can take seconds) */
        const yt = await ytPromise;
        if (yt.length > 0) {
          this.ytAutoStart(yt);
          this.applyPrepare(await prepFullPromise, 'full', song);
          return;
        }
        const prepFull = await prepFullPromise;
        await this.startPreviewWithLyrics(song, prepFull);
      } catch {
        useKaraoke.getState().patch({ syncState: 'none' });
        toast.error(t().error, { description: t().networkError });
      } finally {
        useKaraoke.getState().patch({ discoverBusyId: null, loadingFile: false, ytResolving: false });
      }
    },

    /** Put the 30s clip into the engine as the session shell: library blob
     * (instant, keeps the scanned melody) or a fresh CDN download. The engine
     * stays paused whenever the full song takes over. */
    async ensureShell(song: DiscoverSong) {
      const id = `itunes:${song.trackId}`;
      const e = getEngine();
      if (e.song?.id === id) return; // shell already loaded (re-select)

      const existing = await dbReady().then(() => getSong(id)).catch(() => null);
      let buffer: AudioBuffer;
      let file: File | null = null;
      if (existing) {
        buffer = await decodeAudioData(await existing.audio.arrayBuffer());
      } else {
        file = await fetchAudioFile(song);
        buffer = await decodeAudioData(await file.arrayBuffer());
      }
      const loaded = e.loadSong(id, song.title, buffer, {
        artist: song.artist,
        melody: existing?.melody,
      });
      useKaraoke.getState().patch({
        song: {
          id,
          title: song.title,
          artist: song.artist,
          durationSec: buffer.duration,
          hasLrc: false,
          hasMelody: Boolean(existing?.melody && existing.melody.notes.length > 0),
        },
        duration: buffer.duration,
        pos: 0,
        lastTake: null,
        peaks: loaded.peaks,
      });

      if (!existing && file) {
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
      }
    },

    /** 30s-preview fallback: play the clip, then attach clip-timeline lyrics
     * (AI preview sync). Plain lyrics when alignment fails. */
    async startPreviewWithLyrics(song: DiscoverSong, prepFull: PrepareResult | null) {
      const e = getEngine();
      e.ytPos = null;
      e.seek(0);
      void e.play();
      if (e.song && e.song.buffer.duration <= 45 && !(e.song.melody && e.song.melody.notes.length > 0)) {
        void this.autoScanMelody(e.song.id);
      }

      const prep = await fetchPrepare(song, 'preview');
      if (prep?.found) {
        this.applyPrepare(prep, 'preview', song);
      } else if (prepFull?.plainLyrics) {
        this.applyPrepare({ ...prepFull, lrc: null, synced: false }, 'preview', song);
      } else {
        this.applyPrepare(null, 'preview', song);
      }
    },

    /** Attach a prepare result to the live session - synced LRC, plain
     * lyrics, or a clear "no lyrics" state. One voice, one place. */
    applyPrepare(prep: PrepareResult | null, mode: 'full' | 'preview', song: DiscoverSong) {
      const e = getEngine();
      if (!e.song) return;
      const st = useKaraoke.getState();
      if (prep?.lrc) {
        const dur =
          mode === 'full'
            ? prep.fullDurationSec ?? (song.durationMs > 0 ? song.durationMs / 1000 : 0)
            : e.duration;
        this.setLyricsForDuration(prep.lrc, dur);
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
    },

    /** setLyricsRaw, but with an explicit duration for line-end derivation -
     * full-song lyrics must never be capped to the 30s shell duration. */
    setLyricsForDuration(raw: string, durationSec: number | null | undefined) {
      const e = getEngine();
      if (!e.song) return;
      try {
        const parsed: LrcSong = parseLyrics(raw, e.song.title);
        const dur = durationSec && durationSec > 0 ? durationSec : e.duration;
        e.song.lyrics = withDerivedEnds(parsed.lines, dur);
        e.song.lrcRaw = raw;
        const st = useKaraoke.getState();
        st.patch({ song: st.song ? { ...st.song, hasLrc: parsed.lines.length > 0 } : null });
        void dbReady().then(() => updateSong(e.song!.id, { lrc: raw }));
      } catch (err) {
        /* A bad LRC payload must never kill a live session. */
        console.warn('[karaoke] setLyricsForDuration parse failed', err);
      }
    },

    /** Re-derive lyric line ends against an authoritative duration (the YT
     * player reports the real full-song length a moment after it loads). */
    refreshLyricEnds(durationSec: number) {
      const e = getEngine();
      if (!e.song?.lrcRaw || !(durationSec > 0)) return;
      try {
        const parsed: LrcSong = parseLyrics(e.song.lrcRaw, e.song.title);
        if (parsed.lines.length > 0) e.song.lyrics = withDerivedEnds(parsed.lines, durationSec);
      } catch {
        /* never fatal */
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

    /* ------------------------------ v3.0 ------------------------------ */

    /* screens */
    setScreen(screen: 'home' | 'studio') {
      useKaraoke.getState().patch({ screen });
      if (screen === 'home') {
        /* leaving the studio stops the music - no surprise audio later */
        if (useKaraoke.getState().ytActive) this.setYt(null, { resumePreview: false });
        else this.pause();
      }
    },

    goHome() {
      this.setScreen('home');
    },

    /** Full-song YouTube mode on/off. null clears it (and optionally resumes
     * the 30s preview). `manual` marks a pasted link as the active source. */
    setYt(videoId: string | null, opts?: { resumePreview?: boolean; manual?: boolean }) {
      const e = getEngine();
      const resume = opts?.resumePreview ?? true;
      if (videoId) {
        e.pause();
        e.ytPos = 0;
        const st = useKaraoke.getState();
        useKaraoke.getState().patch({
          ytActive: true,
          ytVideoId: videoId,
          ytSource: opts?.manual ? 'manual' : st.ytSource,
          ytResolving: false,
          playing: true,
          pos: 0,
        });
      } else {
        e.ytPos = null;
        useKaraoke.getState().patch({
          ytActive: false,
          ytVideoId: null,
          ytCandidates: [],
          ytIndex: 0,
          ytResolving: false,
          playing: false,
        });
        if (e.song) {
          e.seek(0);
          if (resume) {
            useKaraoke.getState().patch({ peaks: e.song.peaks });
            void e.play();
          }
        }
      }
    },

    /** Start the full-song session with a ranked candidate list (auto mode). */
    ytAutoStart(candidates: YtCandidate[]) {
      if (candidates.length === 0) return;
      const e = getEngine();
      e.pause();
      e.ytPos = 0;
      useKaraoke.getState().patch({
        ytActive: true,
        ytVideoId: candidates[0].videoId,
        ytCandidates: candidates,
        ytIndex: 0,
        ytSource: 'auto',
        ytResolving: false,
        playing: true,
        pos: 0,
        /* preview peaks do not map to the full-song timeline */
        peaks: null,
      });
      toast.success(t().fullSongReady, { description: candidates[0].channel || candidates[0].title });
    },

    /** Advance to the next ranked full-song source. false when exhausted. */
    ytTryNext(): boolean {
      const st = useKaraoke.getState();
      const next = st.ytCandidates[st.ytIndex + 1];
      if (!next || !next.videoId) return false;
      useKaraoke.getState().patch({ ytVideoId: next.videoId, ytIndex: st.ytIndex + 1, playing: true, pos: 0 });
      toast.info(t().ytTryNext, { description: next.channel || next.title });
      return true;
    },

    /** Every auto-resolved source failed - fall back to the 30s preview with
     * clip-timeline lyrics so the stage is never empty. */
    async ytFailed() {
      const song = useKaraoke.getState().activeDiscover;
      toast.warning(t().ytAllFailed);
      this.setYt(null, { resumePreview: false });
      if (song) await this.startPreviewWithLyrics(song, null);
    },

    /** Re-fetch lyrics for the active catalog song (the "try again" button).
     * Full-song timeline while the YT session runs, clip timeline otherwise. */
    async retryLyrics() {
      const st = useKaraoke.getState();
      const song = st.activeDiscover;
      if (!song) return;
      st.patch({ syncState: 'syncing' });
      try {
        const mode = useKaraoke.getState().ytActive ? 'full' : 'preview';
        const prep = await fetchPrepare(song, mode);
        this.applyPrepare(prep, mode, song);
      } catch {
        useKaraoke.getState().patch({ syncState: 'none' });
        toast.error(t().networkError);
      }
    },

    /** Favorites — heart any catalog song, stored in localStorage. */
    isFavorite(id: string): boolean {
      return useKaraoke.getState().favorites.some((f) => f.id === id);
    },

    toggleFavorite(song: DiscoverSong) {
      const st = useKaraoke.getState();
      const exists = st.favorites.some((f) => f.id === song.id);
      const favorites = exists ? st.favorites.filter((f) => f.id !== song.id) : [song, ...st.favorites].slice(0, 60);
      useKaraoke.getState().patch({ favorites });
      setSetting('favorites', favorites);
      toast.success(exists ? t().removeFav : t().addFav, { description: `${song.artist} · ${song.title}` });
    },

    /** Copy a deep link that reopens this exact song in the studio. */
    async shareSong() {
      const song = useKaraoke.getState().activeDiscover;
      if (!song) return;
      try {
        const encoded = encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(song)))));
        const url = `${location.origin}${location.pathname}?song=${encoded}`;
        await navigator.clipboard.writeText(url);
        toast.success(t().shareCopied);
      } catch {
        toast.error(t().error);
      }
    },

    /** Silent background melody scan for short clips (scoring on by default). */
    async autoScanMelody(songId: string) {
      const e = getEngine();
      await new Promise((r) => setTimeout(r, 1500));
      if (!e.song || e.song.id !== songId) return;
      if (e.song.melody && e.song.melody.notes.length > 0) return;
      if (useKaraoke.getState().scanning) return;
      try {
        const track = await e.scanMelody();
        if (!track || track.notes.length === 0) return;
        const st = useKaraoke.getState();
        st.patch({ song: st.song && st.song.id === songId ? { ...st.song, hasMelody: true } : st.song });
        await dbReady();
        await updateSong(songId, { melody: track });
        actions.refreshLibrary();
        toast.success(t().autoScanDone);
      } catch {
        /* silent — scoring stays off, never breaks playback */
      }
    },

    loadPersistedState() {
      const l = getSetting<('he' | 'en')>('lang', 'he');
      const favorites = getSetting<DiscoverSong[]>('favorites', []);
      useKaraoke.getState().patch({
        lang: l,
        favorites: Array.isArray(favorites) ? favorites.filter((f) => f && f.id && f.previewUrl) : [],
      });
      actions.refreshLibrary();
      actions.refreshTakes();
    },
  };

  return actions;
}

export type KaraokeActions = ReturnType<typeof useKaraokeEngine>;
export type { ScoreResult, RankKey, LoadedSong };
