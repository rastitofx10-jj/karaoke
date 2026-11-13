# TITO KARAOKE STUDIO — Changelog

## 3.2 — FULL SONGS, BULLETPROOF (2026-11-13)

The "29-second song is not a song" and "lyrics not in place" release. Every
known way a full-song session could die or desync is now handled.

### PLAIN LYRICS ARE STILL LYRICS
- Songs whose LRCLIB record has only plain (unsynced) lyrics used to render a
  **blank stage** — the synced-line pipeline dropped them. Now they ride along
  as `plainLines` and the stage renders them as a static scrollable list with
  an honest "unsynced — sing along" chip. Coverage win, especially for
  Israeli music.

### THE LYRICS RACE (the real "not in place" bug)
- **Root cause found**: the full-song LRC and the AI preview sync resolve at
  different speeds. When YouTube failed and the app fell back to the 30-second
  preview, a late-arriving full-song LRC could land **on top of the preview
  playback** — full-song timestamps on a 30-second clip, every line wrong.
- `applyPrepare` now carries a **live-mode guard**: a full-timeline result is
  dropped the moment the preview owns the clock and vice versa. The two
  timelines can never overwrite each other again.
- Every full-song (re)start — "try the full song again", the karaoke/original
  toggle, a pasted link — now **re-attaches the full-timeline lyrics** instead
  of leaving clip-timeline words on a full song.

### FULL-SONG SOURCES
- **oEmbed embeddability probe (server)** — embed-blocked videos (the #1
  killer: official music videos are often embed-disabled, error 101/150) are
  dropped before the client ever mounts them. Probes cached 24 h; a probe
  outage never filters anything.
- **8 candidates** per resolve (was 5), empty results cached only 10 minutes
  (was 6 h) so "try again" gets a real second chance; `fresh=1` bypasses the
  cache for user-driven retries.
- **Karaoke variant** — `variant=karaoke` re-tunes the resolver for
  instrumental backing-track uploads ("karaoke", "instrumental", "no vocals",
  karaoke channels), with a looser duration window for count-in intros. One
  toggle in the studio: original ⇄ karaoke version.
- **Autoplay-block handling** — if the browser refuses programmatic playback,
  a big **"tap to start the song"** overlay appears (a real gesture always
  works); if even that fails, the overlay gets out of the way so YouTube's own
  play button is reachable.
- **3-second stall watchdog + 3-strike environment rule** — a frozen clock
  cascades after 3 s; three consecutive stalls means the whole environment
  blocks embeds, so the app skips straight to the honest fallback instead of
  burning ~30 s on dead sources.

### THE GOLDEN PATH, REORDERED
- The full-song session now starts **the moment sources resolve** — the 30 s
  shell (fallback surface + melody + lyrics home) loads in parallel and never
  blocks the music. Shell failures retry once; lyrics attach right after.
- The preview fallback is honest: a clear "playing a 30-second excerpt" notice
  with a **"try the full song again"** button and the manual link paste.
