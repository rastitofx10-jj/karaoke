/* TITO KARAOKE STUDIO v1.0 — persistence layer
 * IndexedDB for songs (audio blobs + optional LRC + optional scanned melody)
 * and takes (recorded WAV + score), localStorage for settings.
 * Raw IndexedDB API only (no `idb` package). Every async function is
 * never-throw: failures land in `lastStorageError()` and a safe fallback
 * is returned. Errors are never logged to the console.
 *
 * SSR-safe: the module top level is inert — IndexedDB / localStorage are
 * only ever touched inside functions.
 */

import type {
  SongMeta,
  SongRecord,
  TakeMeta,
  TakeRecord,
} from '@/lib/karaoke/types';

/* ---------- module state (all lazy, no browser access at import time) ---------- */

const DB_NAME = 'tito-karaoke';
const DB_VERSION = 1;
const STORE_SONGS = 'songs';
const STORE_TAKES = 'takes';
const SETTINGS_PREFIX = 'tito-karaoke:settings:';

/** Cached open-DB promise so the DB is opened/created exactly once. */
let dbPromise: Promise<IDBDatabase> | null = null;

/** Last error message from any storage operation; null when the last op succeeded. */
let lastErrMsg: string | null = null;

/**
 * The most recent storage error message, or null if the last operation
 * succeeded. Reset at the start of every public operation.
 */
export function lastStorageError(): string | null {
  return lastErrMsg;
}

/** Normalize an unknown thrown value into a short human-readable message. */
function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/* ---------- tiny promise wrappers over the raw IDB API ---------- */

/** Resolve with the request result; reject with the request error. */
function reqDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** Resolve when the transaction commits; reject when it aborts or errors. */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

/* ---------- open / upgrade ---------- */

/**
 * Open (and upgrade on first run) the `tito-karaoke` database.
 * The promise is cached at module level; a failed open clears the cache so
 * the next call can retry. Rejects (never throws synchronously).
 */
function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        // SSR pass / very old browser — nothing we can do.
        reject(new Error('IndexedDB is not available in this environment'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_SONGS)) {
          db.createObjectStore(STORE_SONGS, { keyPath: 'id' })
            .createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains(STORE_TAKES)) {
          const takes = db.createObjectStore(STORE_TAKES, { keyPath: 'id' });
          takes.createIndex('createdAt', 'createdAt');
          takes.createIndex('songId', 'songId');
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Be a polite tab: yield to future version upgrades, and retry-open
        // if the connection drops unexpectedly (e.g. DB deleted elsewhere).
        db.onversionchange = () => db.close();
        db.onclose = () => {
          if (dbPromise !== null) dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new Error('Failed to open tito-karaoke DB'));
      req.onblocked = () => reject(new Error('DB open blocked by another tab'));
    });
    // A failed open must not poison the cache forever — allow a retry.
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

/** Resolve the cached DB, or null after recording the error in lastError. */
async function getDb(): Promise<IDBDatabase | null> {
  try {
    return await openDb();
  } catch (e) {
    lastErrMsg = errMessage(e);
    return null;
  }
}

/**
 * Open/create the database once and report health. Safe to call from
 * anywhere, any number of times, concurrently.
 *
 * @returns true when the DB handle is ready, false on failure
 *          (reason in {@link lastStorageError}).
 */
export async function dbReady(): Promise<boolean> {
  lastErrMsg = null;
  try {
    await openDb();
    return true;
  } catch (e) {
    lastErrMsg = errMessage(e);
    return false;
  }
}

/* ---------- meta projection (strip heavy fields) ---------- */

/**
 * Project a stored SongRecord to its lightweight SongMeta (no audio / lrc /
 * melody). Meta flags are re-derived from the actual payload so old or
 * hand-built records stay consistent.
 */
function toSongMeta(rec: SongRecord): SongMeta {
  const sizeBytes =
    Number.isFinite(rec.sizeBytes) ? rec.sizeBytes : blobSize(rec.audio);
  return {
    id: rec.id,
    title: typeof rec.title === 'string' ? rec.title : '',
    artist: typeof rec.artist === 'string' ? rec.artist : undefined,
    createdAt: Number.isFinite(rec.createdAt) ? rec.createdAt : 0,
    durationSec: Number.isFinite(rec.durationSec) ? rec.durationSec : 0,
    hasLrc: typeof rec.lrc === 'string' && rec.lrc.length > 0,
    hasMelody: !!rec.melody && Array.isArray(rec.melody.notes),
    sizeBytes: sizeBytes > 0 ? sizeBytes : blobSize(rec.audio),
  };
}

