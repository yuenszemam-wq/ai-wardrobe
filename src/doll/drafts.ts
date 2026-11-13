/** Local-only editor recovery. Structured clones keep masks and meshes out of server traffic. */
const DB = "aw-editor-drafts", STORE = "drafts";
let opened: Promise<IDBDatabase> | undefined;
function db() {
  return opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { opened = undefined; reject(req.error); };
  });
}
export async function readDraft<T>(key: string): Promise<T | null> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result?.v === 1 ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}
export async function writeDraft(key: string, value: unknown) {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ v: 1, at: Date.now(), value }, key);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
export async function clearDraft(key: string) {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction(STORE, "readwrite"); tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
}
