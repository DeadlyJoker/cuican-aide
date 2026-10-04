import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PluginPackageDescriptor } from "@crewon/contracts/plugins";
import type {
  DesktopLocalPluginSourcePreview,
  DesktopLocalPluginSourceConfirmation,
  DesktopLocalPluginSourceConfirmed as DesktopLocalPluginSourceProtocolConfirmed,
} from "../src/lib/desktop/desktopLocalPluginSourceImportProtocol.ts";
import { verifyLocalPluginPackage } from "../../../packages/plugin-host/src/local-plugin-package-verifier.ts";
import { installLocalPluginPackage } from "../../../packages/plugin-host/src/local-plugin-package-installer.ts";
import {
  DESKTOP_PLUGIN_APPROVAL_FILE,
  DESKTOP_PLUGIN_APPROVAL_SCHEMA,
  parseDesktopPluginApproval,
  type DesktopPluginApprovalSettings,
} from "./desktopPluginBootstrap.ts";

import {
  MAX_APPROVAL_BYTES,
  PENDING_SUFFIX,
  absolutePath,
  assertApproval,
  assertFile,
  assertParents,
  assertPrivateDirectory,
  commitApproval,
  createPending,
  ensurePrivateDirectory,
  fields,
  invalid,
  parseJson,
  pinParents,
  protectOwnedPluginImportSource,
  readApproval,
  removePending,
  type DirectoryPin,
  type FileSnapshot,
} from "./desktopLocalPluginSourceImportFiles.ts";

export type {
  DesktopLocalPluginSourcePreview,
  DesktopLocalPluginSourceConfirmation,
};
export type DesktopLocalPluginSourceConfirmed = Omit<
  DesktopLocalPluginSourceProtocolConfirmed,
  "runtimeStatus"
>;
export type DesktopLocalPluginSourceImporter = Readonly<{
  /** Only Main may supply the directory selected by its original Native dialog. */
  previewDirectory(directory: string): Promise<DesktopLocalPluginSourcePreview>;
  /** Main-only synchronous acceptance before its queued runtime stop. Never expose through IPC. */
  claimPreview(
    input: DesktopLocalPluginSourceConfirmation,
  ): DesktopLocalPluginSourceConfirmation;
  confirmPreview(
    input: DesktopLocalPluginSourceConfirmation,
  ): Promise<DesktopLocalPluginSourceConfirmed>;
  cancelPreview(input: Readonly<{ previewId: string }>): void;
  /** Synchronously withdraws the ticket, aborts, then joins the physical operation. */
  close(): Promise<void>;
}>;
export type DesktopLocalPluginSourceImporterOptions = Readonly<{
  dataDirectory: string;
  /** Main document/window lifetime; must remain valid across stopping the runtime. */
  assertCurrent(): void;
  /** Original runtime stop, including physical children. No restart or grant is issued here. */
  beforeApprovalCommit(): Promise<void>;
  previewLifetimeMs?: number;
}>;

const SOURCE_ROOT = "plugin-import-sources";
const DEFAULT_PREVIEW_LIFETIME_MS = 120_000;
type ApprovalSnapshot = Readonly<{
  file: FileSnapshot | null;
  settings: DesktopPluginApprovalSettings;
  parents: readonly DirectoryPin[];
}>;
type PreviewTicket = Readonly<{
  view: DesktopLocalPluginSourcePreview;
  directory: string;
  descriptor: PluginPackageDescriptor;
  approval: ApprovalSnapshot;
  utcDeadline: number;
  monotonicDeadline: number;
}>;

/**
 * Explicit local source/publisher trust only. This never imports a plugin, installs a
 * selection, activates Node, or issues task/network/project/financial permission.
 * The private source copy may remain unapproved after a later CAS failure; it is
 * never promoted on startup and no human source directory is removed or chmodded.
 */
export function createDesktopLocalPluginSourceImporter(
  input: DesktopLocalPluginSourceImporterOptions,
): DesktopLocalPluginSourceImporter {
  const owner = new LocalSourceImporter(input);
  return Object.freeze({
    previewDirectory: owner.previewDirectory.bind(owner),
    claimPreview: owner.claimPreview.bind(owner),
    confirmPreview: owner.confirmPreview.bind(owner),
    cancelPreview: owner.cancelPreview.bind(owner),
    close: owner.close.bind(owner),
  });
}