/** Project a stored TakeRecord to its lightweight TakeMeta (no wav blob). */
function toTakeMeta(rec: TakeRecord): TakeMeta {
  return {
    id: rec.id,
    songId: rec.songId,
    songTitle: typeof rec.songTitle === 'string' ? rec.songTitle : '',
    createdAt: Number.isFinite(rec.createdAt) ? rec.createdAt : 0,
    durationSec: Number.isFinite(rec.durationSec) ? rec.durationSec : 0,
    score: Number.isFinite(rec.score) ? rec.score : 0,
    rank: rec.rank ?? 'warmup',
  };
}

/** Blob size that tolerates null/undefined at runtime. */
function blobSize(b: Blob | null | undefined): number {
  return b && typeof b.size === 'number' ? b.size : 0;
}

/* ---------- songs ---------- */

/**
 * Persist (insert or replace) a full song record. The Audio blob, LRC text
 * and melody track are stored as-is via structured clone.
 *
 * @returns true on success; false (with {@link lastStorageError}) on an
 *          invalid record or storage failure.
 */
export async function saveSong(rec: SongRecord): Promise<boolean> {
  lastErrMsg = null;
  if (!rec || typeof rec.id !== 'string' || rec.id.length === 0) {
    lastErrMsg = 'saveSong: record has no id';
    return false;
  }
  if (!rec.audio) {
    lastErrMsg = 'saveSong: record has no audio blob';
    return false;
  }
  const db = await getDb();
  if (!db) return false;
  try {
    const tx = db.transaction(STORE_SONGS, 'readwrite');
    tx.objectStore(STORE_SONGS).put(rec);
    await txDone(tx);
    return true;
  } catch (e) {
    lastErrMsg = `saveSong: ${errMessage(e)}`;
    return false;
  }
}

/**
 * List all songs, newest first, WITHOUT the heavy fields (audio / lrc /
 * melody) — safe to hold in React state.
 *
 * @returns SongMeta[] (empty array on failure).
 */
export async function listSongs(): Promise<SongMeta[]> {
  lastErrMsg = null;
  const db = await getDb();
  if (!db) return [];
  try {
    const tx = db.transaction(STORE_SONGS, 'readonly');
    const req = tx.objectStore(STORE_SONGS).getAll();
    // IDB boundary: getAll is typed IDBRequest<any[]> in lib.dom.
    const rows = (await reqDone(req)) as unknown as SongRecord[];
    return rows
      .map(toSongMeta)
      .sort((x, y) => y.createdAt - x.createdAt);
  } catch (e) {
    lastErrMsg = `listSongs: ${errMessage(e)}`;
    return [];
  }
}

/**
 * Fetch one full song record (audio blob + lrc + melody included).
 *
 * @param id Song id.
 * @returns The record, or null when missing / on failure.
 */
export async function getSong(id: string): Promise<SongRecord | null> {
  lastErrMsg = null;
  if (typeof id !== 'string' || id.length === 0) {
    lastErrMsg = 'getSong: missing id';
    return null;
  }
  const db = await getDb();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE_SONGS, 'readonly');
    const req = tx.objectStore(STORE_SONGS).get(id);
    // IDB boundary: get is typed IDBRequest<any> in lib.dom.
    const row = (await reqDone(req)) as unknown as SongRecord | undefined;
    return row ?? null;
  } catch (e) {
    lastErrMsg = `getSong: ${errMessage(e)}`;
    return null;
  }
}

/**
 * Delete a song AND every take recorded against it (single transaction, so
 * orphan takes can never survive). Idempotent: deleting an unknown id is a
 * success.
 *
 * @param id Song id.
 * @returns true when the transaction committed.
 */
export async function deleteSong(id: string): Promise<boolean> {
  lastErrMsg = null;
  if (typeof id !== 'string' || id.length === 0) {
    lastErrMsg = 'deleteSong: missing id';
    return false;
  }
  const db = await getDb();
  if (!db) return false;
  try {
    const tx = db.transaction([STORE_SONGS, STORE_TAKES], 'readwrite');
    const takes = tx.objectStore(STORE_TAKES);
    const req = takes.index('songId').getAll(id);
    // IDB boundary: index.getAll is typed IDBRequest<any[]> in lib.dom.
    const takeRows = (await reqDone(req)) as unknown as TakeRecord[];
    for (const t of takeRows) takes.delete(t.id);
    tx.objectStore(STORE_SONGS).delete(id);
    await txDone(tx);
    return true;
  } catch (e) {
    lastErrMsg = `deleteSong: ${errMessage(e)}`;
    return false;
  }
}

