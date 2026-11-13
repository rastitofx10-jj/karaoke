# TITO KARAOKE STUDIO · v1.0 — THE STAGE

**אולפן קריוקי מקצועי שלם, בדפדפן. הנדסה לאחור של אפליקציית קריוקי — ובנייה מחדש כמה רמות מעליה.**
A complete professional karaoke studio that runs entirely in the browser. No server, no uploads — every sample, every pitch, every score is computed on your machine.

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

Open the app → **הדלקה** (power) → drop an MP3 → load an LRC (or sync one in the editor) → **סריקה** (melody scan) → **הקלט** (REC) → sing → get judged.

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
  i18n.ts         HE/EN dictionary
src/components/karaoke/   the console UI
src/hooks/use-engine.ts   React binding + actions (rAF heartbeat)
src/store/karaoke.ts      zustand store
```

## HONEST EDGES

- Vocal removal is the classic center-cancel trick — great on 90% of pop/rock mixes, weak on hard-panned or heavily doubled vocals. That's physics, not a bug.
- Melody scan quality depends on the lead vocal sitting in the center. Wide-stereo acapellas will scan noisily.
- Speaker monitoring without headphones = feedback loop. The app marks it red for a reason.
- Chrome/Edge/Firefox only (AudioWorklet). Safari mostly works, untested.

---

*TITO KARAOKE STUDIO · reverse-engineered, rebuilt one level up · everything runs in your browser.*