export { recoverDesktopLocalPluginSourceImport } from "./desktopLocalPluginSourceImportFiles.ts";

class LocalSourceImporter {
  readonly #dataDirectory: string;
  readonly #approvalPath: string;
  readonly #assertCurrent: () => void;
  readonly #beforeApprovalCommit: () => Promise<void>;
  readonly #lifetime: number;
  #ticket: PreviewTicket | null = null;
  #claim: Readonly<{
    ticket: PreviewTicket;
    command: DesktopLocalPluginSourceConfirmation;
  }> | null = null;
  #flight: Promise<unknown> | null = null;
  #controller: AbortController | null = null;
  #closed = false;
  #closing: Promise<void> | null = null;

  constructor(input: DesktopLocalPluginSourceImporterOptions) {
    const value = fields(
      input,
      ["dataDirectory", "assertCurrent", "beforeApprovalCommit"],
      ["previewLifetimeMs"],
    );
    this.#dataDirectory = absolutePath(value.dataDirectory);
    this.#approvalPath = join(
      this.#dataDirectory,
      DESKTOP_PLUGIN_APPROVAL_FILE,
    );
    if (
      typeof value.assertCurrent !== "function" ||
      typeof value.beforeApprovalCommit !== "function"
    )
      invalid("owner");
    this.#assertCurrent = value.assertCurrent as () => void;
    this.#beforeApprovalCommit =
      value.beforeApprovalCommit as () => Promise<void>;
    const lifetime = value.previewLifetimeMs ?? DEFAULT_PREVIEW_LIFETIME_MS;
    if (
      typeof lifetime !== "number" ||
      !Number.isSafeInteger(lifetime) ||
      lifetime < 1 ||
      lifetime > 300_000
    )
      invalid("lifetime");
    this.#lifetime = lifetime;
  }

  async previewDirectory(
    directory: string,
  ): Promise<DesktopLocalPluginSourcePreview> {
    this.#current();
    if (this.#claim !== null) invalid("claim_busy");
    return this.#run(async (signal) => {
      this.#ticket = null;
      const selectedDirectory = absolutePath(directory);
      const parents = pinParents(this.#dataDirectory);
      assertPrivateDirectory(this.#dataDirectory);
      const file = readApproval(this.#approvalPath);
      const settings =
        file === null
          ? parseDesktopPluginApproval({
              schemaVersion: DESKTOP_PLUGIN_APPROVAL_SCHEMA,
              sources: [],
              publications: [],
            })
          : parseDesktopPluginApproval(parseJson(file.bytes));
      const verified = await verifyLocalPluginPackage({
        directory: selectedDirectory,
        signal,
      });
      this.#current(signal);
      assertParents(parents);
      assertApproval(this.#approvalPath, file);
      const descriptor = verified.descriptor;
      const utcDeadline = Date.now() + this.#lifetime;
      const view: DesktopLocalPluginSourcePreview = Object.freeze({
        previewId: randomBytes(32).toString("base64url"),
        expiresAt: utcDeadline,
        pluginId: descriptor.pluginId,
        publisherId: descriptor.publisherId,
        version: descriptor.version,
        packageDigest: verified.packageDigest,
        title: descriptor.title,
        description: descriptor.description,
        totalBytes: verified.totalBytes,
        fileCount: verified.fileCount,
        nodeEntry: descriptor.entrypoints.node,
        uiEntry: descriptor.entrypoints.ui,
        publicAssetCandidates: Object.freeze(
          descriptor.entrypoints.ui === null
            ? []
            : descriptor.files
                .map((file) => file.path)
                .filter(
                  (path) =>
                    path !== descriptor.entrypoints.node &&
                    path !== descriptor.businessManifestPath,
                )
                .sort(),
        ),
      });
      this.#ticket = Object.freeze({
        view,
        directory: verified.directory,
        descriptor,
        approval: Object.freeze({ file, settings, parents }),
        utcDeadline,
        monotonicDeadline: performance.now() + this.#lifetime,
      });
      return view;
    });
  }

  claimPreview(
    input: DesktopLocalPluginSourceConfirmation,
  ): DesktopLocalPluginSourceConfirmation {
    this.#current();
    if (this.#flight !== null) invalid("busy");
    if (this.#claim !== null) invalid("claim_busy");
    const ticket = this.#ticket;
    if (ticket === null) invalid("preview_unavailable");
    try {
      const command = parseConfirmation(input);
      this.#ticketCurrent(ticket);
      assertIdentity(command, ticket.view);
      if (
        ticket.descriptor.entrypoints.node !== null &&
        !command.trustNodeExecution
      )
        invalid("node_trust_required");
      selectedAssets(command, ticket.view);
      this.#approvalCurrent(ticket);
      this.#claim = Object.freeze({ ticket, command });
      return command;
    } catch (error) {
      // One acceptance attempt consumes an unclaimed ticket, including invalid consent.
      this.#ticket = null;
      throw error;
    }
  }

  async confirmPreview(
    input: DesktopLocalPluginSourceConfirmation,
  ): Promise<DesktopLocalPluginSourceConfirmed> {
    this.#current();
    if (this.#flight !== null) invalid("busy");
    let claim = this.#claim;
    if (claim === null) {
      // Backward-compatible direct confirmation captures its command synchronously,
      // before the first Promise/microtask can unmount the Settings preview.
      this.claimPreview(input);
      claim = this.#claim;
    } else {
      try {
        const command = parseConfirmation(input);
        if (!sameConfirmation(command, claim.command))
          invalid("claim_mismatch");
        this.#ticketCurrent(claim.ticket);
      } catch (error) {
        this.#ticket = null;
        this.#claim = null;
        throw error;
      }
    }
    if (claim === null) invalid("preview_unavailable");
    const accepted = claim;
    return this.#run(async (signal) => {
      const ticket = accepted.ticket;
      try {
        const confirmation = accepted.command;
        this.#ticketCurrent(ticket, signal);
        const publicAssets = selectedAssets(confirmation, ticket.view);
        this.#approvalCurrent(ticket);
        const fresh = await verifyLocalPluginPackage({
          directory: ticket.directory,
          signal,
        });
        this.#ticketCurrent(ticket, signal);
        assertIdentity(
          { ...fresh.descriptor, packageDigest: fresh.packageDigest },
          ticket.view,
        );
        this.#approvalCurrent(ticket);
        const sourceRoot = join(this.#dataDirectory, SOURCE_ROOT);
        const sourceId = `local-import-${randomUUID()}`;
        const source = Object.freeze({
          sourceId,
          directory: join(
            sourceRoot,
            "packages",
            ticket.view.packageDigest.slice("sha256:".length),
          ),
          pluginId: ticket.view.pluginId,
          publisherId: ticket.view.publisherId,
          version: ticket.view.version,
          packageDigest: ticket.view.packageDigest,
        });
        const previous = ticket.approval.settings;
        const publications =
          publicAssets.length === 0
            ? previous.publications
            : [
                ...previous.publications,
                {
                  pluginId: source.pluginId,
                  publisherId: source.publisherId,
                  packageDigest: source.packageDigest,
                  publicAssets,
                },
              ];
        // Reject limits, duplicate versions and publisher drift before allocating a copy.
        const next = parseDesktopPluginApproval({
          ...previous,
          sources: [...previous.sources, source],
          publications,
        });
        const bytes = Buffer.from(JSON.stringify(next));
        if (bytes.byteLength > MAX_APPROVAL_BYTES) invalid("approval_size");
        ensurePrivateDirectory(sourceRoot);
        const sourceRootPins = pinParents(sourceRoot);
        const installed = await installLocalPluginPackage({
          directory: ticket.directory,
          installRoot: sourceRoot,
          signal,
          authorization: async (candidate) => {
            this.#ticketCurrent(ticket, signal);
            assertIdentity(
              {
                ...candidate.descriptor,
                packageDigest: candidate.packageDigest,
              },
              ticket.view,
            );
            this.#approvalCurrent(ticket);
            assertParents(sourceRootPins);
            return Object.freeze({ outcome: "allow" as const });
          },
        });
        this.#ticketCurrent(ticket, signal);
        this.#approvalCurrent(ticket);
        assertParents(sourceRootPins);
        assertIdentity(
          { ...installed.descriptor, packageDigest: installed.packageDigest },
          ticket.view,
        );
        if (installed.directory !== source.directory)
          invalid("source_copy_path");
        const ownedSourcePins = protectOwnedPluginImportSource({
          sourceRoot,
          directory: installed.directory,
          packageDigest: installed.packageDigest,
          sourceRootPins,
        });
        const pending = createPending(
          this.#approvalPath + PENDING_SUFFIX,
          bytes,
          ticket.approval.parents,
        );
        let committed = false;
        try {
          await this.#beforeApprovalCommit();
          this.#ticketCurrent(ticket, signal);
          this.#approvalCurrent(ticket);
          assertParents(sourceRootPins);
          assertParents(ownedSourcePins);
          // Stop may take time. Re-read the selected original bytes before committing approval.
          const finalSource = await verifyLocalPluginPackage({
            directory: ticket.directory,
            signal,
          });
          this.#ticketCurrent(ticket, signal);
          assertIdentity(
            {
              ...finalSource.descriptor,
              packageDigest: finalSource.packageDigest,
            },
            ticket.view,
          );
          const finalCopy = await verifyLocalPluginPackage({
            directory: installed.directory,
            signal,
          });
          this.#ticketCurrent(ticket, signal);
          assertIdentity(
            { ...finalCopy.descriptor, packageDigest: finalCopy.packageDigest },
            ticket.view,
          );
          assertParents(sourceRootPins);
          assertParents(ownedSourcePins);
          this.#approvalCurrent(ticket);
          assertFile(pending.path, pending.snapshot, MAX_APPROVAL_BYTES);
          // No await between the final owner/CAS checks and this commit. Electron's
          // single-instance owner is required; this is not a same-UID OS sandbox.
          this.#ticketCurrent(ticket, signal);
          this.#approvalCurrent(ticket);
          assertParents(ownedSourcePins);
          assertFile(pending.path, pending.snapshot, MAX_APPROVAL_BYTES);
          commitApproval({
            approvalPath: this.#approvalPath,
            pending,
            targetAbsent: ticket.approval.file === null,
          });
          committed = true;
          return Object.freeze({
            sourceId,
            pluginId: source.pluginId,
            publisherId: source.publisherId,
            version: source.version,
            packageDigest: source.packageDigest,
            restartRequired: true as const,
          });
        } catch (error) {
          if (!committed) {
            try {
              removePending(pending);
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                "desktop_local_plugin_source_import_cleanup_failed",
                { cause: error },
              );
            }
          }
          throw error;
        }
      } finally {
        this.#ticket = null;
        this.#claim = null;
      }
    });
  }

  cancelPreview(input: Readonly<{ previewId: string }>): void {
    const value = fields(input, ["previewId"]);
    const id = previewId(value.previewId);
    if (this.#ticket?.view.previewId !== id) return;
    // A preview component unmounts during Main's own runtime stop. It may release
    // an unaccepted preview, but cannot retract an already accepted exact command.
    if (this.#claim !== null) return;
    this.#ticket = null;
    this.#controller?.abort(
      new Error("desktop_local_plugin_source_import_canceled"),
    );
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closed = true;
    this.#ticket = null;
    this.#claim = null;
    this.#controller?.abort(
      new Error("desktop_local_plugin_source_import_closed"),
    );
    this.#closing = (async () => {
      // Aborting is not physical completion, and never opens a second slot.
      await this.#flight?.catch(() => undefined);
    })();
    return this.#closing;
  }

  #run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#current();
    if (this.#flight !== null) invalid("busy");
    const controller = new AbortController();
    this.#controller = controller;
    const flight = Promise.resolve().then(() => {
      this.#current(controller.signal);
      return operation(controller.signal);
    });
    this.#flight = flight;
    return flight.finally(() => {
      if (this.#flight === flight) {
        this.#flight = null;
        this.#controller = null;
      }
    });
  }

  #current(signal?: AbortSignal): void {
    if (this.#closed) invalid("closed");
    signal?.throwIfAborted();
    try {
      this.#assertCurrent();
    } catch (error) {
      this.#closed = true;
      this.#ticket = null;
      this.#claim = null;
      this.#controller?.abort(error);
      throw error;
    }
  }

  #ticketCurrent(ticket: PreviewTicket, signal?: AbortSignal): void {
    this.#current(signal);
    if (this.#ticket !== ticket) invalid("preview_unavailable");
    if (
      Date.now() >= ticket.utcDeadline ||
      performance.now() >= ticket.monotonicDeadline
    ) {
      this.#ticket = null;
      invalid("preview_expired");
    }
  }

  #approvalCurrent(ticket: PreviewTicket): void {
    assertParents(ticket.approval.parents);
    assertPrivateDirectory(this.#dataDirectory);
    assertApproval(this.#approvalPath, ticket.approval.file);
  }
}

