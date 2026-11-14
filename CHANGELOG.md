# TITO KARAOKE STUDIO — Changelog

## 6.0 — THE BULLETPROOF PASS: validation, engineering, honesty (2026-11-14)

The "go over everything and fix it" release: a full engineering validation
sweep over the whole machine, every finding fixed, everything re-verified
end-to-end from a real browser.

### ENGINEERING VALIDATION (what the sweep found and fixed)

- **Type-level bug in `fetchBytes` (full-server.ts)** — the signature read
  `timeoutMs: 25_000`: a literal TYPE annotation, not a default value. Every
  call passing 30000/60000 was a type error `tsc` caught (runtime hid it).
  Fixed to `timeoutMs: number = 25_000`; full `tsc --noEmit` is now clean.
- **Unbounded client fetches** — every network call in the golden path
  (`fullstream` download + transcode retry, `fullsong`, `youtube`, `prepare`,
  `stream` probe/download, preview shell) now carries a hard
  `AbortSignal.timeout`: a stalled network degrades to the NEXT source
  instead of hanging the session forever. Download ceiling 150s (a 10-minute
  song on a slow link is legitimate; beyond that it is a stall).
- **Stale search-time sources** — when the search-time list existed but every
  download failed (uploader deleted the track, id rotated), the session used
  to fall straight to YouTube/preview. v6.0 adds ONE fresh server resolve
  before YouTube is even considered — the transient case now heals itself.

### FULLER SONGS (the query-variant cascade)

- `resolveFullSources` now tries **"artist title" first, then "title alone"**
  when the first variant finds nothing. Script differences (עומר אדם vs
  Omer Adam), featuring artists and label renames used to kill tier 1;
  verified live: **"טרנטונה" (Tuna)** returned zero sources on the old
  single-variant query and now plays the full 2:49 track through the
  title-alone variant.

### HONEST MACHINES (one law, most specific reason wins)

- New `fullFailReason: 'download-failed'` — sources EXISTED but every
  download failed. The fallback panel speaks it ("sources were found but the
  download failed — try again, usually transient") in HE and EN, and the
  later tiers (YouTube probe failure, no-sources) no longer overwrite it:
  the most specific observed reason wins. Verified end-to-end by blocking
  the fullstream route in a real browser: the panel said download-failed,
  and after unblocking, "try the full song again" recovered to the FULL
  song with synced lyrics.
- **Network Doctor v6.0** — the panel now measures **SoundCloud and Audius**
  (the tier-1 full-length catalogs, via real production searches) and
  **ffmpeg availability** (the transcode fallback), alongside LRCLIB,
  NetEase, iTunes, the YouTube embed probe and the innertube direct tier.
  Eight rows, one verdict law (tier-1 catalogs down > embed wall > server
  wall > lyrics > ffmpeg > healthy), HE/EN complete.

### VERIFIED FROM A REAL BROWSER (this machine, this session)

- Bohemian Rhapsody — full 5:54 via **Audius**, 61 synced lines, playing.
- Believer — full 3:25 via **SoundCloud**, 46 synced lines, playing.
- בסוף הכל חולף (Omer Adam, Hebrew) — full 3:32 via SoundCloud, 55 synced
  Hebrew lines from LRCLIB, stage rendering RTL correctly.
- טרנטונה (Tuna, Hebrew) — zero sources on the old query → full 2:49 via
  the new title-variant cascade.
- Block fullstream → honest download-failed message → unblock → retry →
  full song recovered.
- Network Doctor: 8 rows live (SC ok 19ms, Audius ok, LRCLIB ok, NetEase
  ok, iTunes ok, YouTube embed blocked — the honest datacenter wall, YouTube
  direct blocked, ffmpeg ok).
- Zero console errors, zero page errors, lint clean, `tsc --noEmit` clean.

## 5.0 — FULL SONGS, ALWAYS: SOUNDCLOUD + AUDIUS (2026-11-14)

The "it finally just works" release. The core complaint since v2.0 — "only a
30-second clip plays, the full song never loads" — is structurally fixed:
full-length playback no longer depends on YouTube at all.

### THE PROBLEM (measured from this machine)

- **YouTube embeds** — blocked on the user's network; the browser probe gate
  honestly reported "this network is likely blocked by YouTube" (v4.0) but the
  user still got a 30s preview as the only music.
- **YouTube direct audio (innertube)** — Google now requires PO tokens from
  datacenter IPs: ANDROID returns FAILED_PRECONDITION, every public Piped
  instance returns "Sign in to confirm you're not a bot". Tier dead.
- **NetEase outer URL** — redirects to a 404 page. Anonymous player URLs give
  `url: null`. Dead.
- **Archive.org** — connection refused from this network. Dead.

### THE FIX: two independent FULL-LENGTH catalogs, both verified live

- **SoundCloud** — millions of full-length covers, remixes and instrumentals
  (policy ALLOW, not snipped). Anonymous web client_id **extracted live from
  soundcloud.com's JS bundles** (cached 6h, auto re-extracted on auth failure,
  hard-coded fallback), search via `api-v2.soundcloud.com/search` with a
  strict full-track filter (policy ALLOW, duration ≥ 60s, `duration ≥
  full_duration × 0.95`, at least one non-snipped transcoding). Streams:
  progressive transcodings pass through directly; **HLS playlists (init.mp4 +
  dataNNN.m4s) are fetched server-side and concatenated in order** into one
  fMP4 the browser decodes in a single `decodeAudioData` — verified: a 3:35
  cover arrives as 4.35MB valid MP4 in 5.8s and **decodes natively in Chrome
  without the ffmpeg fallback** (which exists anyway: `/fullstream?transcode=1`
  → 192k mp3).
