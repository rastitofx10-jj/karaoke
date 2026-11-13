/* TITO KARAOKE STUDIO v1.0 — LRC / SRT lyrics engine
 * Pure logic, zero dependencies (no npm packages, no DOM, no Node APIs):
 * parsing (standard + enhanced LRC, SRT, plain text), serialization and the
 * timeline / text queries the karaoke UI is built on.
 * Every export is total: malformed input never throws — it is skipped or
 * best-effort repaired.
 */

import type { LrcLine, LrcSong, LrcWord } from '@/lib/karaoke/types';

/* ------------------------------------------------------------------ */
/* internal constants & helpers                                        */
/* ------------------------------------------------------------------ */

/** Leading LRC line tag: `[mm:ss]`, `[mm:ss.xx]`, `[mm:ss.xxx]`, `[mm:ss:xx]`. */
const TIME_TAG_RE = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;

/** Inline enhanced-LRC word tag: `<mm:ss.xx>` — fraction optional, `.` or `:` mark. */
const WORD_TAG_RE = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

/** Word-tag pattern without captures, used only to strip leftover tags. */
const WORD_TAG_STRIP_RE = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

/** LRC metadata tags consumed by the parser (case-insensitive). */
const ID_TAG_RE = /^\[(ti|ar|al|by|offset)\s*:\s*([^\]]*)\]\s*$/i;

/** Main-text / translation separator: ` // ` or ` | ` (whitespace on both sides). */
const SUB_SEP_RE = /\s+\/\/\s+|\s+\|\s+/;

/** A closed LRC time tag at the start of a row — format auto-detection. */
const LRC_DETECT_RE = /^[ \t]*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/m;

