// Shared IndexedDB storage for captured frames. Used by the service worker
// (writes frames while capturing) and the editor page (reads and stitches them).

const DB_NAME = 'tall-screenshot';
const DB_VERSION = 1;
const KEEP_SESSIONS = 5;
const STALE_CAPTURE_MS = 60 * 60 * 1000;

let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('sessions', { keyPath: 'sid' });
        db.createObjectStore('frames', { keyPath: ['sid', 'i'] });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onclose = db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}

async function run(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then((r) => { result = r; }, reject);
    t.oncomplete = () => resolve(result);
    t.onerror = t.onabort = () => reject(t.error || new Error('IndexedDB transaction failed'));
  });
}

const req2p = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const frameRange = (sid) => IDBKeyRange.bound([sid, -Infinity], [sid, Infinity]);

export const putFrame = (frame) => run('frames', 'readwrite', (t) => { t.objectStore('frames').put(frame); });

export const putSession = (session) => run('sessions', 'readwrite', (t) => { t.objectStore('sessions').put(session); });

export const getSession = (sid) => run('sessions', 'readonly', (t) => req2p(t.objectStore('sessions').get(sid)));

export const getFrames = (sid) => run('frames', 'readonly', (t) => req2p(t.objectStore('frames').getAll(frameRange(sid))));

export const deleteSession = (sid) => run(['sessions', 'frames'], 'readwrite', (t) => {
  t.objectStore('sessions').delete(sid);
  t.objectStore('frames').delete(frameRange(sid));
});

// Keep the newest finished captures, drop abandoned ones and orphaned frames.
export async function prune() {
  const sessions = await run('sessions', 'readonly', (t) => req2p(t.objectStore('sessions').getAll()));
  const now = Date.now();
  const ready = sessions.filter((s) => s.status === 'ready').sort((a, b) => b.created - a.created);
  const drop = new Set([
    ...ready.slice(KEEP_SESSIONS).map((s) => s.sid),
    ...sessions.filter((s) => s.status !== 'ready' && now - s.created > STALE_CAPTURE_MS).map((s) => s.sid),
  ]);
  const known = new Set(sessions.map((s) => s.sid).filter((sid) => !drop.has(sid)));
  const frameSids = await run('frames', 'readonly', (t) => new Promise((resolve, reject) => {
    const sids = new Set();
    const cur = t.objectStore('frames').openKeyCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve(sids);
      sids.add(c.key[0]);
      // Jump straight to the next session's frames.
      c.continue([c.key[0], Infinity]);
    };
    cur.onerror = () => reject(cur.error);
  }));
  for (const sid of frameSids) if (!known.has(sid)) drop.add(sid);
  for (const sid of drop) await deleteSession(sid);
}