- **Audius** — decentralized catalog, free discovery API, full-length mp3s
  via the `/v1/tracks/{id}/stream` redirect. Deleted tracks leak into search
  results and 404 on stream — filtered by `is_streamable`/`is_delete`.
- **Matching** — provider tracks are scored against catalog rows (title token
  coverage ≥ 0.65, artist overlap, duration ratio 0.65–1.45; nightcore/sped/
  8d/mashup penalized) and attached as `fullSources` (top 3 per song). Strong
  unmatched full tracks become **standalone rows** (guaranteed full, with
  LRCLIB hints parsed from cover titles: "Artist - Song (Cover by X)").
- **All bytes flow same-origin** through `/api/discover/fullstream` — the
  server does every bit of external talking (client_id, signed playlists,
  segments), so the user's blocked network can't stand between them and the
  music. Byte-level LRU (8 tracks) makes replays instant.

### THE NEW TIER ORDER (loadDiscoverSong)

1. **Full-length source** (search-time list or fresh `/fullsong` resolve) →
   download → decode into Web Audio → `engine.loadSong` → **the whole karaoke
   machine (vocal removal, key shift, speed, melody scan, scoring, recording)
   runs on the REAL FULL SONG**. The 30s shell is now LAZY — it only
   downloads when a fallback needs it, so a playing full song is never
   replaced mid-flight.
2. YouTube embeds (probe gate) — kept warm in parallel, used only if tier 1
   finds nothing.
3. 30s preview — honestly labeled, with the real reason + one-click retry
   (which now retries tier 1 first).

### UI (the approved look, untouched — only additions)

- Green **FULL** badge on every catalog card/row with verified full-length
  sources (HE: מלא).
- Studio chips: **שיר מלא · SOUNDCLOUD / FULL SONG · AUDIUS** while a full
  song owns the clock, a spinner while it downloads, source + duration line.
- Standalone SC rows get an artwork placeholder (no more empty `src=""`).
- `overflow-x-clip` on the root — icon SVG paths could inflate scrollWidth on
  narrow screens; the page never side-scrolls now.
