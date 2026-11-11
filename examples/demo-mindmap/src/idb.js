const DB_NAME = "silker-demo-mindmap";
const STORE = "mindmaps";
function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(STORE)) {
                req.result.createObjectStore(STORE, { keyPath: "id" });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
// 每次操作独立开库/关库：demo 规模足够，避免连接生命周期管理
async function withStore(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
    });
}
export function listDocs() {
    return withStore("readonly", (s) => s.getAll());
}
export function getDoc(id) {
    return withStore("readonly", (s) => s.get(id));
}
export function putDoc(doc) {
    return withStore("readwrite", (s) => s.put(doc));
}
export function deleteDoc(id) {
    return withStore("readwrite", (s) => s.delete(id));
}
