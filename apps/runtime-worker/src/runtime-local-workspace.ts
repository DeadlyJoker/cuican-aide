import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
  canonicalDeviceFilesystemReadCommandDigest,
  parseDeviceFilesystemReadCommand,
  parseDeviceWorkspaceListCommand,
  type DeviceFilesystemReadCommand,
  type DeviceFilesystemReadDispatchReference,
  type DeviceFilesystemReadDispatchResolution,
  type DeviceFilesystemReadRouteIntent,
  type DeviceWorkspaceListCommand,
  type DeviceWorkspaceListDispatchReference,
  type DeviceWorkspaceListDispatchResolution,
} from "@crewon/contracts";
import {
  DeviceWorkspaceListDispatchClientError,
  type DeviceWorkspaceListDispatchClientPort,
} from "@crewon/device-dispatch";

import {
  RuntimeWorkspaceReadGatewayClientError,
  type RuntimeWorkspaceReadGatewayClientPort,
} from "./runtime-workspace-read-gateway-client.ts";

type Authority = Readonly<{
  workspaceBindingId: string;
  incarnationId: string;
  deviceBindingId: string;
  deviceId: string;
  runtimeBindingId: string;
}>;

/** Executes the packaged desktop's selected local Workspace without a native sidecar. */
export class LocalWorkspaceListDispatchClient
  implements DeviceWorkspaceListDispatchClientPort
{
  readonly #root: string;
  readonly #authority: Authority;
  readonly #receipts = new Map<string, DeviceWorkspaceListDispatchResolution>();

  constructor(config: { root: string; authority: Authority }) {
    this.#root = requireAbsoluteRoot(config.root);
    this.#authority = config.authority;
  }

  async execute(commandInput: DeviceWorkspaceListCommand, signal: AbortSignal) {
    const command = parseDeviceWorkspaceListCommand(commandInput);
    this.#assertAuthority(command);
    requireActiveList(signal, command.expiresAt);
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
    entries.sort((left, right) => Buffer.compare(left.nameBytes, right.nameBytes));
    const truncated = entries.length > command.limits.maxEntries;
    const result = {
      schemaVersion: "crewon.workspace-list-result.v0" as const,
      executionId: command.executionId,
      actionDigest: command.actionDigest,
      commandDigest: command.commandDigest,
      entries: entries.slice(0, command.limits.maxEntries).map(({ name, kind }) => ({
        name,
        kind,
      })),
      truncated,
    };
    if (Buffer.byteLength(JSON.stringify(result)) > command.limits.maxOutputBytes)
      throw listError("workspace_list_result_too_large", "notSent");
    const receiptId = `local-list:${command.executionId}`;
    const resolution: DeviceWorkspaceListDispatchResolution = {
      status: "completed",
      executionId: command.executionId,
      receiptId,
      terminal: {
        schemaVersion: "crewon.device-workspace-list-event.v0",
        protocolVersion: 1,
        commandKind: "workspaceList",
        deviceId: command.deviceId,
        executionId: command.executionId,
        receiptId,
        connectionEpoch: 1,
        workspaceBindingId: command.workspaceBindingId,
        incarnationId: command.incarnationId,
        deviceBindingId: command.deviceBindingId,
        runtimeBindingId: command.runtimeBindingId,
        actionDigest: command.actionDigest,
        commandDigest: command.commandDigest,
        sequence: 2,
        observedAt: new Date().toISOString(),
        type: "workspace_list.completed",
        data: { result },
      },
    };
    this.#receipts.set(command.executionId, resolution);
    return structuredClone(resolution);
  }

  async reconcile(reference: DeviceWorkspaceListDispatchReference) {
    return structuredClone(
      this.#receipts.get(reference.executionId) ?? unknownList(reference),
    );
  }

  async cancel(reference: DeviceWorkspaceListDispatchReference) {
    return this.reconcile(reference);
  }

  async close(): Promise<void> {}

  #assertAuthority(command: DeviceWorkspaceListCommand) {
    if (
      command.workspaceBindingId !== this.#authority.workspaceBindingId ||
      command.incarnationId !== this.#authority.incarnationId ||
      command.deviceBindingId !== this.#authority.deviceBindingId ||
      command.deviceId !== this.#authority.deviceId ||
      command.runtimeBindingId !== this.#authority.runtimeBindingId
    )
      throw listError("runtime_workspace_binding_invalid", "notSent");
  }
}