- v4.0 bug fixed: the "off" button never paused the engine (`seek()` alone
  doesn't pause) — a direct/full song kept playing after "off".

### VERIFIED END-TO-END (agent-browser, from this machine)

- Search "believer imagine dragons" → 16/26 cards with FULL badges.
- Click Believer → **SoundCloud full song (3:26) plays inside Web Audio**,
  YouTube skipped entirely, LRCLIB synced lyrics line-highlighting exact
  ("[00:51.45] Seeing the beauty through the…" active at pos 52.3s), played
  **to natural end (pos 206/206)**.
- Click Counting Stars → **Audius full song (3:46)** plays instantly,
  synced lyrics, audio level 0.8 — both providers verified in the browser.
- Single fullstream request per song (native fMP4 decode, no transcode
  needed), zero console errors after fixes, EN/HE both live, mobile 390px
  clean (no side-scroll, vertical scroll intact).

## 3.5 — THE HUNTER RELEASE: CLIENT ROTATION + LYRIC CASCADE (2026-11-14)

The "execute with the hunter" release. The hunter's methodology (mine the
elite's working patterns, apply them with evidence) produced two hardening
layers, both mined live from GitHub and both verified from this machine.

### THE HUNT (what was mined and why)

- **LuanRT/YouTube.js (5.4k★)** — the reference innertube client. Its
  Constants file holds the full client roster (exact clientNames, versions,
  numeric ids, UAs, device models). DNA extracted: the **client rotation
  chain** — a single innertube recipe dies the moment YouTube walls that one
  client; the standard is a chain of clients with different bot-wall
  fingerprints.
- **kawishbit/akapela** — a self-hostable karaoke app with the same
  architecture direction (audio-only ADR, YouTube sources, lyrics providers).
  DNA extracted: the **multi-provider lyrics cascade** with a visible
  provider chip in the UI ("the screen shows which provider the current
  Lyrics came from").
- Provider field tests from this machine (measured, not assumed): **Genius
  403s** (Cloudflare), **Lyrist sits behind a Vercel JS wall** (429),
  **NetEase Music's public API works** — synced LRC, no key, reachable from
  datacenter IPs. NetEase won the fallback slot on evidence.

### PLAYBACK: THE CLIENT ROTATION (yt-audio-server.ts)

- The direct-audio tier now rotates **three verified innertube clients** —
  VISIONOS (id 101) → ANDROID_VR (id 28, Oculus Quest 3) → IOS (id 5,
  iPhone) — each with its exact version, UA, device model and numeric client
  id from the youtubei.js roster. When YouTube walls one client from
  datacenter IPs, the next still resolves.
- Every client in the chain was **verified from this machine with live
  innertube POSTs**: VISIONOS (itags 139,140,249,250,251), ANDROID_VR
  (139,140,249,251), IOS (139,140) all return cipher-free googlevideo audio
  URLs. ANDROID (ciphered — needs PO token), TVHTML5 (UNPLAYABLE) and
  ANDROID_MUSIC (refuses) were tested and **kept out** so no stall budget
  is wasted on a client that can never resolve.
- The resolving client's UA also fetches the bytes (googlevideo binds URLs
  to the requesting client), tracked per-source in a new `client` field.

### LYRICS: THE 4-STAGE PROVIDER CASCADE (discover-server.ts)

- LRCLIB keeps stages 1-3 (exact /api/get → search → fuzzy search). New
  **stage 4: NetEase Music** — search (`/api/search/get`) → match (the same
  normalized artist/title/duration discipline as LRCLIB's pickBestHit,
  with a minimum-match floor so a vague similarity never attaches wrong
  lyrics) → synced LRC (`/api/song/lyric?lv=1`), the same `[mm:ss.mmm]`
  format the stage already renders.
- Every NetEase call is total (any failure → null → the stage falls through
  to plain/manual), behind the same 9s/7s timeouts, with the browser UA +
  Referer that the endpoint expects.
- **Provider transparency (akapela DNA):** the prepare response now carries
  the provider, and the studio shows a chip — LRCLIB / NETEASE — next to
  the synced badge, so the singer always knows where the words came from.

### EVIDENCE (all measured live, this session)

- Innertube client matrix (curl, direct POSTs): 3 verified working clients,
  3 tested-and-rejected, documented in code.
- Direct-audio probe: `ok:true`, 3.4MB m4a AAC resolved; Range request →
  HTTP 206 with 64KB slice (passthrough intact).
- Prepare cascade: Rick Astley full mode → `provider: lrclib`, 59-line
  synced LRC; BTS Dynamite → `provider: lrclib`; Hebrew catalog probes →
  NetEase search finds the songs (metadata-only entries return null
  cleanly — never wrong lyrics).
- Browser end-to-end: Rick Astley full-song session — iframe tier playing
  (0:38/3:33, clock advancing), current line highlighted in place, LRCLIB
  chip visible in the top bar, zero console errors.

## 3.4 — FULL SONGS, VERIFIED IN THE BROWSER (2026-11-14)

The "find other solutions, use the hunter" release. Field evidence (browser
probes with real iframe players) exposed the true failure chain behind the
29-second fallback, and this release fixes playback at every tier with
evidence-backed engineering.

### WHAT THE EVIDENCE SHOWED
- **oEmbed lies**: the v3.2 server-side embeddability filter returned
  "embeddable" (HTTP 200) for videos the iframe player then rejects with
  error 150. The resolver was shipping dead sources to the client on every
  resolve. The filter is **removed**.
- **Embed-blocked ≠ rare**: in a datacenter environment the iframe player
  150s most uploads (official videos, lyric channels, even karaoke-channel
  tracks), silently or in ~1s. The old cascade burned its whole stall
  budget on sources that could never play.
- **Embeds that work, work instantly**: verified end-to-end — a muted
  iframe reaches PLAYING with the clock advancing in ~1s; blocked sources
  fire onError=150 in ~1-2s. The browser is the only ground truth.

### THE PROBE GATE (v3.3 core)
- Every server-ranked candidate (up to 12, was 8) is now mounted as a tiny
  **muted iframe** and played in parallel — **in waves of 6**, so all ranked
  sources get their chance. The first source whose clock actually moves
  (PLAYING + `getCurrentTime > 0.05`) is promoted to the live session; a
  source claiming PLAYING at a frozen 0 (bot wall fingerprint) never
  passes. A whole wave dying launches the next wave; the gate fails only
  when every candidate is dead.
- The live session **starts muted** (autoplay-policy safe): the clock, the
  lyrics and the mic pipeline run from the first second, and one tap on
  the **"tap to turn the sound on"** overlay (the user gesture the browser
  demands) unmutes at full volume.
- Probing a working source resets the environment stall brake; per-video
  errors never do.

### THE DIRECT-AUDIO TIER (v3.4 core — the "other solution")
- A second, independent full-song engine: the server resolves a direct,
  cipher-free audio stream via the **visionos innertube client** (the one
  recipe verified from this machine to return playable googlevideo URLs),
  picks itag 140 (m4a AAC) with Opus fallbacks, and **proxies the bytes**
  with Range passthrough (`/api/discover/stream`) — googlevideo URLs are
  IP-locked, so the browser must fetch through us.
- The client downloads the track (32MB ceiling), decodes it into Web
  Audio and loads it as the engine's song — which means the **entire
  karaoke machine now runs on the full song**: live vocal removal, vocal
  isolation, key shift, speed, melody scan, pitch scoring, A-B loop and
  recording, none of which can process iframe audio.
- The tier fires wherever the iframe tier failed: all probe waves dead,
  a mid-session cascade, or a manually pasted link that cannot embed —
  each gets the direct attempt before any fallback. Server-side walls are
  cached 30min, resolved sources 4h.

### THE LYRICS RACES (fixed at the state machine)
- `applyPrepare` now treats **probing as full**: a full-song LRC that
  lands while the probe gate is still deciding used to be dropped
  (ytActive was false) — under the gate that meant "no lyrics at all".
  Now full-timeline lyrics attach during probing, during the iframe
  session, and on the direct-audio song, and every stale timeline (clip
  words on a full song, full timestamps on a 30s clip) is dropped.
- `attachFullLyrics` serves all three tiers; `retryLyrics` re-attaches on
  the real song id (`yt:<id>` in direct mode — the preview shell is no
  longer clobbered over a full song).

### EVIDENCE (fable-evidence-done discipline, from the hunter DNA)
- Rick Astley full song via iframe: `0:20 / 3:33`, first line highlighted
  in place, word-level fill visible, no errors (browser-verified).
- Queen: 12 candidates probed in 2 waves (~2s), all error 150 → 5 direct
  probes → honest preview + clip-synced lyrics, `0 dead iframes` left in
  the DOM.
- Hebrew (אבי הטחול): preview + plain-lyrics static list — LRCLIB has no
  synced LRC for it; the stage never sits empty.
- Manual paste of a walled link: iframe 150 → direct attempt → honest
  fallback, zero page errors.
- Stage mode, desktop and 390px mobile layouts verified clean.

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
