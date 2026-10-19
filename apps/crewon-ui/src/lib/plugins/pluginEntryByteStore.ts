const DATABASE = "crewon-plugin-entry-code-v1";
const STORE = "entries";
const STORED_AT_INDEX = "storedAt";
const MAXIMUM_ENTRIES = 8;
export const MAXIMUM_PLUGIN_ENTRY_BYTES = 4 * 1024 * 1024;

export interface PluginEntryByteStore {
  get(key: string): Promise<ArrayBuffer | null>;
  put(key: string, bytes: ArrayBuffer): Promise<void>;
}

/** Only immutable package JavaScript, never project content, credentials or grants. */
export function createPluginEntryByteStore(): PluginEntryByteStore {
  const open = () =>
    new Promise<IDBDatabase | null>((resolve) => {
      let settled = false;
      const finish = (db: IDBDatabase | null) => {
        if (settled) {
          db?.close();
          return;
        }
        settled = true;
        resolve(db);
      };
      try {
        const request = indexedDB.open(DATABASE, 2);
        request.onupgradeneeded = () => {
          const store = request.result.objectStoreNames.contains(STORE)
            ? request.transaction!.objectStore(STORE)
            : request.result.createObjectStore(STORE, { keyPath: "key" });
          if (!store.indexNames.contains(STORED_AT_INDEX))
            store.createIndex(STORED_AT_INDEX, "storedAt");
        };
        request.onsuccess = () => finish(request.result);
        request.onerror = request.onblocked = () => finish(null);
      } catch {
        finish(null);
      }
    });
  return {
    async get(key) {
      const db = await open();
      if (!db) return null;
      try {
        return await new Promise<ArrayBuffer | null>((resolve) => {
          const transaction = db.transaction(STORE, "readonly");
          transaction.onabort = transaction.onerror = () => resolve(null);
          const request = transaction.objectStore(STORE).get(key);
          request.onsuccess = () => {
            const bytes: unknown = request.result?.bytes;
            resolve(
              bytes instanceof ArrayBuffer &&
                bytes.byteLength <= MAXIMUM_PLUGIN_ENTRY_BYTES
                ? bytes
                : null,
            );
          };
          request.onerror = () => resolve(null);
        });
      } catch {
        return null;
      } finally {
        db.close();
      }
    },
    async put(key, bytes) {
      if (bytes.byteLength > MAXIMUM_PLUGIN_ENTRY_BYTES) return;
      const db = await open();
      if (!db) return;
      try {
        await new Promise<void>((resolve) => {
          const transaction = db.transaction(STORE, "readwrite");
          const store = transaction.objectStore(STORE);
          store.put({ key, bytes, storedAt: Date.now() });
          const request = store.count();
          request.onsuccess = () => {
            let excess = request.result - MAXIMUM_ENTRIES;
            if (excess <= 0) return;
            // Read only sorted keys; cloning cached JavaScript to evict it can
            // otherwise allocate up to 36 MiB for a single new entry.
            const cursor = store.index(STORED_AT_INDEX).openKeyCursor();
            cursor.onsuccess = () => {
              const entry = cursor.result;
              if (!entry || excess <= 0) return;
              store.delete(entry.primaryKey);
              if (--excess > 0) entry.continue();
            };
          };
          transaction.oncomplete =
            transaction.onerror =
            transaction.onabort =
              () => resolve();
        });
      } catch {
        /* Storage denial does not block a verified online mount. */
      } finally {
        db.close();
      }
    },
  };
}
