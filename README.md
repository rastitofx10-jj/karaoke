# TITO KARAOKE STUDIO · v6.0 — FULL SONGS, ALWAYS · THE BULLETPROOF PASS

**אולפן קריוקי מקצועי שלם, בדפדפן. חיפוש שיר → שיר מלא אמיתי (SoundCloud · Audius, בלי תלות ב-YouTube) → מילים מסונכרנות → שירה. וכשמשהו חסום — המכונה אומרת לכם בדיוק מה, למה, ומה עושים עכשיו.**
A complete professional karaoke studio that runs entirely in the browser. Search a song, get the **REAL full-length song** (SoundCloud + Audius catalogs, streamed same-origin and decoded into Web Audio — YouTube-independent) with **time-synced lyrics**, and sing. And when something is blocked, the machine **tells you exactly what, why, and what to do next** — the Network Doctor pings all 8 providers live and speaks the verdict in one sentence.

---

## THE GOLDEN PATH (v6.0 — evidence-backed, tiered, transparent)

1. **Search** — the iTunes catalog (millions of songs, official artwork + metadata) plus live local charts, with full-length provider sources attached live.
2. **Tier 1 — the full-length catalogs (v5.0)** — SoundCloud (millions of full-length tracks, policy-ALLOW, live-extracted anonymous client_id) and Audius (decentralized, full-length mp3s). The server does ALL the external talking (signed playlists, HLS segment concatenation, ffmpeg transcode fallback) and the browser decodes the complete track into Web Audio — which unlocks the **whole karaoke machine on the full song**: vocal removal, singer isolation, key shift, speed, melody scan, scoring, A-B loop, recording. v6.0 adds the **query-variant cascade** ("artist title" → "title alone") so script differences and featuring artists stop hiding full tracks.
3. **Tier 2 — the probe gate** — the server ranks full-length YouTube sources; the browser mounts tiny **muted probe players in parallel waves** and keeps only a source whose clock actually moves; then the direct-audio tier (server-side resolve + byte proxy) for walled networks.
4. **Tap-for-sound** — a promoted session starts muted (autoplay-policy safe), so the clock, lyrics and mic run from the first second; one tap on the overlay turns the sound on.
5. **Lyrics in place** — LRCLIB synced lyrics on the song's original timeline across all tiers (NetEase as the second lyrics provider); every stale timeline is dropped at the state machine (clip words can never land on a full song and vice versa). **±0.25 s calibration** for intro drift.
6. **Original ⇄ Karaoke version** — one toggle re-resolves the backing track to instrumental karaoke uploads (no lead vocals).
7. **Honest fallback — v6.0 makes it COMPLETE** — everything blocked? A clear 30-second-preview notice that **names the actual reason** ("sources were found but the download failed — try again, it is usually transient" / "this network is likely blocked by YouTube" / "the videos found for this song are not embeddable" / "no full sources were found"), plus:
   - **THE NETWORK DOCTOR v6.0** — one click pings **SoundCloud, Audius**, LRCLIB, NetEase, iTunes, the in-browser YouTube player (a real muted probe), the direct-audio tier **and ffmpeg availability** — 8 rows, each with a status dot + latency. The verdict is one honest sentence with the next action: retry / paste a link / import a file / install ffmpeg / tap-sync lyrics. No more silent mysteries.
   - **Self-healing retries** — stale search-time sources get ONE fresh server resolve before YouTube is considered; every network call carries a hard timeout so a stalled link degrades to the next source instead of hanging the session.
   - **Tap-sync CTA** — when a song only has plain lyrics, the stage invites you to tap your own sync in the editor (one minute to karaoke).
   - **LRC autodetect** — paste an LRC/SRT into the editor and the timestamps are kept.
   - Manual-paste field, retry door, clip-synced lyrics. The stage never sits silent, never lies, never surprises you with a 29-second song pretending to be a song.
8. Sing — mic console, vocal engine, live pitch, scoring, recording. Everything below still applies.

---

## THE ENGINE ROOM

