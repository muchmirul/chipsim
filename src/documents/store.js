const memory = { documents: new Map(), models: new Map() };
let database;
async function open() {
  if (database) return database;
  database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("chipsim-workspace", 1);
    request.onupgradeneeded = () => {
      for (const name of ["documents", "models"])
        request.result.createObjectStore(name, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}
export async function saveRecord(store, record) {
  memory[store].set(record.id, record);
  try {
    const db = await open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch {
    return false;
  }
}
export async function records(store) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return [...memory[store].values()];
  }
}
export async function removeRecord(store, id) {
  memory[store].delete(id);
  try {
    const db = await open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}
