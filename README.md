# TITO KARAOKE STUDIO · v3.4 — FULL SONGS, VERIFIED

**אולפן קריוקי מקצועי שלם, בדפדפן. חיפוש שיר → שיר מלא שמאומת בפועל → מילים מסונכרנות → שירה.**
A complete professional karaoke studio that runs entirely in the browser. Search a song, get the **full song** — verified to actually play before it ever reaches your ears — with **time-synced lyrics**, and sing. Every sample, every pitch, every score computed on your machine.

---

## THE GOLDEN PATH (v3.4 — evidence-backed, tiered)

1. **Search** — the iTunes catalog (millions of songs, official artwork + metadata) plus live local charts.
2. **The probe gate** — the server ranks up to 12 full-length YouTube sources; the browser then mounts tiny **muted probe players in parallel waves** and keeps only a source whose clock actually moves. A source that plays silently/bot-walled never passes; a source that plays is promoted instantly. This is the only reliable embeddability check in existence — server-side probes (oEmbed etc.) return "embeddable" for videos the player then rejects with error 150.
3. **Tap-for-sound** — the promoted session starts muted (autoplay-policy safe), so the clock, lyrics and mic run from the first second; one tap on the overlay turns the sound on.
4. **The direct-audio tier** — if the iframe route is blocked (embed-disabled or datacenter walls), the server itself resolves a direct audio stream (visionos innertube client — cipher-free googlevideo URLs) and **proxies the bytes**. The track is decoded into Web Audio, which unlocks the **whole karaoke machine on the full song**: vocal removal, singer isolation, key shift, speed, melody scan, scoring, A-B loop, recording — none of which can process iframe audio.
5. **Lyrics in place** — LRCLIB synced lyrics on the song's original timeline across all three tiers; every stale timeline is dropped at the state machine (clip words can never land on a full song and vice versa). **±0.25 s calibration** for intro drift.
6. **Original ⇄ Karaoke version** — one toggle re-resolves the backing track to instrumental karaoke uploads (no lead vocals).
7. **Honest fallback** — both tiers blocked? A clear 30-second-preview notice with a **"try the full song again"** door, clip-synced lyrics, and a manual-paste field that itself falls back through the direct tier. The stage never sits silent, never lies, never surprises you with a 29-second song pretending to be a song.
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
