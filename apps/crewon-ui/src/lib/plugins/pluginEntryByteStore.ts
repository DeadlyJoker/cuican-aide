const DATABASE = "crewon-plugin-entry-code-v1";
const STORE = "entries";
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
      try {
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore(STORE, { keyPath: "key" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  return {
    async get(key) {
      const db = await open();
      if (!db) return null;
      try {
        return await new Promise<ArrayBuffer | null>((resolve) => {
          const request = db
            .transaction(STORE, "readonly")
            .objectStore(STORE)
            .get(key);
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
          const request = store.getAll();
          request.onsuccess = () => {
            const entries = request.result as {
              key: string;
              storedAt: number;
            }[];
            entries.sort((a, b) => a.storedAt - b.storedAt);
            for (const entry of entries.slice(
              0,
              Math.max(0, entries.length - MAXIMUM_ENTRIES),
            ))
              store.delete(entry.key);
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
