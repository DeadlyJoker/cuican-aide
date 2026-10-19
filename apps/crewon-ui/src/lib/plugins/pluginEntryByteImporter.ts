import type { PluginUiLease } from "@crewon/contracts/plugins";
import {
  createPluginEntryByteStore,
  MAXIMUM_PLUGIN_ENTRY_BYTES,
  type PluginEntryByteStore,
} from "./pluginEntryByteStore";
import {
  importTrustedPluginUiModule,
  type PluginUiModuleImporter,
} from "./trustedPluginUiLoader";
import {
  awaitPluginUiOperation,
  PluginUiLoaderError,
} from "./pluginUiValidation";

// Optional storage must not consume the module's online loading deadline.
export const PLUGIN_ENTRY_CACHE_READ_DEADLINE_MS = 200;

export type PluginUiEntryImport = Readonly<{
  url: string;
  lease: PluginUiLease;
  signal: AbortSignal;
  onEntryRead?(kind: "entry-downloaded" | "entry-revalidated"): void;
}>;
export function createPluginEntryByteImporter(input: {
  ownerKey: string;
  fetch?: typeof fetch;
  store?: PluginEntryByteStore;
  importModule?: PluginUiModuleImporter;
  /** Native URLs are revoked after ESM evaluation, not before. */
  createModuleUrl?: (bytes: ArrayBuffer) => string;
  revokeModuleUrl?: (url: string) => void;
}) {
  const store = input.store ?? createPluginEntryByteStore();
  const importer = input.importModule ?? importTrustedPluginUiModule;
  const fetchEntry = input.fetch ?? globalThis.fetch;
  const createUrl =
    input.createModuleUrl ??
    ((bytes) =>
      URL.createObjectURL(new Blob([bytes], { type: "text/javascript" })));
  const revokeUrl =
    input.revokeModuleUrl ?? ((url) => URL.revokeObjectURL(url));
  return async ({
    url,
    lease,
    signal,
    onEntryRead,
  }: PluginUiEntryImport): Promise<unknown> => {
    const entry = lease.descriptor.entrypoints.ui;
    const file = lease.descriptor.files.find((v) => v.path === entry?.path);
    const declared = lease.descriptor.requires.some(
      (v) =>
        v.service === "crewon.plugin-ui-resources" &&
        v.apiVersion === "1" &&
        v.optional === true,
    );
    if (
      !declared ||
      !entry ||
      !file ||
      lease.publicAssets.length !== 1 ||
      lease.publicAssets[0] !== entry.path ||
      file.byteLength > MAXIMUM_PLUGIN_ENTRY_BYTES
    )
      return importer(url);
    signal.throwIfAborted();
    const key = await hash(
      new TextEncoder().encode(
        JSON.stringify([
          location.origin,
          input.ownerKey,
          lease.descriptor.publisherId,
          lease.descriptor.pluginId,
          lease.packageDigest,
          file.path,
          file.sha256,
        ]),
      ).buffer,
    );
    const stored = await readCachedEntry(store, key, signal);
    const cached =
      stored &&
      stored.byteLength === file.byteLength &&
      (await hash(stored)) === file.sha256
        ? stored
        : null;
    signal.throwIfAborted();
    const tag = `"sha256:${file.sha256}"`;
    const response = await fetchEntry(url, {
      cache: "no-store",
      credentials: "same-origin",
      signal,
      headers: {
        "x-crewon-plugin-ui-code-cache": "entry-bytes.v2",
        ...(cached ? { "if-none-match": tag } : {}),
      },
    });
    let bytes: ArrayBuffer;
    const unchanged =
      response.headers.get("x-crewon-plugin-ui-entry") === "unchanged.v2";
    if (
      unchanged &&
      (response.status !== 200 ||
        !cached ||
        response.headers.get("etag") !== tag ||
        response.headers.get("content-length") !== "0")
    )
      throw new PluginUiLoaderError("plugin_ui_asset_integrity_failed");
    if ((response.status === 304 && cached) || unchanged) {
      if (!cached)
        throw new PluginUiLoaderError("plugin_ui_asset_integrity_failed");
      bytes = cached;
      onEntryRead?.("entry-revalidated");
    } else {
      if (
        response.status !== 200 ||
        !/^(application|text)\/javascript(?:;|$)/iu.test(
          response.headers.get("content-type") ?? "",
        )
      )
        throw new PluginUiLoaderError("plugin_ui_entry_read_unavailable");
      const reader = response.body?.getReader();
      if (!reader)
        throw new PluginUiLoaderError("plugin_ui_asset_integrity_failed");
      const parts: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > file.byteLength) {
            await reader.cancel();
            throw new PluginUiLoaderError("plugin_ui_asset_integrity_failed");
          }
          parts.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const value = new Uint8Array(length);
      let offset = 0;
      for (const part of parts) {
        value.set(part, offset);
        offset += part.byteLength;
      }
      bytes = value.buffer;
      if (length !== file.byteLength || (await hash(bytes)) !== file.sha256)
        throw new PluginUiLoaderError("plugin_ui_asset_integrity_failed");
      onEntryRead?.("entry-downloaded");
      // Persist immutable bytes in the background; quota or storage contention
      // must not hold an already verified online module on the loading screen.
      void store.put(key, bytes).catch(() => undefined);
    }
    signal.throwIfAborted();
    const moduleUrl = createUrl(bytes);
    try {
      return await importer(moduleUrl);
    } finally {
      revokeUrl(moduleUrl);
    }
  };
}
async function readCachedEntry(
  store: PluginEntryByteStore,
  key: string,
  signal: AbortSignal,
): Promise<ArrayBuffer | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await awaitPluginUiOperation(
      Promise.race([
        Promise.resolve()
          .then(() => store.get(key))
          .catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(
            () => resolve(null),
            PLUGIN_ENTRY_CACHE_READ_DEADLINE_MS,
          );
        }),
      ]),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}
async function hash(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