- `powerOn()` never awaits a gesture-blocked `AudioContext.resume()` — a
  blocked audio context can no longer hang a song load (the YouTube path
  doesn't need Web Audio at all).

## 3.1 — FULL SONGS BY DEFAULT (2026-11-13)

- Auto YouTube session on song click, ranked source cascade, ±0.25 s lyric
  calibration, source line with duration and index.

## 3.0 — ONE STAGE (2026-11-13)

- Two-screen app: HOME (search-first landing) and STUDIO (you, the lyrics,
  the mic). Deep links, keyboard map, drag & drop kept.

## 2.0 — DISCOVER ENGINE (2026-11-13)

- iTunes catalog search + local charts, official 30 s preview streaming through
  a same-origin proxy, LRCLIB synced lyrics, AI preview sync (clip transcribed
  with ASR, fuzzy-aligned against the full-song LRC, offset cached in SQLite),
  library persistence, play counters, favorites, shareable deep links.

## 1.0 — THE STAGE (2026-11-13)

The first full build: a complete professional karaoke studio in the browser,
reverse-engineered from a single-file karaoke artifact and rebuilt several
levels up as a real engineering project.

### THE STAGE
- **The console** — dark three-column layout (library | stage | mic) on desktop,
  bottom tab bar on mobile, Hebrew-first RTL with English toggle, safe-area
  aware, 36–44 px touch floors on coarse pointers.
- **The lyrics stage** — word-by-word fill for Enhanced LRC (`<mm:ss.xx>` word
  timing), sweep fill for plain lines, per-line RTL/LTR detection, countdown
  dots before lines, next-line preview, last line completes at song end.
- **Stage mode (F)** — fullscreen singing view: big lyrics, live pitch ribbon,
  minimal transport, mic and REC one-tap chips.

### THE ENGINES
- **Vocal Engine** — live center-channel cancellation with centered-bass
  restoration (low-passed mono sum re-injected under the side signal) and the
  reverse singer-isolation mode (220–4200 Hz vocal band + 2.6 kHz presence
  lift), blend amount on a live fader.
- **Key Shift** — custom AudioWorklet granular pitch shifter: two-tap delay
  line, power-complementary sin²/cos² windows (constant-sum crossfade),
  linear-interpolated reads, ~43 ms grain, ±12 semitones with no speed change.
- **Speed** — 0.5×–1.5× with pitch preservation (speed shift compensated
  inside the same worklet) or varispeed mode.
- **Melody Scan** — offline render of the isolated vocal, then the full
  pipeline: YIN frames → 5-point median filter → octave-error repair →
  note segmentation (±0.7 st stability, 3-frame floor, boundary merge).
  The learned melody becomes the scoring target and persists with the song.
- **Scoring** — SingStar-style verdicts: rolling 12 s live score + final
  result (pitch/timing/coverage/avg cents), eight ranks, latency-compensated
  frame collection, auto-stop and verdict on song end.

### THE MIC CONSOLE
- RMS-driven noise gate with 180 ms hold, 3-band EQ, compressor,
  four procedurally generated convolution reverbs (room/hall/stage/stadium,
  stereo IRs with predelay), tempo-free feedback echo with time control,
  gain, speaker monitoring (marked red — headphones only), five presets
  (dry/tight/hall/big/duet).

### THE RECORDER
- AudioWorklet mix-bus tap with transferable chunks; records the full mix
  (song + processed voice); takes save to the library with score + rank,
  playable inline, downloadable as 16-bit WAV.

### THE LIBRARY
- IndexedDB persistence: songs (audio + LRC + scanned melody), takes
  (WAV + score), settings. Auto-save on import, search, delete with cascade.

### THE LYRICS TOOLKIT
- Full parser: LRC (4 timestamp formats, multi-timestamp rows, ID tags,
  offset), Enhanced LRC word timing, SRT (with HTML/ASS junk stripping),
  plain text. Serializer, tap-to-sync editor (SPACE or the big pad, ±0.3 s
  nudge, seek-to-line), LRC export, drag-and-drop import for audio and
  lyrics alike.

### THE PLUMBING
- One engine class owns the entire Web Audio graph; position tracking
  against `ctx.currentTime` survives speed changes, seeks and the A-B loop.
- Worklets served as Blob URLs — zero static files, zero CORS.
- Single rAF heartbeat feeds the zustand store; canvas renderers read state
  directly (no re-render storms at 60 fps).
- Strict TypeScript, zero `any` at module boundaries, ESLint clean,
  `tsc --noEmit` clean, React Compiler clean.

### VERIFIED LIVE
Every flow was verified in a real browser before shipping: power-on, song
import + decode, library round-trip (IndexedDB), LRC import with word timing,
melody scan (11 notes learned from a synthetic A4→C5→E5 melody, first note
68.96 st ≈ A4), playback, key shift (+2 st → worklet ratio 1.1225 exactly),
karaoke/isolate modes, A-B loop (2→6 s wrap confirmed), REC with song-end
auto-stop, verdict modal, take save + playback, stage mode, mobile tabs,
no console errors, no dev-log errors.