/** Executes the packaged read_file capability against the same frozen root. */
export class LocalWorkspaceReadGatewayClient
  implements RuntimeWorkspaceReadGatewayClientPort
{
  readonly #root: string;
  readonly #authority: Authority;
  readonly #receipts = new Map<string, DeviceFilesystemReadDispatchResolution>();

  constructor(config: { root: string; authority: Authority }) {
    this.#root = requireAbsoluteRoot(config.root);
    this.#authority = config.authority;
  }

  async execute(
    intent: DeviceFilesystemReadRouteIntent,
    commandInput: DeviceFilesystemReadCommand,
    signal: AbortSignal,
  ) {
    const command = parseDeviceFilesystemReadCommand(commandInput);
    this.#assertAuthority(intent, command);
    requireActiveRead(signal, command.expiresAt);
    const prior = this.#receipts.get(command.executionId);
    if (prior !== undefined) return structuredClone(prior);
    const content = await readBoundedLocalFile(
      this.#root,
      command.arguments.relativePathSegments,
      command.limits.maxOutputBytes,
      signal,
    );
    const commandDigest = canonicalDeviceFilesystemReadCommandDigest(
      command,
      digestUtf8,
    );
    const receiptId = `local-read:${command.executionId}`;
    const resolution: DeviceFilesystemReadDispatchResolution = {
      status: "completed",
      executionId: command.executionId,
      receiptId,
      terminal: {
        schemaVersion: "crewon.device-filesystem-read-event.v0",
        protocolVersion: 1,
        commandKind: "workspaceRead",
        deviceId: command.deviceId,
        executionId: command.executionId,
        receiptId,
        connectionEpoch: 1,
        workspaceBindingId: command.workspaceBindingId,
        incarnationId: command.arguments.workspaceIncarnationId,
        commandDigest,
        sequence: 2,
        observedAt: new Date().toISOString(),
        type: "workspace_read.completed",
        data: {
          result: {
            schemaVersion: "crewon.workspace-file-read-result.v0",
            encoding: "utf8",
            content,
            byteLength: Buffer.byteLength(content),
            outputDigest: digestUtf8(content),
          },
        },
      },
    };
    this.#receipts.set(command.executionId, resolution);
    return structuredClone(resolution);
  }

  async reconcile(
    _intent: DeviceFilesystemReadRouteIntent,
    reference: DeviceFilesystemReadDispatchReference,
  ) {
    return structuredClone(
      this.#receipts.get(reference.executionId) ?? unknownRead(reference),
    );
  }

  async cancel(
    intent: DeviceFilesystemReadRouteIntent,
    reference: DeviceFilesystemReadDispatchReference,
  ) {
    return this.reconcile(intent, reference);
  }

  async close(): Promise<void> {}

  #assertAuthority(
    intent: DeviceFilesystemReadRouteIntent,
    command: DeviceFilesystemReadCommand,
  ) {
    if (
      intent.deviceBindingId !== this.#authority.deviceBindingId ||
      intent.runtimeBindingId !== this.#authority.runtimeBindingId ||
      command.deviceId !== this.#authority.deviceId ||
      command.workspaceBindingId !== this.#authority.workspaceBindingId ||
      command.arguments.workspaceIncarnationId !== this.#authority.incarnationId
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
    if (signal.aborted) throw readError("workspace_read_aborted", "possiblySent");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof RuntimeWorkspaceReadGatewayClientError) throw error;
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
  reference: DeviceWorkspaceListDispatchReference,
): DeviceWorkspaceListDispatchResolution {
  return {
    status: "unknownOutcome",
    executionId: reference.executionId,
    receiptId: reference.receiptId,
    terminal: null,
  };
}

function unknownRead(
  reference: DeviceFilesystemReadDispatchReference,
): DeviceFilesystemReadDispatchResolution {
  return {
    status: "unknownOutcome",
    executionId: reference.executionId,
    receiptId: reference.receiptId,
    terminal: null,
  };
}

function listError(
  code: string,
  certainty: "notSent" | "possiblySent",
) {
  return new DeviceWorkspaceListDispatchClientError(code, { certainty });
}

function readError(
  code: string,
  certainty: "notSent" | "possiblySent",
  cause?: unknown,
) {
  return new RuntimeWorkspaceReadGatewayClientError(code, {
    certainty,
    cause,
  });
}

function digestUtf8(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
