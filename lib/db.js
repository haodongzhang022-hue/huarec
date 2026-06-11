// IndexedDB 存储:录制视频 blob 太大,不能放 chrome.storage。
// v2 schema(四个 store):
//   recordings — 成品记录 { id, blob, camBlob, cursor, clicks, acts, meta }
//   chunks     — 录制中的流式切片 { session, track('screen'|'cam'), seq, data },键 [session,track,seq]
//                录满即写、停止后合并删除;浏览器崩溃时凭它恢复半截录制
//   sessions   — 进行中会话 { session, createdAt, startTime, camStartTime, meta },正常收尾即删,
//                残留 = 中断的录制(孤儿),录制库里提示恢复
//   projects   — 每段录制的编辑工程 { id, title, poster, segments, beautify, cfg, camCfg, savedAt },
//                与大 blob 分开存,滑杆级高频保存不用重写视频数据
const DB_NAME = 'huarec';
const VERSION = 2;
const STORE = 'recordings';
const CHUNKS = 'chunks';
const SESSIONS = 'sessions';
const PROJECTS = 'projects';

let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(CHUNKS)) {
        const c = db.createObjectStore(CHUNKS, { keyPath: ['session', 'track', 'seq'] });
        c.createIndex('bySession', 'session');
      }
      if (!db.objectStoreNames.contains(SESSIONS)) {
        db.createObjectStore(SESSIONS, { keyPath: 'session' });
      }
      if (!db.objectStoreNames.contains(PROJECTS)) {
        db.createObjectStore(PROJECTS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

function prom(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode) {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

// ---- 成品记录 ----
export async function saveRecording(record) {
  const s = await store(STORE, 'readwrite');
  await prom(s.put(record));
  return record.id;
}

export async function getRecording(id) {
  const s = await store(STORE, 'readonly');
  return (await prom(s.get(id))) || null;
}

export async function listRecordings() {
  const s = await store(STORE, 'readonly');
  const rows = ((await prom(s.getAll())) || []).map((r) => ({
    id: r.id, meta: r.meta, size: r.blob ? r.blob.size : 0,
  }));
  rows.sort((a, b) => (b.meta?.createdAt || 0) - (a.meta?.createdAt || 0));
  return rows;
}

// 删除录制连同它的编辑工程
export async function deleteRecording(id) {
  const db = await openDB();
  const tx = db.transaction([STORE, PROJECTS], 'readwrite');
  tx.objectStore(STORE).delete(id);
  tx.objectStore(PROJECTS).delete(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- 录制切片(流式) ----
export async function appendChunk(row) {
  const s = await store(CHUNKS, 'readwrite');
  return prom(s.put(row));
}

export async function getSessionChunks(session) {
  const s = await store(CHUNKS, 'readonly');
  const rows = (await prom(s.index('bySession').getAll(session))) || [];
  rows.sort((a, b) => (a.track === b.track ? a.seq - b.seq : a.track < b.track ? -1 : 1));
  return rows;
}

// ---- 录制会话 ----
export async function putSession(row) {
  const s = await store(SESSIONS, 'readwrite');
  return prom(s.put(row));
}

export async function getSessions() {
  const s = await store(SESSIONS, 'readonly');
  return (await prom(s.getAll())) || [];
}

// 删除会话及其全部切片(正常收尾 / 用户丢弃孤儿时调用)
export async function deleteSession(session) {
  const db = await openDB();
  const tx = db.transaction([CHUNKS, SESSIONS], 'readwrite');
  const cur = tx.objectStore(CHUNKS).index('bySession').openCursor(IDBKeyRange.only(session));
  cur.onsuccess = () => { const c = cur.result; if (c) { c.delete(); c.continue(); } };
  tx.objectStore(SESSIONS).delete(session);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- 编辑工程 ----
export async function saveProject(row) {
  const s = await store(PROJECTS, 'readwrite');
  return prom(s.put(row));
}

export async function getProject(id) {
  const s = await store(PROJECTS, 'readonly');
  return (await prom(s.get(id))) || null;
}

export async function getAllProjects() {
  const s = await store(PROJECTS, 'readonly');
  return (await prom(s.getAll())) || [];
}