| Organ | What it does |
|---|---|
| **Vocal Engine** | Real-time center-channel cancellation (the classic karaoke vocal removal, done properly: side-signal reconstruction with centered-bass restoration below 150 Hz) **and** the reverse — singer isolation (vocal band extraction 220–4200 Hz + presence lift). Blend amount is a live fader. |
| **Key Shift** | ±12 semitones of real-time pitch transposition **without speed change** — a custom AudioWorklet granular shifter (two-tap delay line, power-complementary sin²/cos² windows, linear-interpolated reads, ~43 ms grains). Verified: +2 st → ratio 1.1225 exactly. |
| **Speed Control** | 0.5×–1.5× with pitch preservation (speed-induced shift is compensated inside the same worklet) or classic vinyl-style varispeed. |
| **Melody Scan** | THE flagship. Renders the vocal-isolated center offline, then learns the original singer's melody: frame-wise **YIN** (the real 6-step algorithm) → 5-point median filter → octave-error repair → note segmentation (±0.7 st stability, ~140 ms floor, boundary merge). The learned melody becomes the scoring target. Persisted per song. |
| **Scoring Engine** | SingStar-style: live rolling score (12 s window) + final verdict. Pitch (cent-window hit rate), Timing (note-window hit rate), Coverage (did you actually sing), avg cent deviation. Eight ranks from *Tone Deaf* to *Legend*. Latency-compensated against `baseLatency + outputLatency`. |
| **Mic Console** | Noise gate (RMS-driven with 180 ms hold so word gaps don't chop), 3-band EQ, compressor, four convolution reverbs (room/hall/stage/stadium — procedurally generated stereo IRs with predelay), feedback echo with time control, gain, speaker monitoring (headphones only — you were warned). |
| **Recorder** | Records the full mix (song + your processed voice) through a dedicated AudioWorklet tap with transferable chunks. Song end auto-stops the take and opens the verdict. Takes are saved to the library with score + rank, playable and downloadable as **16-bit WAV**. |
| **Lyrics Engine** | LRC (all timestamp formats, multi-timestamp lines, ID tags, offset), **Enhanced LRC** (word-level `<mm:ss.xx>` timing), SRT, and plain text. Word-by-word fill for enhanced LRC, sweep fill otherwise, per-line RTL/LTR detection (Hebrew-aware), countdown dots before lines, next-line preview. Full **tap-to-sync editor**: paste text, tap SPACE on every line, nudge ±0.3 s, apply, export LRC. |
| **Library** | IndexedDB persistence — songs (audio + LRC + scanned melody), takes (WAV + score), settings. Auto-saved on import, forever yours. |

## THE CONSOLE

- **Desktop:** three-column console — library + melody scan | the stage | mic console + vocal engine + recorder. Transport with waveform seek (RTL-aware), A-B practice loop, spectrum strip.
- **Stage mode (F):** fullscreen lyrics with the live pitch ribbon and minimal transport — the singing view.
- **Mobile:** bottom tab bar (Stage / Mic / Library / Recorder), 36–44 px touch floors, safe-area aware.
- **Hebrew-first, English-ready:** full HE/EN dictionary with RTL layout, per-line lyric direction detection.
- **Shortcuts:** `SPACE` play/pause · `S` melody scan · `R` record · `M` mic · `F` stage mode · `E` lyrics editor · `ESC` exit.
- **Drag & drop:** audio anywhere → loads. `.lrc/.srt/.txt` anywhere → lyrics.

## THE TECH

- Next.js 16 (App Router) · TypeScript strict · Tailwind CSS 4
- Web Audio API: ChannelSplitter mid/side vocal engine, BiquadFilter chains, ConvolverNode, DynamicsCompressor
- **AudioWorklets** served as Blob URLs (zero static files): granular pitch shifter + recorder tap
- YIN pitch detection (pre-allocated buffers, voice band 55–1050 Hz, parabolic interpolation)
- Zustand store fed by a single rAF heartbeat — canvas renderers (pitch ribbon, spectrum, waveform) read state directly, no re-render storms
- IndexedDB (raw API, zero deps) with never-throw semantics
- React Compiler-clean, ESLint-clean, `tsc --noEmit` clean

## RUN IT

```bash
bun install
bun run dev        # http://localhost:3000
```

Open the app → search a song (or drop an MP3) → the full song + synced lyrics load → **F** for stage mode → sing.

## ARCHITECTURE

```
src/lib/karaoke/
  types.ts        shared vocabulary
  lrc.ts          LRC/ELRC/SRT parser + serializer + active-line/progress math
  pitch.ts        YIN detector + note math
  melody.ts       offline melody scanner (median filter, octave fix, segmentation)
  scoring.ts      rolling + final scoring, rank ladder
  wav.ts          RIFF/WAVE encoder (16/24/32-bit), decoder, mixer
  storage.ts      IndexedDB library + settings
  engine.ts       the Web Audio graph — one class owns everything
  worklets.ts     AudioWorklet sources (pitch-shift, recorder)
  yt.ts           YouTube IFrame bridge + stall-failure telemetry
  yt-server.ts    full-song resolver: search scrape → scoring (12 candidates)
  yt-audio-server.ts  direct-audio tier: visionos innertube resolve + byte proxy
  discover-server.ts  iTunes search/charts + LRCLIB + AI preview sync (ASR)
  i18n.ts         HE/EN dictionary
src/app/api/discover/  search · charts · prepare (lyrics) · youtube · audio · plays · stream (proxy)
src/components/karaoke/   the console UI
src/hooks/use-engine.ts   React binding + actions (rAF heartbeat, golden path)
src/store/karaoke.ts      zustand store
```

## HONEST EDGES

- Full-length playback is tiered: **iframe probe gate** (verified in your browser) → **direct-audio tier** (server-resolved, decoded into the engine so every DSP feature runs on the full song) → **honest 30-second preview** with clip-synced lyrics and a one-click retry. The app tells you which tier you're on and never pretends a 29-second clip is a song.
- On iframe (YouTube-embed) playback the vocal engine has no access to the music track — that's Web Audio security, not a bug. The direct-audio tier exists precisely to unlock vocal removal, key shift and speed on full songs; the preview shell always has them.
- Vocal removal is the classic center-cancel trick — great on 90% of pop/rock mixes, weak on hard-panned or heavily doubled vocals. That's physics, not a bug.
- Melody scan quality depends on the lead vocal sitting in the center. Wide-stereo acapellas will scan noisily.
- Lyric coverage follows LRCLIB — most popular songs (HE and EN both) have synced lyrics; when a song doesn't, the app says so, falls back to plain lyrics as a static sing-along list, and offers a retry + the tap-to-sync editor.
- Speaker monitoring without headphones = feedback loop. The app marks it red for a reason.
- Chrome/Edge/Firefox only (AudioWorklet). Safari mostly works, untested.

---

*TITO KARAOKE STUDIO · reverse-engineered, rebuilt one level up · everything runs in your browser.*