/**
 * Patch selected fields of a stored song (read-modify-write inside one
 * transaction, so the audio blob is never lost). Patching `lrc` or `melody`
 * also refreshes the derived `hasLrc` / `hasMelody` meta flags.
 *
 * @param id Song id.
 * @param patch Only the fields present are applied; pass `undefined` to
 *              clear `lrc` / `melody` / `artist`.
 * @returns true on success; false when the song does not exist or on failure.
 */
export async function updateSong(
  id: string,
  patch: Partial<Pick<SongRecord, 'lrc' | 'melody' | 'title' | 'artist'>>
): Promise<boolean> {
  lastErrMsg = null;
  if (typeof id !== 'string' || id.length === 0) {
    lastErrMsg = 'updateSong: missing id';
    return false;
  }
  if (!patch || typeof patch !== 'object') {
    lastErrMsg = 'updateSong: patch is not an object';
    return false;
  }
  const db = await getDb();
  if (!db) return false;
  try {
    const tx = db.transaction(STORE_SONGS, 'readwrite');
    const store = tx.objectStore(STORE_SONGS);
    const req = store.get(id);
    // IDB boundary: get is typed IDBRequest<any> in lib.dom.
    const row = (await reqDone(req)) as unknown as SongRecord | undefined;
    if (!row) {
      lastErrMsg = `updateSong: song ${id} not found`;
      return false;
    }

    const has = (k: string): boolean =>
      Object.prototype.hasOwnProperty.call(patch, k);

    if (has('title') && typeof patch.title === 'string') row.title = patch.title;
    if (has('artist')) row.artist = typeof patch.artist === 'string' ? patch.artist : undefined;
    if (has('lrc')) {
      row.lrc = typeof patch.lrc === 'string' ? patch.lrc : undefined;
      row.hasLrc = typeof row.lrc === 'string' && row.lrc.length > 0;
    }
    if (has('melody')) {
      row.melody = patch.melody && Array.isArray(patch.melody.notes) ? patch.melody : undefined;
      row.hasMelody = row.melody !== undefined;
    }

    store.put(row);
    await txDone(tx);
    return true;
  } catch (e) {
    lastErrMsg = `updateSong: ${errMessage(e)}`;
    return false;
  }
}

/* ---------- takes ---------- */

/**
 * Persist (insert or replace) a recorded take: WAV blob + score + rank.
 *
 * @returns true on success; false (with {@link lastStorageError}) on an
 *          invalid record or storage failure.
 */
export async function saveTake(take: TakeRecord): Promise<boolean> {
  lastErrMsg = null;
  if (!take || typeof take.id !== 'string' || take.id.length === 0) {
    lastErrMsg = 'saveTake: record has no id';
    return false;
  }
  if (typeof take.songId !== 'string' || take.songId.length === 0) {
    lastErrMsg = 'saveTake: record has no songId';
    return false;
  }
  if (!take.wav) {
    lastErrMsg = 'saveTake: record has no wav blob';
    return false;
  }
  const db = await getDb();
  if (!db) return false;
  try {
    const tx = db.transaction(STORE_TAKES, 'readwrite');
    tx.objectStore(STORE_TAKES).put(take);
    await txDone(tx);
    return true;
  } catch (e) {
    lastErrMsg = `saveTake: ${errMessage(e)}`;
    return false;
  }
}

/**
 * List takes WITHOUT their WAV blobs, newest first, optionally filtered to
 * one song.
 *
 * @param songId When given, only takes of that song; otherwise all takes.
 * @returns TakeMeta[] (empty array on failure).
 */
export async function listTakes(songId?: string): Promise<TakeMeta[]> {
  lastErrMsg = null;
  const db = await getDb();
  if (!db) return [];
  try {
    const tx = db.transaction(STORE_TAKES, 'readonly');
    const store = tx.objectStore(STORE_TAKES);
    // IDB boundary: getAll is typed IDBRequest<any[]> in lib.dom.
    const rows =
      typeof songId === 'string' && songId.length > 0
        ? ((await reqDone(store.index('songId').getAll(songId))) as unknown as TakeRecord[])
        : ((await reqDone(store.getAll())) as unknown as TakeRecord[]);
    return rows
      .map(toTakeMeta)
      .sort((x, y) => y.createdAt - x.createdAt);
  } catch (e) {
    lastErrMsg = `listTakes: ${errMessage(e)}`;
    return [];
  }
}

/**
 * Fetch one full take record (WAV blob included).
 *
 * @param id Take id.
 * @returns The record, or null when missing / on failure.
 */