/** SRT cue timecode at the start of a row: `hh:mm:ss,mmm --> hh:mm:ss,mmm`. */
const SRT_TIME_RE =
  /^\s*(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;

/** An SRT timecode row — format auto-detection. */
const SRT_DETECT_RE = /^[ \t]*\d{1,3}:\d{1,2}:\d{1,2}[,.]\d{1,3}\s*-->/m;

/** Hebrew letters (U+05D0–U+05EA) — excludes niqqud and cantillation marks. */
const HEBREW_LETTER_LO = 0x05d0;
const HEBREW_LETTER_HI = 0x05ea;

/** Rough average Hebrew letters per syllable for the counting heuristic. */
const HEBREW_LETTERS_PER_SYLLABLE = 2.2;

/** Vowels for the Latin syllable heuristic (accented variants included). */
const LATIN_VOWELS = new Set('aeiouyàáâãäåèéêëìíîïòóôõöùúûüýÿ');

/** One physical LRC row before its timestamps are expanded into lines. */
interface LrcRow {
  times: number[];
  text: string;
  sub?: string;
  words?: LrcWord[];
}

/** BOM strip + defensive non-string guard for public entry points. */
function normalizeText(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/** `x` when finite, otherwise the fallback — keeps every query total. */
function finite(x: number | undefined, fallback: number): number {
  return x !== undefined && Number.isFinite(x) ? x : fallback;
}

/** parseInt that never yields NaN (only regex-validated digits reach this). */
function toInt(value: string | undefined): number {
  if (!value) return 0;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

/** LRC tag captures to seconds — fraction length aware (`.5` = 0.5s). */
function tagSeconds(
  min: string | undefined,
  sec: string | undefined,
  frac: string | undefined,
): number {
  let t = toInt(min) * 60 + toInt(sec);
  if (frac) t += toInt(frac) / 10 ** frac.length;
  return t;
}

/** SRT cue captures to seconds (hours included). */
function cueSeconds(
  h: string | undefined,
  m: string | undefined,
  s: string | undefined,
  ms: string | undefined,
): number {
  let t = toInt(h) * 3600 + toInt(m) * 60 + toInt(s);
  if (ms) t += toInt(ms) / 10 ** ms.length;
  return t;
}

/** Clamps to the closed interval [0, 1]; NaN collapses to 0. */
function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** `mm:ss.cc` timestamp (two-digit centiseconds), floored at `00:00.00`. */
function fmtTime(t: number): string {
  const v = finite(t, 0);
  const cs = Math.round(v > 0 ? v * 100 : 0);
  const mm = Math.floor(cs / 6000);
  const ss = Math.floor((cs % 6000) / 100);
  const cc = cs % 100;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cc).padStart(2, '0')}`;
}

/** Basename without extension — `dir/song.lrc` becomes `song`. */
function titleFromFilename(filename: string | undefined): string | undefined {
  if (typeof filename !== 'string' || filename.length === 0) return undefined;
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const stripped = base.replace(/\.[^./\\]*$/, '').trim();
  return stripped.length > 0 ? stripped : undefined;
}

/** Strong left-to-right base direction (Latin, Greek, Cyrillic, Armenian, CJK, Hangul). */
function isStrongLtr(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0xc0 && code <= 0x24f && code !== 0xd7 && code !== 0xf7) || // Latin-1 + ext A/B
    (code >= 0x1e00 && code <= 0x1eff) || // Latin extended additional
    (code >= 0x370 && code <= 0x52f) || // Greek + Cyrillic
    (code >= 0x530 && code <= 0x58f) || // Armenian
    (code >= 0x1100 && code <= 0x11ff) || // Hangul jamo
    (code >= 0x2e80 && code <= 0x9fff) || // CJK radicals .. unified ideographs
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) // CJK compatibility ideographs
  );
}

/* ------------------------------------------------------------------ */
/* parsing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Parses standard and enhanced (word-level timing) LRC lyrics.
 *
 * Supported syntax:
 * - Line tags `[mm:ss]`, `[mm:ss.xx]`, `[mm:ss.xxx]` and `[mm:ss:xx]`
 *   (colon as the centisecond mark), several tags per row — the row's text
 *   is emitted once per tag.
 * - ID tags `[ti:]`, `[ar:]`, `[al:]`, `[by:]` and `[offset:+/-ms]`.
 *   A positive offset shifts lyrics earlier — every line and word time is
 *   reduced by `offsetMs / 1000` and clamped to zero.
 * - Inline word tags `<mm:ss.xx>`: each tag owns the text up to the next tag
 *   (trimmed). Rows with word tags get a `words` array and their `text`
 *   rebuilt by joining the words with single spaces. Word `end` is left
 *   undefined (see `withDerivedEnds`).
 * - A ` // ` or ` | ` separator splits main text from a translation (`sub`),
 *   but only when both sides are non-empty.
 *
 * Rows without a valid time tag are ignored completely; empty-text tags are
 * kept as lines with `text: ''`. Output is sorted by time (stable — duplicate
 * timestamps keep file order). Never throws.
 */
export function parseLrc(raw: string): LrcSong {
  const song: LrcSong = { lines: [] };
  const rows: LrcRow[] = [];
  let offsetMs: number | undefined;

  for (const rawLine of normalizeText(raw).split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const id = ID_TAG_RE.exec(line);
    if (id !== null) {
      const value = id[2].trim();
      if (value.length > 0) {
        switch (id[1].toLowerCase()) {
          case 'ti':
            song.title = value;
            break;
          case 'ar':
            song.artist = value;
            break;
          case 'al':
            song.album = value;
            break;
          case 'by':
            song.by = value;
            break;
          case 'offset': {
            const n = parseInt(value, 10);
            if (Number.isFinite(n)) offsetMs = n;
            break;
          }
        }
      }
      continue;
    }

    // Consume every leading time tag, then keep the remainder as content.
    const times: number[] = [];
    let rest = line;
    for (let tag = TIME_TAG_RE.exec(rest); tag !== null; tag = TIME_TAG_RE.exec(rest)) {
      times.push(tagSeconds(tag[1], tag[2], tag[3]));
      rest = rest.slice(tag[0].length);
    }
    if (times.length === 0) continue; // malformed row — ignored completely
    rest = rest.trim();

    // Main text / translation split (first separator wins).
    let main = rest;
    let sub: string | undefined;
    const sep = SUB_SEP_RE.exec(rest);
    if (sep !== null) {
      const head = rest.slice(0, sep.index).trim();
      const tail = rest.slice(sep.index + sep[0].length).trim();
      if (head.length > 0 && tail.length > 0) {
        main = head;
        sub = tail;
      }
    }

    // Enhanced word timing.
    let text = main;
    let words: LrcWord[] | undefined;
    const wordTags: { t: number; start: number; end: number }[] = [];
    for (const tag of main.matchAll(WORD_TAG_RE)) {
      wordTags.push({
        t: tagSeconds(tag[1], tag[2], tag[3]),
        start: tag.index,
        end: tag.index + tag[0].length,
      });
    }
    if (wordTags.length > 0) {
      // Text before the first tag (unusual) is folded into the first word.
      let pendingPrefix = main.slice(0, wordTags[0].start).trim();
      const parsed: LrcWord[] = [];
      for (let i = 0; i < wordTags.length; i++) {
        const segEnd = i + 1 < wordTags.length ? wordTags[i + 1].start : main.length;
        const segment = main.slice(wordTags[i].end, segEnd).trim();
        if (segment.length === 0) continue;
        let wordText = segment;
        if (pendingPrefix.length > 0) {
          wordText = `${pendingPrefix} ${segment}`;
          pendingPrefix = '';
        }
        parsed.push({ t: wordTags[i].t, text: wordText });
      }
      if (parsed.length > 0) {
        words = parsed;
        text = parsed.map((w) => w.text).join(' ');
      } else {
        text = main.replace(WORD_TAG_STRIP_RE, ' ').replace(/\s+/g, ' ').trim();
      }
    }

    const row: LrcRow = { times, text };
    if (sub !== undefined) row.sub = sub;
    if (words !== undefined) row.words = words;
    rows.push(row);
  }

  // Apply the offset (positive = earlier) and expand multi-timestamp rows.
  const shift = (offsetMs ?? 0) / 1000;
  const lines: LrcLine[] = [];
  for (const row of rows) {
    for (const time of row.times) {
      const line: LrcLine = { time: Math.max(0, time - shift), text: row.text };
      if (row.words !== undefined) {
        line.words = row.words.map((w) => ({ t: Math.max(0, w.t - shift), text: w.text }));
      }
      if (row.sub !== undefined) line.sub = row.sub;
      lines.push(line);
    }
  }
  lines.sort((a, b) => a.time - b.time); // Array#sort is stable (ES2019+)
  if (offsetMs !== undefined) song.offsetMs = offsetMs;
  song.lines = lines;
  return song;
}

/**
 * Parses SubRip (.srt) subtitles into an `LrcSong`.
 *
 * Cue timecodes `hh:mm:ss,mmm --> hh:mm:ss,mmm` (a `.` millisecond mark is
 * tolerated) become `time` = start and `end` = stop in seconds. Cue index
 * numbers are skipped, multi-line cue text is joined with single spaces, and
 * HTML-ish markup (`<i>`, `<b>`, `<font ...>`) plus ASS overrides (`{\an8}`)
 * are stripped. Cues that end up with no text are skipped. Output is sorted
 * by start time. Never throws.
 */
export function parseSrt(raw: string): LrcSong {
  const rows = normalizeText(raw).split(/\r\n|\r|\n/);
  const lines: LrcLine[] = [];
  let i = 0;

  while (i < rows.length) {
    // Skip blank block separators.
    while (i < rows.length && rows[i].trim().length === 0) i++;
    if (i >= rows.length) break;

    let start = 0;
    let stop = 0;
    let hasTime = false;
    const textRows: string[] = [];

    while (i < rows.length && rows[i].trim().length > 0) {
      const row = rows[i];
      const cue = SRT_TIME_RE.exec(row);
      if (cue !== null) {
        if (hasTime) break; // next cue began without a blank separator
        start = cueSeconds(cue[1], cue[2], cue[3], cue[4]);
        stop = cueSeconds(cue[5], cue[6], cue[7], cue[8]);
        hasTime = true;
        i++;
        continue;
      }
      if (hasTime) textRows.push(row);
      // else: cue index number or junk before the timecode — skipped
      i++;
    }

    if (!hasTime) continue;
    const text = textRows
      .map((row) => row.replace(/<\/?[a-z][^>]*>/gi, '').replace(/\{[^}]*\}/g, '').trim())
      .filter((row) => row.length > 0)
      .join(' ');
    if (text.length > 0) {
      lines.push({ time: start, end: Math.max(start, stop), text });
    }
  }

  lines.sort((a, b) => a.time - b.time);
  return { lines };
}

/**
 * Auto-detects the lyrics format and parses it.
 *
 * SRT timecode rows (`.. --> ..`) select SRT parsing, a closed `[mm:ss..]`
 * tag at the start of any row selects LRC parsing, and anything else is
 * treated as plain unsynced text: one `LrcLine` per non-empty row with
 * `time = -1` (sentinel for "unsynced"), order preserved. When `filename`
 * is supplied and the song carries no title, the file's basename without
 * extension is used as the title. Never throws.
 */
export function parseLyrics(raw: string, filename?: string): LrcSong {
  const text = normalizeText(raw);
  let song: LrcSong;

  if (SRT_DETECT_RE.test(text)) {
    song = parseSrt(text);
  } else if (LRC_DETECT_RE.test(text)) {
    song = parseLrc(text);
  } else {
    const lines: LrcLine[] = [];
    for (const row of text.split(/\r\n|\r|\n/)) {
      const trimmed = row.trim();
      if (trimmed.length > 0) lines.push({ time: -1, text: trimmed });
    }
    song = { lines };
  }

  if (!song.title) {
    const title = titleFromFilename(filename);
    if (title !== undefined) song.title = title;
  }
  return song;
}

/* ------------------------------------------------------------------ */
/* serializing                                                         */
/* ------------------------------------------------------------------ */

/**
 * Serializes an `LrcSong` back to (enhanced) LRC text.
 *
 * `[ti/ar/al/by:]` tags are emitted for present metadata and `[offset:+ms]`
 * only when `offsetMs` is non-zero (times themselves are written as-is —
 * they are not shifted by this function). Each line becomes `[mm:ss.xx]text`
 * or, when it carries a `words` array, `[mm:ss.xx] <mm:ss.xx>word ...` with
 * the words emitted as-is on one row. Negative times are clamped to
 * `00:00.00`; `sub` translations are not serialized (LRC has no standard
 * for them). Never throws.
 */
export function serializeLrc(song: LrcSong): string {
  const rows: string[] = [];
  if (song.title) rows.push(`[ti:${song.title}]`);
  if (song.artist) rows.push(`[ar:${song.artist}]`);
  if (song.album) rows.push(`[al:${song.album}]`);
  if (song.by) rows.push(`[by:${song.by}]`);
  if (typeof song.offsetMs === 'number' && Number.isFinite(song.offsetMs) && song.offsetMs !== 0) {
    const offset = Math.round(song.offsetMs);
    rows.push(`[offset:${offset > 0 ? '+' : ''}${offset}]`);
  }

  const lines = Array.isArray(song.lines) ? song.lines : [];
  for (const line of lines) {
    let row = `[${fmtTime(line.time)}]`;
    const words = Array.isArray(line.words) ? line.words : [];
    if (words.length > 0) {
      for (const word of words) {
        row += ` <${fmtTime(word.t)}>${word.text}`;
      }
    } else {
      row += line.text;
    }
    rows.push(row);
  }
  return rows.join('\n');
}

/* ------------------------------------------------------------------ */
/* timeline queries                                                    */
/* ------------------------------------------------------------------ */

/**
 * Returns a copy of `lines` (the input is not mutated) where every line gets
 * an `end`: line *i* ends when line *i+1* starts and the last line ends at
 * `totalDuration`. Word timings get the same treatment — word *i* ends when
 * word *i+1* starts, the last word ends with its line. Lines with `time < 0`
 * (unsynced sentinels) are skipped and do not appear in the result. Never
 * throws; degenerate spans collapse to zero duration instead of inverting.
 */
export function withDerivedEnds(lines: LrcLine[], totalDuration: number): LrcLine[] {
  const source = Array.isArray(lines) ? lines : [];
  const synced = source.filter((l) => Number.isFinite(l.time) && l.time >= 0);
  const n = synced.length;
  if (n === 0) return [];

  const lastTime = synced[n - 1].time;
  const duration = Number.isFinite(totalDuration) ? Math.max(0, totalDuration) : lastTime;

  return synced.map((line, i) => {
    const endTime =
      i + 1 < n ? Math.max(line.time, synced[i + 1].time) : Math.max(line.time, duration);
    const out: LrcLine = { time: line.time, end: endTime, text: line.text };
    if (line.sub !== undefined) out.sub = line.sub;

    const srcWords = Array.isArray(line.words) ? line.words : undefined;
    if (srcWords !== undefined) {
      // Sanitize first, then derive — word i ends at word i+1's start.
      const words = srcWords.map((w) => ({ t: finite(w.t, 0), text: w.text }));
      out.words = words.map((w, j) => {
        const nextStart = j + 1 < words.length ? words[j + 1].t : endTime;
        const word: LrcWord = { t: w.t, end: Math.max(w.t, nextStart), text: w.text };
        return word;
      });
    }
    return out;
  });
}

/**
 * Index of the line whose half-open span `[time, end)` contains `t`, found
 * by binary search — `lines` must be sorted by time. Returns -1 before the
 * first line, inside gaps between (derived) spans, and after the last span's
 * end. Lines with `time < 0` are ignored; a missing `end` counts as
 * unbounded. Never throws.
 */
export function activeLineIndex(lines: LrcLine[], t: number): number {
  if (!Array.isArray(lines) || !Number.isFinite(t)) return -1;

  // Skip the unsynced prefix (negative times sort first): lower bound of time >= 0.
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid].time < 0) lo = mid + 1;
    else hi = mid;
  }
  const first = lo;
  if (first >= lines.length) return -1;

  // Last line with time <= t (times are sorted ascending).
  lo = first;
  hi = lines.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid].time <= t) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (candidate < 0) return -1;

  const end = finite(lines[candidate].end, Number.POSITIVE_INFINITY);
  return t < end ? candidate : -1;
}

