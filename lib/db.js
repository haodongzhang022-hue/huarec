// IndexedDB 存储:录制视频 blob 太大,不能放 chrome.storage。
// 一个 object store 'recordings',按 id 存 { id, blob, cursor, clicks, meta }。
const DB_NAME = 'huarec';
const STORE = 'recordings';
const VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export async function saveRecording(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').put(record);
    req.onsuccess = () => resolve(record.id);
    req.onerror = () => reject(req.error);
  });
}

export async function getRecording(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readonly').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function listRecordings() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readonly').getAll();
    req.onsuccess = () => {
      const rows = (req.result || []).map((r) => ({
        id: r.id, meta: r.meta, size: r.blob ? r.blob.size : 0,
      }));
      rows.sort((a, b) => (b.meta?.createdAt || 0) - (a.meta?.createdAt || 0));
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteRecording(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