function parseConfirmation(
  input: unknown,
): DesktopLocalPluginSourceConfirmation {
  const value = fields(input, [
    "previewId",
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
    "publicAssets",
    "trustNodeExecution",
    "trustUiModule",
  ]);
  const assets = dense(value.publicAssets, 256).map((path) => {
    if (typeof path !== "string") invalid("asset");
    return path;
  });
  if (new Set(assets).size !== assets.length) invalid("asset_duplicate");
  if (
    typeof value.trustNodeExecution !== "boolean" ||
    typeof value.trustUiModule !== "boolean"
  )
    invalid("trust");
  for (const key of ["pluginId", "publisherId", "version", "packageDigest"])
    if (typeof value[key] !== "string") invalid("identity");
  return Object.freeze({
    previewId: previewId(value.previewId),
    pluginId: value.pluginId as string,
    publisherId: value.publisherId as string,
    version: value.version as string,
    packageDigest: value.packageDigest as string,
    publicAssets: Object.freeze(assets),
    trustNodeExecution: value.trustNodeExecution,
    trustUiModule: value.trustUiModule,
  });
}

function selectedAssets(
  input: DesktopLocalPluginSourceConfirmation,
  view: DesktopLocalPluginSourcePreview,
): readonly string[] {
  if (input.publicAssets.length === 0) return Object.freeze([]);
  if (view.uiEntry === null || !input.publicAssets.includes(view.uiEntry.path))
    invalid("ui_entry_required");
  if (
    input.publicAssets.some(
      (path) => !view.publicAssetCandidates.includes(path),
    )
  )
    invalid("asset_not_public");
  if (view.uiEntry.mode === "trustedModule" && !input.trustUiModule)
    invalid("ui_trust_required");
  return Object.freeze([...input.publicAssets]);
}