/**
 * Continuous 0..1 karaoke fill for one line at time `t`.
 *
 * With word timings the fill is piecewise-linear across the words: word *i*
 * maps to the progress range `[i/n, (i+1)/n]`, interpolating inside the word
 * (`word i` occupies `[words[i].t, words[i].end ?? next word t ?? line end]`)
 * and holding still in gaps between words. `t` before the line start gives
 * 0, at or after the line end gives 1. Without word timings the fill is
 * linear over `[line.time, line.end ?? line.time + 3]`. Never throws.
 */
export function lineProgress(line: LrcLine, t: number): number {
  if (!line || !Number.isFinite(t)) return 0;
  const start = finite(line.time, 0);
  const words = Array.isArray(line.words) ? line.words : [];

  if (words.length === 0) {
    const end = finite(line.end, start + 3);
    if (end <= start) return t >= start ? 1 : 0;
    return clamp01((t - start) / (end - start));
  }

  const n = words.length;
  const last = words[n - 1];
  const lineEnd = Math.max(finite(line.end, finite(last.end, finite(last.t, start))), start);
  if (t <= start) return 0;
  if (t >= lineEnd) return 1;

  for (let i = 0; i < n; i++) {
    const wordStart = finite(words[i].t, 0);
    const nextStart = i + 1 < n ? finite(words[i + 1].t, 0) : lineEnd;
    const wordEnd = finite(words[i].end, nextStart);
    if (t < wordStart) return clamp01(i / n); // gap before this word
    if (t < wordEnd) {
      const span = wordEnd - wordStart;
      const frac = span > 0 ? (t - wordStart) / span : 1;
      return clamp01((i + frac) / n);
    }
  }
  return 1; // trailing gap after the last word
}