export async function getTake(id: string): Promise<TakeRecord | null> {
  lastErrMsg = null;
  if (typeof id !== 'string' || id.length === 0) {
    lastErrMsg = 'getTake: missing id';
    return null;
  }
  const db = await getDb();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE_TAKES, 'readonly');
    const req = tx.objectStore(STORE_TAKES).get(id);
    // IDB boundary: get is typed IDBRequest<any> in lib.dom.
    const row = (await reqDone(req)) as unknown as TakeRecord | undefined;
    return row ?? null;
  } catch (e) {
    lastErrMsg = `getTake: ${errMessage(e)}`;
    return null;
  }
}

/**
 * Delete a single take (the song itself is untouched).
 *
 * @param id Take id.
 * @returns true when the transaction committed.
 */
export async function deleteTake(id: string): Promise<boolean> {
  lastErrMsg = null;
  if (typeof id !== 'string' || id.length === 0) {
    lastErrMsg = 'deleteTake: missing id';
    return false;
  }
  const db = await getDb();
  if (!db) return false;
  try {
    const tx = db.transaction(STORE_TAKES, 'readwrite');
    tx.objectStore(STORE_TAKES).delete(id);
    await txDone(tx);
    return true;
  } catch (e) {
    lastErrMsg = `deleteTake: ${errMessage(e)}`;
    return false;
  }
}

/* ---------- ids + sizes ---------- */

/**
 * Generate a record id: `'k' + crypto.randomUUID()` with a Math.random
 * fallback for older browsers / non-secure contexts.
 */
export function makeId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `k${crypto.randomUUID()}`;
    }
  } catch {
    // fall through to the fallback below
  }
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 12);
  return `k${time}-${rand}`;
}

/**
 * Best-effort on-disk size estimate of a Blob (`b.size`). Browsers may lie
 * about structured-cloned blob sizes — treat as a hint, not a promise.
 */
export function estimateBlobSize(b: Blob): number {
  return blobSize(b);
}

/**
 * Best-effort totals across both object stores: song count, take count and
 * summed payload bytes (audio blobs + wav blobs, plus LRC text length).
 * Read in a single transaction for a consistent snapshot.
 *
 * @returns `{ songs, takes, bytes }` — zeros on failure.
 */
export async function storageEstimate(): Promise<{
  songs: number;
  takes: number;
  bytes: number;
}> {
  lastErrMsg = null;
  const db = await getDb();
  if (!db) return { songs: 0, takes: 0, bytes: 0 };
  try {
    const tx = db.transaction([STORE_SONGS, STORE_TAKES], 'readonly');
    // IDB boundary: getAll is typed IDBRequest<any[]> in lib.dom.
    const songs = (await reqDone(
      tx.objectStore(STORE_SONGS).getAll()
    )) as unknown as SongRecord[];
    const takes = (await reqDone(
      tx.objectStore(STORE_TAKES).getAll()
    )) as unknown as TakeRecord[];

    let bytes = 0;
    for (const s of songs) {
      bytes += blobSize(s.audio);
      if (typeof s.lrc === 'string') bytes += s.lrc.length;
    }
    for (const t of takes) bytes += blobSize(t.wav);

    return { songs: songs.length, takes: takes.length, bytes };
  } catch (e) {
    lastErrMsg = `storageEstimate: ${errMessage(e)}`;
    return { songs: 0, takes: 0, bytes: 0 };
  }
}

/* ---------- settings (localStorage, private-mode safe) ---------- */

/** localStorage handle, or null when unavailable (SSR / private mode). */
function ls(): Storage | null {
  try {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
      return null;
    }
    return window.localStorage;
  } catch {
    // Some browsers throw on the mere localStorage access in private mode.
    return null;
  }
}

/**
 * Read a JSON setting from localStorage (namespaced under
 * `tito-karaoke:settings:`). Returns the fallback when the key is absent,
 * corrupt, or storage is unavailable — never throws.
 */
export function getSetting<T>(key: string, fallback: T): T {
  lastErrMsg = null;
  const store = ls();
  if (!store) return fallback;
  try {
    const raw = store.getItem(SETTINGS_PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch (e) {
    // Corrupt JSON or a read failure — quietly fall back.
    lastErrMsg = `getSetting(${key}): ${errMessage(e)}`;
    return fallback;
  }
}

/**
 * Write a JSON setting to localStorage (namespaced under
 * `tito-karaoke:settings:`). Never throws; failures are reported through
 * {@link lastStorageError}.
 */
export function setSetting<T>(key: string, value: T): void {
  lastErrMsg = null;
  const store = ls();
  if (!store) return;
  try {
    store.setItem(SETTINGS_PREFIX + key, JSON.stringify(value));
  } catch (e) {
    lastErrMsg = `setSetting(${key}): ${errMessage(e)}`;
  }
}