function sameConfirmation(
  a: DesktopLocalPluginSourceConfirmation,
  b: DesktopLocalPluginSourceConfirmation,
): boolean {
  return (
    a.previewId === b.previewId &&
    a.pluginId === b.pluginId &&
    a.publisherId === b.publisherId &&
    a.version === b.version &&
    a.packageDigest === b.packageDigest &&
    a.trustNodeExecution === b.trustNodeExecution &&
    a.trustUiModule === b.trustUiModule &&
    a.publicAssets.length === b.publicAssets.length &&
    a.publicAssets.every((path, index) => path === b.publicAssets[index])
  );
}

function assertIdentity(
  input: Readonly<{
    pluginId: string;
    publisherId: string;
    version: string;
    packageDigest: string;
    previewId?: string;
  }>,
  view: DesktopLocalPluginSourcePreview,
): void {
  if (
    input.pluginId !== view.pluginId ||
    input.publisherId !== view.publisherId ||
    input.version !== view.version ||
    input.packageDigest !== view.packageDigest ||
    (input.previewId !== undefined && input.previewId !== view.previewId)
  )
    invalid("identity_changed");
}

function dense(input: unknown, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > maximum ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    invalid("assets");
  return Array.from({ length: input.length }, (_, index) => {
    const value = Object.getOwnPropertyDescriptor(input, String(index));
    if (!value?.enumerable || !Object.hasOwn(value, "value")) invalid("assets");
    return value.value;
  });
}
function previewId(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(input))
    invalid("preview_id");
  return input;
}
