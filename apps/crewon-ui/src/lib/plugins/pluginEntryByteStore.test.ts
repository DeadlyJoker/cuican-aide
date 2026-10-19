import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginEntryByteStore } from "./pluginEntryByteStore";

type Entry = { key: string; bytes: ArrayBuffer; storedAt: number };
function storageFixture(legacy: Entry[] = []) {
  const entries = new Map(legacy.map((entry) => [entry.key, entry]));
  let version = legacy.length ? 1 : 0;
  let indexed = false;
  let abortRead = false;
  let abortWrite = false;
  const close = vi.fn();
  const getAll = vi.fn(() => {
    throw new Error("must not clone cached bytes");
  });
  const createIndex = vi.fn(() => {
    indexed = true;
  });
  const openKeyCursor = vi.fn();
  const makeTransaction = () => {
    let pending = 0;
    const transaction = {
      onabort: null as (() => void) | null,
      onerror: null as (() => void) | null,
      oncomplete: null as (() => void) | null,
      objectStore: () => store,
    };
    const work = <T>(read: () => T) => {
      pending++;
      const request = {
        result: undefined as T | undefined,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };
      queueMicrotask(() => {
        request.result = read();
        request.onsuccess?.();
        if (--pending === 0) queueMicrotask(() => transaction.oncomplete?.());
      });
      return request;
    };
    const store = {
      indexNames: { contains: () => indexed },
      createIndex,
      getAll,
      get: (key: string) => {
        if (!abortRead) return work(() => entries.get(key));
        queueMicrotask(() => transaction.onabort?.());
        return { onsuccess: null, onerror: null };
      },
      put: (entry: Entry) => {
        if (abortWrite) queueMicrotask(() => transaction.onabort?.());
        else entries.set(entry.key, entry);
      },
      count: () =>
        abortWrite ? { onsuccess: null } : work(() => entries.size),
      delete: (key: string) => entries.delete(key),
      index: () => ({
        openKeyCursor: () => {
          openKeyCursor();
          const keys = [...entries.values()].sort(
            (a, b) => a.storedAt - b.storedAt,
          );
          let position = 0;
          const request = {
            result: null as null | { primaryKey: string; continue(): void },
            onsuccess: null as (() => void) | null,
          };
          const advance = () => {
            pending++;
            queueMicrotask(() => {
              const entry = keys[position++];
              request.result = entry
                ? { primaryKey: entry.key, continue: advance }
                : null;
              request.onsuccess?.();
              if (--pending === 0)
                queueMicrotask(() => transaction.oncomplete?.());
            });
          };
          advance();
          return request;
        },
      }),
    };
    return transaction;
  };
  const db = {
    close,
    objectStoreNames: { contains: () => version > 0 },
    createObjectStore: vi.fn(() => makeTransaction().objectStore()),
    transaction: makeTransaction,
  };
  const open = vi.fn((_name: string, next: number) => {
    const request = {
      result: db,
      transaction: makeTransaction(),
      onupgradeneeded: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
      onerror: null,
      onblocked: null,
    };
    queueMicrotask(() => {
      if (next > version) {
        request.onupgradeneeded?.();
        version = next;
      }
      request.onsuccess?.();
    });
    return request;
  });
  vi.stubGlobal("indexedDB", { open });
  return {
    entries,
    open,
    close,
    createIndex,
    getAll,
    openKeyCursor,
    abortRead: () => {
      abortRead = true;
    },
    abortWrite: () => {
      abortWrite = true;
    },
    createObjectStore: db.createObjectStore,
  };
}

afterEach(() => vi.unstubAllGlobals());
describe("optional immutable plugin entry storage", () => {
  it("adds the expiry index to version 1 without recreating or erasing cached entries", async () => {
    const bytes = new ArrayBuffer(4);
    const f = storageFixture([{ key: "legacy", bytes, storedAt: 1 }]);
    expect(await createPluginEntryByteStore().get("legacy")).toBe(bytes);
    expect(f.open).toHaveBeenCalledWith("crewon-plugin-entry-code-v1", 2);
    expect(f.createIndex).toHaveBeenCalledWith("storedAt", "storedAt");
    expect(f.createObjectStore).not.toHaveBeenCalled();
    expect(f.entries.size).toBe(1);
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("keeps the newest eight entries using sorted keys without cloning cached bodies", async () => {
    const f = storageFixture(
      Array.from({ length: 8 }, (_, index) => ({
        key: String(index),
        bytes: new ArrayBuffer(4),
        storedAt: index,
      })),
    );
    await createPluginEntryByteStore().put("new", new ArrayBuffer(8));
    expect([...f.entries.keys()]).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "new",
    ]);
    expect(f.getAll).not.toHaveBeenCalled();
    expect(f.openKeyCursor).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("resolves aborted reads and writes and closes their connections", async () => {
    const f = storageFixture();
    f.abortRead();
    await expect(
      createPluginEntryByteStore().get("missing"),
    ).resolves.toBeNull();
    f.abortWrite();
    await expect(
      createPluginEntryByteStore().put("missing", new ArrayBuffer(1)),
    ).resolves.toBeUndefined();
    expect(f.close).toHaveBeenCalledTimes(2);
  });
  it("closes a connection arriving after an already rejected blocked open", async () => {
    const close = vi.fn();
    const request = {
      result: { close },
      onblocked: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
    };
    vi.stubGlobal("indexedDB", { open: () => request });
    const pending = createPluginEntryByteStore().get("ignored");
    request.onblocked?.();
    await expect(pending).resolves.toBeNull();
    request.onsuccess?.();
    expect(close).toHaveBeenCalledOnce();
  });
});
