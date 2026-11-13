# TITO KARAOKE STUDIO · v3.2 — FULL SONGS

**אולפן קריוקי מקצועי שלם, בדפדפן. חיפוש שיר → שיר מלא → מילים מסונכרנות → שירה.**
A complete professional karaoke studio that runs entirely in the browser. Search a song, get the **full song** with **time-synced lyrics**, and sing — every sample, every pitch, every score computed on your machine.

---

## THE GOLDEN PATH (v3.2 — bulletproof)

1. **Search** — the iTunes catalog (millions of songs, official artwork + metadata) plus live local charts.
2. **Full song, automatically** — the server ranks full-length YouTube sources for the song you picked, drops every embed-blocked source up front (oEmbed probe), and the session starts the moment you click a song. No source survives? A cascade tries the next one; the environment blocks them all? An honest 30-second preview keeps the stage alive with a one-click **"try the full song again"**.
3. **Lyrics in place** — LRCLIB synced lyrics on the song's original timeline, so they line up with the full song exactly. Karaoke (`instrumental`) uploads with intro drift? **±0.25 s calibration** buttons.
4. **Original ⇄ Karaoke version** — one toggle re-resolves the backing track to instrumental karaoke uploads (no lead vocals) — a true karaoke machine when the upload exists.
5. **Autoplay-blocked? Tap to start** — the app shows a big tap button instead of a silent black rectangle; after one failed tap it gets out of the way and lets you press YouTube's own play button.
6. Sing — mic console, vocal engine, live pitch, scoring, recording. Everything below still applies.

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
  yt-server.ts    full-song resolver: search scrape → scoring → oEmbed probe
  discover-server.ts  iTunes search/charts + LRCLIB + AI preview sync (ASR)
  i18n.ts         HE/EN dictionary
src/app/api/discover/  search · charts · prepare (lyrics) · youtube · audio · plays
src/components/karaoke/   the console UI
src/hooks/use-engine.ts   React binding + actions (rAF heartbeat, golden path)
src/store/karaoke.ts      zustand store
```

## HONEST EDGES

- Full-length playback comes from YouTube embeds. If a network (or YouTube's bot wall) blocks embeds for you, the app tells you so, keeps the honest 30-second preview running and offers **"try the full song again"** plus a manual link paste.
- Vocal removal is the classic center-cancel trick — great on 90% of pop/rock mixes, weak on hard-panned or heavily doubled vocals. That's physics, not a bug. (On full-song YouTube playback the vocal engine applies to the 30 s preview shell only.)
- Melody scan quality depends on the lead vocal sitting in the center. Wide-stereo acapellas will scan noisily.
- Lyric coverage follows LRCLIB — most popular songs (HE and EN both) have synced lyrics; when a song doesn't, the app says so and offers a retry + the tap-to-sync editor.
- Speaker monitoring without headphones = feedback loop. The app marks it red for a reason.
- Chrome/Edge/Firefox only (AudioWorklet). Safari mostly works, untested.

---

*TITO KARAOKE STUDIO · reverse-engineered, rebuilt one level up · everything runs in your browser.*
