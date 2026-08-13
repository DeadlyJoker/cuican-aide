import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type {
  WorkspaceDeliveryLease,
  WorkspaceListDispatcherPort,
  WorkspaceListResolution,
  WorkspaceOperationRecord,
  WorkspaceReadFileAuthorityPort,
  WorkspaceReadFileResolution,
  FrozenWorkspaceReadFileDispatch,
} from "@crewon/application";
import { RuntimeWorkspaceError } from "./runtime-workspace-error.ts";

type Authority = Readonly<{
  workspaceBindingId: string;
  incarnationId: string;
  runtimeBindingId: string;
}>;

/** Executes the packaged desktop's selected local Workspace without a native sidecar. */
export class LocalWorkspaceListDispatchClient
  implements WorkspaceListDispatcherPort
{
  readonly #root: string;
  readonly #authority: Authority;
  readonly #receipts = new Map<string, WorkspaceListResolution>();

  constructor(config: { root: string; authority: Authority }) {
    this.#root = requireAbsoluteRoot(config.root);
    this.#authority = config.authority;
  }

  async execute(
    operation: WorkspaceOperationRecord,
    lease: WorkspaceDeliveryLease,
    signal: AbortSignal,
  ) {
    const command = operation.command;
    this.#assertAuthority(command);
    requireActiveList(signal, lease.expiresAt);
    const prior = this.#receipts.get(command.executionId);
    if (prior !== undefined) return structuredClone(prior);
    const directory = await readdir(this.#root, { withFileTypes: true });
    if (directory.length > command.limits.maxScannedEntries)
      throw listError("workspace_list_scan_limit_exceeded", "notSent");
    let scannedNameBytes = 0;
    const entries = directory.map((entry) => {
      const nameBytes = Buffer.from(entry.name, "utf8");
      scannedNameBytes += nameBytes.byteLength;
      if (
        nameBytes.byteLength < 1 ||
        nameBytes.byteLength > command.limits.maxNameBytes ||
        scannedNameBytes > command.limits.maxScannedNameBytes ||
        entry.name === "." ||
        entry.name === ".." ||
        /[\\/\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(entry.name)
      )
        throw listError("workspace_list_entry_name_invalid", "notSent");
      if (entry.isSymbolicLink())
        throw listError("workspace_list_link_entry_unsupported", "notSent");
      if (!entry.isFile() && !entry.isDirectory())
        throw listError("workspace_list_entry_type_unsupported", "notSent");
      return {
        name: entry.name,
        nameBytes,
        kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
      };
    });
    entries.sort((left, right) =>
      Buffer.compare(left.nameBytes, right.nameBytes),
    );
    const truncated = entries.length > command.limits.maxEntries;
    const result = {
      executionId: command.executionId,
      actionDigest: command.actionDigest,
      commandDigest: command.commandDigest,
      entries: entries
        .slice(0, command.limits.maxEntries)
        .map(({ name, kind }) => ({
          name,
          kind,
        })),
      truncated,
    };
    if (
      Buffer.byteLength(JSON.stringify(result)) > command.limits.maxOutputBytes
    )
      throw listError("workspace_list_result_too_large", "notSent");
    const providerReceiptId = `local-list:${command.executionId}`;
    const resolution: WorkspaceListResolution = {
      status: "completed",
      executionId: command.executionId,
      actionDigest: command.actionDigest,
      commandDigest: command.commandDigest,
      providerReceiptId,
      entries: result.entries,
      truncated: result.truncated,
    };
    this.#receipts.set(command.executionId, resolution);
    return structuredClone(resolution);
  }

  async reconcile(
    operation: WorkspaceOperationRecord,
    _lease: WorkspaceDeliveryLease,
    _signal: AbortSignal,
  ) {
    return structuredClone(
      this.#receipts.get(operation.executionId) ?? unknownList(operation),
    );
  }

  async cancel(
    operation: WorkspaceOperationRecord,
    lease: WorkspaceDeliveryLease,
    signal: AbortSignal,
  ) {
    return this.reconcile(operation, lease, signal);
  }

  async close(): Promise<void> {}

  #assertAuthority(command: WorkspaceOperationRecord["command"]) {
    if (
      command.workspaceBindingId !== this.#authority.workspaceBindingId ||
      command.incarnationId !== this.#authority.incarnationId ||
      command.runtimeBindingId !== this.#authority.runtimeBindingId
    )
      throw listError("runtime_workspace_binding_invalid", "notSent");
  }
}

/** Executes the packaged read_file capability directly against the frozen root. */
export class LocalWorkspaceReadAuthority
  implements WorkspaceReadFileAuthorityPort
{
  readonly #root: string;
  readonly #authority: Authority;
  readonly #receipts = new Map<string, WorkspaceReadFileResolution>();

  constructor(config: { root: string; authority: Authority }) {
    this.#root = requireAbsoluteRoot(config.root);
    this.#authority = config.authority;
  }

  async execute(command: FrozenWorkspaceReadFileDispatch, signal: AbortSignal) {
    this.#assertAuthority(command);
    requireActiveRead(signal, command.expiresAt);
    const prior = this.#receipts.get(command.executionId);
    if (prior !== undefined) return structuredClone(prior);
    const content = await readBoundedLocalFile(
      this.#root,
      command.relativePathSegments,
      command.limits.maxOutputBytes,
      signal,
    );
    const providerReceiptId = `local-read:${command.executionId}`;
    const resolution: WorkspaceReadFileResolution = {
      status: "completed",
      executionId: command.executionId,
      actionDigest: command.actionDigest,
      commandDigest: command.commandDigest,
      providerReceiptId,
      result: {
        schemaVersion: "crewon.workspace-file-read-result.v0",
        encoding: "utf8",
        content,
        byteLength: Buffer.byteLength(content),
        outputDigest: digestUtf8(content),
      },
    };
    this.#receipts.set(command.executionId, resolution);
    return structuredClone(resolution);
  }

  async reconcile(
    command: FrozenWorkspaceReadFileDispatch,
    _signal: AbortSignal,
  ) {
    return structuredClone(
      this.#receipts.get(command.executionId) ?? unknownRead(command),
    );
  }

  async cancel(command: FrozenWorkspaceReadFileDispatch, signal: AbortSignal) {
    return this.reconcile(command, signal);
  }

  async close(): Promise<void> {}

  #assertAuthority(command: FrozenWorkspaceReadFileDispatch) {
    if (
      command.runtimeBindingId !== this.#authority.runtimeBindingId ||
      command.workspaceBindingId !== this.#authority.workspaceBindingId ||
      command.incarnationId !== this.#authority.incarnationId
    )
      throw readError("runtime_workspace_binding_invalid", "notSent");
  }
}

