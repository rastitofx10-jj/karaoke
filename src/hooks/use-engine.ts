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
import type { DiscoverSong, FullSource, HotSong, PrepareResult, YtCandidate } from '@/lib/karaoke/discover-types';
import { ytActivePlayer, ytStallFails } from '@/lib/karaoke/yt';

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
 *  mode 'full' — the full-song LRC, original timeline (full-song playback).
 *  mode 'preview' — clip-timeline LRC via the AI preview sync (30s fallback).
 *  v5.0 — standalone provider rows carry LRCLIB hints parsed from their
 *  cover titles (lrcTitle/lrcArtist); they win over the raw display name. */
async function fetchPrepare(song: DiscoverSong, mode: 'full' | 'preview'): Promise<PrepareResult | null> {
  try {
    const qs = new URLSearchParams({
      trackId: String(song.trackId),
      artist: song.lrcArtist ?? song.artist,
      title: song.lrcTitle ?? song.title,
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

/** Ranked full-song YouTube candidates for a catalog song (never throws).
 *  variant 'original' — the song as released · 'karaoke' — backing tracks.
 *  fresh skips the server cache (used by the explicit "try again"). */
async function fetchYtCandidates(
  song: DiscoverSong,
  variant: 'original' | 'karaoke' = 'original',
  fresh = false,
): Promise<YtCandidate[]> {
  try {
    const qs = new URLSearchParams({
      title: song.title,
      artist: song.artist,
      durationMs: String(Math.max(0, Math.round(song.durationMs)) || 0),
      variant,
    });
    if (fresh) qs.set('fresh', '1');
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

/** v5.0 — fresh full-length sources (SoundCloud/Audius) for a catalog song,
 *  resolved server-side at load time (never throws). */
async function fetchFullSongSources(song: DiscoverSong): Promise<FullSource[]> {
  try {
    const qs = new URLSearchParams({
      artist: song.artist,
      title: song.title,
      durationMs: String(Math.max(0, Math.round(song.durationMs)) || 0),
    });
    const res = await fetch(`/api/discover/fullsong?${qs.toString()}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { sources?: FullSource[] };
    return Array.isArray(data.sources)
      ? data.sources.filter(
          (s) => s && (s.provider === 'soundcloud' || s.provider === 'audius') && s.id && s.durationMs >= 60_000,
        )
      : [];
  } catch {
    return [];
  }
}

/** v5.0 — download + decode one full-length source into a Web Audio buffer.
 *  The raw bytes are an fMP4 concat (SoundCloud HLS) or mp3 (Audius); when
 *  the browser's decoder rejects the raw container, one retry with a
 *  server-side ffmpeg transcode settles it. Total: never throws. */
async function fetchFullAudioBuffer(source: FullSource): Promise<AudioBuffer | null> {
  const base = `/api/discover/fullstream?p=${source.provider === 'soundcloud' ? 'sc' : 'au'}&id=${encodeURIComponent(source.id)}`;
  let buf: ArrayBuffer | null = null;
  try {
    const res = await fetch(base);
    if (res.ok) buf = await res.arrayBuffer();
  } catch {
    buf = null;
  }
  if (!buf || buf.byteLength < 250_000) return null;
  try {
    return await decodeAudioData(buf);
  } catch {
    /* container the browser can't decode → ffmpeg fallback (mp3) */
  }
  try {
    const res2 = await fetch(`${base}&transcode=1`);
    if (!res2.ok) return null;
    const buf2 = await res2.arrayBuffer();
    if (buf2.byteLength < 250_000) return null;
    return await decodeAudioData(buf2);
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
          fullActive: false,
          fullResolving: false,
          fullId: null,
          fullProvider: null,
          fullChannel: null,
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
          fullActive: false,
          fullResolving: false,
          fullId: null,
          fullProvider: null,
          fullChannel: null,
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
        /* plain lyrics ride along — a song without a synced timeline still
         * gets its words on the stage as a static list */
        e.song.plainLines =
          lines.length === 0
            ? parsed.lines.filter((l) => !(Number.isFinite(l.time) && l.time >= 0))
            : [];
        e.song.lrcRaw = raw;
        const st = useKaraoke.getState();
        st.patch({ song: st.song ? { ...st.song, hasLrc: parsed.lines.length > 0 } : null });
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
     * THE GOLDEN PATH (v5.0): REAL FULL SONGS, ALWAYS FIRST.
     *   1. in parallel: full-length sources (search-time list, or a fresh
     *      server resolve), full-song lyrics (LRCLIB) and the YouTube
     *      candidate list (kept warm as tier 2);
     *   2. full sources found → the best one downloads + decodes into Web
     *      Audio THE MOMENT it lands — the whole karaoke machine (vocal
     *      removal, key shift, speed, scoring) runs on the FULL song;
     *   3. no full source / every download failed → the YouTube flow
     *      (probe gate → direct audio), then the 30s preview shell —
     *      each fallback labeled honestly.
     * The 30s shell is LAZY: it only downloads when the preview fallback
     * needs it, so a playing full song is never replaced mid-flight.
     */
    async loadDiscoverSong(song: DiscoverSong) {
      const st0 = useKaraoke.getState();
      if (!st0.powered) await this.powerOn();
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
        ytProbing: false,
        ytSource: 'auto',
        ytVariant: 'original',
        directActive: false,
        directResolving: false,
        directVideoId: null,
        directChannel: null,
        fullActive: false,
        fullResolving: true,
        fullId: null,
        fullProvider: null,
        fullChannel: null,
        fullFailReason: 'none',
      });

      /* tier 1 — full-length sources: the search-time list, or a fresh
       * server resolve when this row arrived before v5.0 / via a share */
      const fullSourcesP =
        song.fullSources && song.fullSources.length > 0
          ? Promise.resolve(song.fullSources.slice(0, 3))
          : fetchFullSongSources(song);
      /* full-timeline lyrics — they attach the moment a full song owns the clock */
      const prepFullPromise = fetchPrepare(song, 'full');
      /* tier 2 — YouTube candidates kept warm (probe gate runs only if tier 1 fails) */
      const ytPromise = fetchYtCandidates(song, useKaraoke.getState().ytVariant);
      /* the 30s shell is LAZY — started only when a fallback needs it */
      let shellStarted: Promise<void> | null = null;
      const ensureShellOnce = (): Promise<void> => {
        if (!shellStarted) shellStarted = this.ensureShell(song).catch(() => undefined);
        return shellStarted;
      };

      try {
        /* ---------- TIER 1: the full-length song, decoded into the engine */
        const sources = await fullSourcesP;
        if (sources.length > 0 && (await this.tryFullAudio(song, sources))) {
          void this.logPlay(song);
          this.applyPrepare(await prepFullPromise, 'full', song);
          return;
        }

        /* ---------- TIER 2: YouTube embeds (probe gate → direct audio) */
        const yt = await ytPromise;
        if (yt.length > 0) {
          this.ytAutoStart(yt);
          void this.logPlay(song);
          const shellLoaded = async (): Promise<boolean> => {
            await ensureShellOnce();
            return getEngine().song?.id === `itunes:${song.trackId}`;
          };
          if (await shellLoaded()) {
            this.applyPrepare(await prepFullPromise, 'full', song);
          } else {
            useKaraoke.getState().patch({ syncState: 'none' });
            toast.warning(t().syncNone, { description: t().networkError });
          }
          return;
        }

        /* ---------- TIER 3: honestly-labeled 30s preview */
        useKaraoke.getState().patch({ fullFailReason: 'no-sources' });
        const shellOk = await ensureShellOnce().then(
          () => getEngine().song?.id === `itunes:${song.trackId}`,
        );
        if (shellOk) {
          void this.logPlay(song);
          await this.startPreviewWithLyrics(song, await prepFullPromise);
        } else {
          useKaraoke.getState().patch({ syncState: 'none' });
          toast.error(t().error, { description: t().networkError });
        }
      } catch {
        useKaraoke.getState().patch({ syncState: 'none' });
        toast.error(t().error, { description: t().networkError });
      } finally {
        useKaraoke.getState().patch({ discoverBusyId: null, loadingFile: false, ytResolving: false });
      }
    },

    /**
     * v5.0 — TIER 1: download + decode a full-length source (SoundCloud /
     * Audius) and load it into the engine as a REAL full-length AudioBuffer.
     * The Web Audio graph owns the clock: vocal removal, key shift, speed,
     * melody scan, scoring and recording all run on the FULL song. Tries
     * sources in rank order; returns true when a full song now owns the
     * clock. Total: never throws, never leaves partial state.
     */
    async tryFullAudio(song: DiscoverSong, sources: FullSource[]): Promise<boolean> {
      for (const src of sources.slice(0, 3)) {
        if (useKaraoke.getState().activeDiscover?.id !== song.id) return false; // session moved on
        useKaraoke.getState().patch({ fullResolving: true });
        try {
          const audio = await fetchFullAudioBuffer(src);
          /* a REAL full song or nothing — 30s junk never owns the clock */
          if (!audio || audio.duration < 60) continue;
          if (useKaraoke.getState().activeDiscover?.id !== song.id) return false;

          const e = getEngine();
          e.ytPos = null;
          const id = `${src.provider === 'soundcloud' ? 'sc' : 'au'}:${src.id}`;
          const loaded = e.loadSong(id, song.title, audio, { artist: song.artist });
          useKaraoke.getState().patch({
            fullActive: true,
            fullId: id,
            fullProvider: src.provider,
            fullChannel: src.artist,
            fullResolving: false,
            ytActive: false,
            ytVideoId: null,
            ytProbing: false,
            ytResolving: false,
            directActive: false,
            fullFailReason: 'none',
            song: {
              id,
              title: song.title,
              artist: song.artist,
              durationSec: audio.duration,
              hasLrc: false,
              hasMelody: false,
            },
            playing: false,
            pos: 0,
            duration: audio.duration,
            /* the full song's own peaks — the preview's don't map */
            peaks: loaded.peaks,
          });
          void e.play();
          toast.success(t().fullSongReady, {
            description: `${src.artist} · ${t().fullVia} ${src.provider === 'soundcloud' ? 'SoundCloud' : 'Audius'}`,
          });
          return true;
        } catch {
          /* next source */
        } finally {
          useKaraoke.getState().patch({ fullResolving: false });
        }
      }
      return false;
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
      /* While the YT full song owns the clock, the 30s shell must never
       * flash its duration/pos/peaks over the live timeline — the poll
       * re-asserts the real values every 250ms but a flash is still a flash. */
      const ytOwnsClock = useKaraoke.getState().ytActive;
      useKaraoke.getState().patch({
        song: {
          id,
          title: song.title,
          artist: song.artist,
          durationSec: buffer.duration,
          hasLrc: false,
          hasMelody: Boolean(existing?.melody && existing.melody.notes.length > 0),
        },
        ...(ytOwnsClock
          ? {}
          : { duration: buffer.duration, pos: 0, peaks: loaded.peaks }),
        lastTake: null,
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
     * lyrics, or a clear "no lyrics" state. One voice, one place. Never
     * attaches onto a stale shell from a previous song, and never attaches
     * a timeline the session has already moved away from: a preview-mode
     * result is dropped when the full song owns the clock (live or being
     * verified by the probe gate), and a full-mode result waits when the
     * probe gate is still deciding — otherwise full-song timestamps land
     * on a 30-second clip (every line "not in place") or never land at all. */
    applyPrepare(prep: PrepareResult | null, mode: 'full' | 'preview', song: DiscoverSong) {
      const e = getEngine();
      if (!e.song) return;
      const st0 = useKaraoke.getState();
      /* the lyrics live on the engine's song — either the itunes shell, the
       * v5.0 full-length song (sc:/au:), or the direct-audio full song
       * (v3.4) — anything else is stale */
      const shellOk =
        e.song.id === `itunes:${song.trackId}` ||
        (st0.fullActive && e.song.id === st0.fullId) ||
        (st0.directActive && e.song.id === `yt:${st0.directVideoId}`);
      if (!shellOk) return;
      /* full means: the session is (or will be, once probing ends) on the
       * full-song timeline. preview means the 30s clip owns the clock NOW. */
      const fullTimeline = st0.ytActive || st0.ytProbing || st0.directActive || st0.fullActive;
      if (fullTimeline && mode === 'preview') return; // stale clip timeline
      if (!fullTimeline && mode === 'full') {
        /* probing just ended in a fallback — the gate cleared ytProbing and
         * the preview session started; this full result is stale */
        return;
      }
      const st = useKaraoke.getState();
      if (prep?.lrc) {
        /* the decoded buffer IS ground truth (full-tier / direct mode); the
         * YT session keeps the iTunes duration (refreshed from the player) */
        const dur =
          mode === 'full'
            ? st0.fullActive || st0.directActive
              ? e.duration
              : prep.fullDurationSec ?? (song.durationMs > 0 ? song.durationMs / 1000 : 0)
            : e.duration;
        this.setLyricsForDuration(prep.lrc, dur);
        st.patch({ syncState: 'synced', lyricsProvider: prep.provider ?? 'lrclib' });
        toast.success(t().syncDone, { description: `${song.artist} · ${song.title}` });
      } else if (prep?.plainLyrics) {
        this.setLyricsRaw(prep.plainLyrics);
        st.patch({ syncState: 'plain', lyricsProvider: prep.provider ?? null });
        toast.info(t().syncPlain, { description: `${song.artist} · ${song.title}` });
      } else {
        st.patch({ syncState: 'none', lyricsProvider: null });
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
        const lines = withDerivedEnds(parsed.lines, dur);
        e.song.lyrics = lines;
        e.song.plainLines =
          lines.length === 0
            ? parsed.lines.filter((l) => !(Number.isFinite(l.time) && l.time >= 0))
            : [];
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
        /* a pasted link often arrives while preview-timeline lyrics are
         * attached (after a fallback) — the full song needs its own words */
        const song = st.activeDiscover;
        if (song && e.song?.id === `itunes:${song.trackId}`) {
          void this.attachFullLyrics(song);
        }
      } else {
        e.ytPos = null;
        /* v5.0 — actually stop the engine too: seek() alone never pauses,
         * so the direct/full song kept playing after "off" (v4.0 bug) */
        e.pause();
        useKaraoke.getState().patch({
          ytActive: false,
          ytVideoId: null,
          ytCandidates: [],
          ytIndex: 0,
          ytResolving: false,
          ytProbing: false,
          directActive: false,
          directResolving: false,
          directVideoId: null,
          directChannel: null,
          fullActive: false,
          fullResolving: false,
          fullId: null,
          fullProvider: null,
          fullChannel: null,
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

    /** Start the full-song flow with a ranked candidate list (auto mode).
     * v3.3: candidates are NOT mounted directly — the browser probe gate
     * (YouTubeStage) verifies them with muted parallel iframes and calls
     * ytPromote/ytProbeFailed. This is the only reliable embeddability
     * check (server-side probes all lie; evidence: oEmbed 200 → iframe 150). */
    ytAutoStart(candidates: YtCandidate[]) {
      if (candidates.length === 0) return;
      const e = getEngine();
      e.pause();
      e.ytPos = 0;
      ytStallFails.count = 0; // fresh session — give the environment a fresh chance
      useKaraoke.getState().patch({
        ytActive: false,
        ytVideoId: null,
        ytCandidates: candidates,
        ytIndex: 0,
        ytSource: 'auto',
        ytResolving: false,
        ytProbing: true,
        playing: false,
        pos: 0,
        /* preview peaks do not map to the full-song timeline */
        peaks: null,
      });
    },

    /** v3.3 — the probe gate verified a source that actually plays: promote
     * it to the live full-song session (the YtSession mounts on ytVideoId). */
    ytPromote(videoId: string, index: number) {
      const st = useKaraoke.getState();
      const cand = st.ytCandidates[index];
      if (!cand || cand.videoId !== videoId) return; // stale probe result
      const e = getEngine();
      e.pause();
      e.ytPos = 0;
      useKaraoke.getState().patch({
        ytProbing: false,
        ytActive: true,
        ytVideoId: videoId,
        ytIndex: index,
        playing: true,
        pos: 0,
        fullFailReason: 'none',
      });
      toast.success(t().fullSongReady, { description: cand.channel || cand.title });
      /* the shell may still be landing — full-timeline lyrics attach as
       * soon as it exists (applyPrepare accepts 'full' while probing/active) */
      const song = st.activeDiscover;
      if (song) void this.attachFullLyrics(song);
    },

    /** v3.4 — THE DIRECT-AUDIO TIER. The probe gate failed (or the iframe
     * died): before giving up on the full song, ask the SERVER to resolve
     * a direct audio stream (visionos innertube + byte proxy) for each
     * candidate. The winner is decoded into Web Audio and loaded into the
     * engine as a real full-length buffer — which means the ENTIRE karaoke
     * machine works on it: vocal removal, key shift, speed, melody scan,
     * scoring, recording. Returns true when a full song now owns the clock.
     * Total: never throws, never leaves partial state. */
    async tryDirectAudio(song: DiscoverSong, cands: YtCandidate[]): Promise<boolean> {
      const st = useKaraoke.getState();
      if (st.directActive) return true;
      if (st.activeDiscover?.id !== song.id) return false; // the session moved on
      useKaraoke.getState().patch({ directResolving: true });
      try {
        /* 1 — cheap probes in rank order: one innertube POST per candidate
         * (server-cached), first answer with a real audio payload wins */
        let pick: YtCandidate | null = null;
        for (const c of cands.slice(0, 5)) {
          try {
            const r = await fetch(`/api/discover/stream?probe=1&id=${encodeURIComponent(c.videoId)}`);
            const d = (await r.json()) as { ok?: boolean; bytes?: number };
            if (d?.ok && (d.bytes ?? 0) > 200_000) {
              pick = c;
              break;
            }
          } catch {
            /* next candidate */
          }
        }
        if (!pick) return false;

        /* 2 — download the whole track through the proxy + decode */
        const res = await fetch(`/api/discover/stream?id=${encodeURIComponent(pick.videoId)}`);
        if (!res.ok) return false;
        const buf = await res.arrayBuffer();
        if (buf.byteLength < 200_000) return false; // an error page, not a song
        const audio = await decodeAudioData(buf);

        /* 3 — load it as the engine's song: the Web Audio graph owns the
         * clock; every DSP feature + scoring runs on the FULL song now */
        const e = getEngine();
        if (st.activeDiscover?.id !== song.id) return false; // moved on mid-download
        e.ytPos = null;
        const loaded = e.loadSong(`yt:${pick.videoId}`, song.title, audio, {
          artist: song.artist,
        });
        useKaraoke.getState().patch({
          directActive: true,
          directVideoId: pick.videoId,
          directChannel: pick.channel || 'YouTube',
          directResolving: false,
          ytActive: false,
          ytVideoId: null,
          ytProbing: false,
          fullFailReason: 'none',
          song: {
            id: `yt:${pick.videoId}`,
            title: song.title,
            artist: song.artist,
            durationSec: audio.duration,
            hasLrc: false,
            hasMelody: false,
          },
          playing: false,
          pos: 0,
          duration: audio.duration,
          peaks: loaded.peaks,
        });
        void e.play();

        /* 4 — full-timeline lyrics on the real buffer duration */
        const prep = await fetchPrepare(song, 'full');
        this.applyPrepare(prep, 'full', song);
        return true;
      } catch {
        return false;
      } finally {
        useKaraoke.getState().patch({ directResolving: false });
      }
    },

    /** v3.3 — every probed source failed to start (embed-blocked or walled):
     * try the direct-audio tier, then hand the session to the 30s preview. */
    async ytProbeFailed() {
      if (!useKaraoke.getState().ytProbing) return;
      const song = useKaraoke.getState().activeDiscover;
      const cands = useKaraoke.getState().ytCandidates;
      useKaraoke.getState().patch({
        ytProbing: false,
        ytActive: false,
        ytVideoId: null,
        ytIndex: 0,
        /* v4.0 — every embeddable check the browser could make failed:
         * the wall is either this network or these specific videos */
        fullFailReason: cands.length > 0 ? 'embeds-blocked' : 'no-sources',
      });
      /* tier 2 — the server may still reach sources the browser cannot */
      if (song && (await this.tryDirectAudio(song, cands))) return;
      toast.warning(t().ytAllFailed);
      if (song) {
        /* the shell is the preview's home — make sure it exists before the
         * clip starts (idempotent when it is already loaded) */
        if (getEngine().song?.id !== `itunes:${song.trackId}`) {
          await this.ensureShell(song).catch(() => null);
        }
        await this.startPreviewWithLyrics(song, null);
      } else this.setYt(null, { resumePreview: false });
    },

    /** Attach the FULL-timeline lyrics to the live session. Serves the
     * full-length tier (v5.0), the YT iframe session, the probe phase AND
     * the direct-audio tier: full lyrics wait while probing, attach when a
     * full song owns the clock. Total: never throws, self-guarded. */
    async attachFullLyrics(song: DiscoverSong) {
      const e = getEngine();
      const st = useKaraoke.getState();
      const idOk =
        e.song?.id === `itunes:${song.trackId}` ||
        (st.fullActive && e.song?.id === st.fullId) ||
        (st.directActive && e.song?.id === `yt:${st.directVideoId}`);
      if (!idOk) return;
      if (!st.ytActive && !st.ytProbing && !st.directActive && !st.fullActive) return; // a full song must own the clock
      const prep = await fetchPrepare(song, 'full');
      this.applyPrepare(prep, 'full', song); // drops itself if the mode flipped
    },

    /** Switch the backing-track variant (original ⇄ karaoke) for the active
     * song. Karaoke = instrumental uploads (no lead vocals) — a true
     * karaoke machine. Falls back to the original when none exist. */
    async switchYtVariant(variant: 'original' | 'karaoke') {
      const song = useKaraoke.getState().activeDiscover;
      if (!song || useKaraoke.getState().ytVariant === variant) return;
      useKaraoke.getState().patch({ ytVariant: variant, ytResolving: true });
      const yt = await fetchYtCandidates(song, variant);
      const cur = useKaraoke.getState();
      if (!cur.activeDiscover || cur.activeDiscover.id !== song.id) {
        return; // the session moved on mid-flight
      }
      if (yt.length > 0) {
        this.ytAutoStart(yt);
        /* the previous session may have been the preview fallback — its
         * clip-timeline lyrics are wrong for a full song; re-attach */
        void this.attachFullLyrics(song);
      } else {
        useKaraoke.getState().patch({ ytVariant: 'original', ytResolving: false });
        toast.info(t().ytNoKaraoke);
      }
    },

    /** Re-resolve full-song sources after a fallback (the "try again"
     * button) — bypasses the empty-result cache. v5.0: the full-length
     * tier (SoundCloud/Audius) retries FIRST; YouTube only after it. */
    async retryFullSong() {
      const song = useKaraoke.getState().activeDiscover;
      if (!song || useKaraoke.getState().ytResolving) return;
      useKaraoke.getState().patch({ ytResolving: true, fullFailReason: 'none' });
      try {
        /* tier 1 — a fresh full-length resolve, cache bypassed */
        const sources = await fetchFullSongSources(song);
        if (sources.length > 0 && (await this.tryFullAudio(song, sources))) {
          void this.attachFullLyrics(song);
          return;
        }
        /* tier 2 — YouTube with a fresh resolve */
        const variant = useKaraoke.getState().ytVariant;
        const yt = await fetchYtCandidates(song, variant, true);
        if (yt.length > 0) {
          this.pause();
          this.ytAutoStart(yt);
          /* the preview fallback left clip-timeline lyrics on the stage —
           * the full song needs its own timeline back */
          void this.attachFullLyrics(song);
        } else {
          useKaraoke.getState().patch({ fullFailReason: 'no-sources' });
          toast.warning(t().ytAllFailed);
        }
      } finally {
        useKaraoke.getState().patch({ ytResolving: false });
      }
    },

    /** Advance to the next ranked full-song source. false when exhausted
     * or when the environment stalls every source (bot wall) — the caller
     * falls back to the preview instead of meeting more dead iframes. */
    ytTryNext(): boolean {
      const st = useKaraoke.getState();
      if (ytStallFails.count >= 3) return false;
      const next = st.ytCandidates[st.ytIndex + 1];
      if (!next || !next.videoId) return false;
      useKaraoke.getState().patch({ ytVideoId: next.videoId, ytIndex: st.ytIndex + 1, playing: true, pos: 0 });
      toast.info(t().ytTryNext, { description: next.channel || next.title });
      return true;
    },

    /** Every auto-resolved iframe source failed - try the direct-audio tier
     * (the server sees a different vantage point), then the 30s preview. */
    async ytFailed() {
      const song = useKaraoke.getState().activeDiscover;
      const cands = useKaraoke.getState().ytCandidates;
      this.setYt(null, { resumePreview: false });
      if (song && cands.length > 0 && (await this.tryDirectAudio(song, cands))) return;
      toast.warning(t().ytAllFailed);
      if (song) await this.startPreviewWithLyrics(song, null);
    },

    /** v3.4 — a manually pasted link failed to embed: try the direct-audio
     * tier for THAT video before giving up on it. Returns true when a full
     * song now owns the clock (the caller skips the plain toast). */
    async ytManualFailed(videoId: string): Promise<boolean> {
      const song = useKaraoke.getState().activeDiscover;
      if (!song) return false;
      useKaraoke.getState().patch({ ytActive: false, ytVideoId: null });
      const cand: YtCandidate = { videoId, title: '', channel: 'YouTube', durationSec: 0, score: 0 };
      const ok = await this.tryDirectAudio(song, [cand]);
      if (!ok) {
        toast.error(t().ytFail);
        this.setYt(null, { resumePreview: true });
      }
      return ok;
    },

    /** Re-fetch lyrics for the active catalog song (the "try again" button).
     * Full-song timeline while the YT session or direct audio owns the clock,
     * clip timeline otherwise. Re-ensures the shell only in preview mode —
     * in direct mode the engine already holds the full-length song. */
    async retryLyrics() {
      const st = useKaraoke.getState();
      const song = st.activeDiscover;
      if (!song) return;
      st.patch({ syncState: 'syncing' });
      try {
        const full = st.fullActive;
        const direct = st.directActive;
        const mode: 'full' | 'preview' =
          full || direct || useKaraoke.getState().ytActive || useKaraoke.getState().ytProbing ? 'full' : 'preview';
        if (!full && !direct && getEngine().song?.id !== `itunes:${song.trackId}`) {
          await this.ensureShell(song).catch(() => null);
        }
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
        favorites: Array.isArray(favorites)
          ? favorites.filter((f) => f && f.id && (f.previewUrl || (f.fullSources && f.fullSources.length > 0)))
          : [],
      });
      actions.refreshLibrary();
      actions.refreshTakes();
    },
  };

  return actions;
}

export type KaraokeActions = ReturnType<typeof useKaraokeEngine>;
export type { ScoreResult, RankKey, LoadedSong };