/* ------------------------------------------------------------------ */
/* text heuristics                                                     */
/* ------------------------------------------------------------------ */

/**
 * Base direction of the text: `'rtl'` when the first strong directional
 * character within the first 40 characters is Hebrew (U+0590–U+05FF) or
 * Arabic (U+0600–U+06FF), otherwise `'ltr'` — also the default when no
 * strong character is found. Digits, punctuation and whitespace are neutral
 * and skipped. Never throws.
 */
export function detectDir(text: string): 'rtl' | 'ltr' {
  const s = typeof text === 'string' ? text : '';
  const limit = Math.min(s.length, 40);
  for (let i = 0; i < limit; i++) {
    const code = s.charCodeAt(i);
    if ((code >= 0x0590 && code <= 0x05ff) || (code >= 0x0600 && code <= 0x06ff)) return 'rtl';
    if (isStrongLtr(code)) return 'ltr';
  }
  return 'ltr';
}

/**
 * Cheap syllable estimate — never throws.
 *
 * Latin: vowel groups (`aeiouy`, accented variants included, so diphthongs
 * count once). Hebrew: letter count (niqqud excluded) divided by 2.2, rounded
 * up, minimum 1 when any Hebrew letter exists. CJK (incl. kana and Hangul):
 * one per character. Scripts are counted independently and summed, so mixed
 * text works.
 */