async function readBoundedLocalFile(
  root: string,
  segments: readonly string[],
  maximumBytes: number,
  signal: AbortSignal,
) {
  if (signal.aborted) throw readError("workspace_read_aborted", "notSent");
  const canonicalRoot = await realpath(root);
  const candidate = resolve(canonicalRoot, ...segments);
  const relativePath = relative(canonicalRoot, candidate);
  if (relativePath.startsWith("..") || isAbsolute(relativePath))
    throw readError("workspace_read_path_invalid", "notSent");
  let current = canonicalRoot;
  for (const segment of segments) {
    current = resolve(current, segment);
    if ((await lstat(current)).isSymbolicLink())
      throw readError("workspace_read_link_unsupported", "notSent");
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(candidate, flags);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw readError("workspace_read_not_file", "notSent");
    if (stats.size > maximumBytes)
      throw readError("workspace_read_output_too_large", "notSent");
    const bytes = await handle.readFile();
    if (signal.aborted)
      throw readError("workspace_read_aborted", "possiblySent");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof RuntimeWorkspaceError) throw error;
    throw readError("workspace_read_failed", "notSent", error);
  } finally {
    await handle.close();
  }
}

function requireAbsoluteRoot(value: string) {
  if (!isAbsolute(value)) throw new Error("runtime_workspace_root_invalid");
  return value;
}

function requireActiveList(signal: AbortSignal, expiresAt: string) {
  if (signal.aborted || Date.now() >= Date.parse(expiresAt))
    throw listError("runtime_workspace_delivery_lease_expired", "notSent");
}

function requireActiveRead(signal: AbortSignal, expiresAt: string) {
  if (signal.aborted || Date.now() >= Date.parse(expiresAt))
    throw readError("runtime_workspace_delivery_lease_expired", "notSent");
}

function unknownList(
  operation: WorkspaceOperationRecord,
): WorkspaceListResolution {
  return {
    status: "unknownOutcome",
    executionId: operation.executionId,
    actionDigest: operation.command.actionDigest,
    commandDigest: operation.command.commandDigest,
    providerReceiptId: operation.resolution?.providerReceiptId ?? null,
  };
}

function unknownRead(
  command: FrozenWorkspaceReadFileDispatch,
): WorkspaceReadFileResolution {
  return {
    status: "unknownOutcome",
    executionId: command.executionId,
    actionDigest: command.actionDigest,
    commandDigest: command.commandDigest,
    providerReceiptId: command.providerReceiptId,
  };
}

function listError(code: string, certainty: "notSent" | "possiblySent") {
  return new RuntimeWorkspaceError(code, { certainty });
}

function readError(
  code: string,
  certainty: "notSent" | "possiblySent",
  cause?: unknown,
) {
  return new RuntimeWorkspaceError(code, {
    certainty,
    cause,
  });
}

function digestUtf8(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