export function countSyllables(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const s = text.toLowerCase();

  let latinLetters = 0;
  let vowelGroups = 0;
  let inVowelGroup = false;
  let hebrewLetters = 0;
  let cjkChars = 0;

  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const isLatin =
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0xc0 && code <= 0x24f) ||
      (code >= 0x1e00 && code <= 0x1eff);
    if (isLatin) {
      latinLetters++;
      const isVowel = LATIN_VOWELS.has(s.charAt(i));
      if (isVowel && !inVowelGroup) vowelGroups++;
      inVowelGroup = isVowel;
      continue;
    }
    inVowelGroup = false;
    if (code >= HEBREW_LETTER_LO && code <= HEBREW_LETTER_HI) {
      hebrewLetters++;
    } else if (
      (code >= 0x3040 && code <= 0x30ff) || // kana
      (code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
      (code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
      (code >= 0xac00 && code <= 0xd7a3) // Hangul syllables
    ) {
      cjkChars++;
    }
  }

  const latin = vowelGroups > 0 ? vowelGroups : latinLetters > 0 ? 1 : 0;
  const hebrew =
    hebrewLetters > 0 ? Math.max(1, Math.ceil(hebrewLetters / HEBREW_LETTERS_PER_SYLLABLE)) : 0;
  return latin + hebrew + cjkChars;
}
