import { randomBytes } from "node:crypto";
import { issuePluginProjectWorkspaceNativeObservation } from "@crewon/application/host-project-workspaces";
import {
  qualifyPluginProjectWorkspacePreparation,
  type PluginProjectWorkspaceNativeObservation,
  type PluginProjectWorkspacePreparation,
} from "@crewon/application";
import {
  DESKTOP_PROJECT_WORKSPACE_REQUEST_SCHEMA,
  DESKTOP_PROJECT_WORKSPACE_PREPARE_REQUEST_SCHEMA,
  DESKTOP_PROJECT_WORKSPACE_PREPARE_RESPONSE_SCHEMA,
  parseDesktopNativeProjectWorkspacePrepareRequest,
  parseDesktopNativeProjectWorkspacePrepareResponse,
  type DesktopNativeProjectWorkspacePrepareRequest,
  type DesktopNativeProjectWorkspaceRequest,
  DESKTOP_PROJECT_WORKSPACE_RESPONSE_SCHEMA,
  parseDesktopNativeProjectWorkspaceTicket,
  parseDesktopNativeProjectWorkspaceResponse,
  type DesktopNativeProjectWorkspaceResponse,
  type DesktopNativeProjectWorkspaceTicket,
} from "@crewon/contracts/plugins";

type Pending = Readonly<{
  timer: ReturnType<typeof setTimeout>;
  schema: string;
  settle(error: Error | null, result?: unknown): void;
}>;
let owner: DesktopNativeProjectWorkspaceClient | undefined;

/** Actual Control child's private parent IPC only; not a plugin/HTTP grant or an allocation retry queue. */
export class DesktopNativeProjectWorkspaceClient {
  readonly #signal: AbortSignal;
  readonly #deadlineMs: number;
  readonly #send: NonNullable<NodeJS.Process["send"]>;
  readonly #pending = new Map<string, Pending>();
  readonly #physical = new Set<Promise<void>>();
  readonly #message = (input: unknown) => this.#accept(input);
  readonly #withdraw = () => this.withdraw();
  #withdrawn = false;
  #closing: Promise<void> | undefined;
  constructor(input: Readonly<{ signal: AbortSignal; deadlineMs?: number }>) {
    if (
      input === null ||
      typeof input !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
      unavailable();
    const keys = Reflect.ownKeys(input);
    if (
      !Object.hasOwn(input, "signal") ||
      (Object.hasOwn(input, "deadlineMs") &&
        typeof Object.getOwnPropertyDescriptor(input, "deadlineMs")?.value !==
          "number") ||
      keys.some((key) => key !== "signal" && key !== "deadlineMs") ||
      keys.some(
        (key) =>
          !Object.hasOwn(
            Object.getOwnPropertyDescriptor(input, key)!,
            "value",
          ) || !Object.getOwnPropertyDescriptor(input, key)!.enumerable,
      )
    )
      unavailable();
    this.#signal = input.signal;
    this.#deadlineMs = input.deadlineMs ?? 5000;
    if (
      !(this.#signal instanceof AbortSignal) ||
      !Number.isSafeInteger(this.#deadlineMs) ||
      this.#deadlineMs < 10 ||
      this.#deadlineMs > 30_000 ||
      owner !== undefined ||
      process.channel === undefined ||
      typeof process.send !== "function"
    )
      unavailable();
    this.#assertCurrent();
    this.#send = process.send.bind(process);
    owner = this;
    process.on("message", this.#message);
    process.on("disconnect", this.#withdraw);
    this.#signal.addEventListener("abort", this.#withdraw, { once: true });
  }
  async allocate(
    input: DesktopNativeProjectWorkspaceTicket,
    signal?: AbortSignal,
  ): Promise<DesktopNativeProjectWorkspaceResponse> {
    this.#assertCurrent();
    const ticket = parseDesktopNativeProjectWorkspaceTicket(input);
    const remaining = Date.parse(ticket.expiresAt) - Date.now();
    if (remaining <= 0 || remaining > 30_000) throw failure("ticket_expired");
    return this.#exchange({
      request: {
        schemaVersion: DESKTOP_PROJECT_WORKSPACE_REQUEST_SCHEMA,
        requestId: `allocation-${randomBytes(24).toString("hex")}`,
        ticketId: ticket.ticketId,
      },
      responseSchema: DESKTOP_PROJECT_WORKSPACE_RESPONSE_SCHEMA,
      parse: parseDesktopNativeProjectWorkspaceResponse,
      deadlineMs: Math.min(this.#deadlineMs, remaining),
      ...(signal === undefined ? {} : { signal }),
    });
  }
  async #exchange<T>(
    input: Readonly<{
      request:
        | DesktopNativeProjectWorkspaceRequest
        | DesktopNativeProjectWorkspacePrepareRequest;
      responseSchema: string;
      parse(value: unknown): T;
      deadlineMs: number;
      signal?: AbortSignal;
    }>,
  ): Promise<T> {
    this.#assertCurrent();
    const { deadlineMs, signal } = input;
    const requestId = input.request.requestId;
    if (signal !== undefined && !(signal instanceof AbortSignal)) unavailable();
    if (signal?.aborted) throw failure("request_aborted");
    if (this.#physical.size >= 4 || this.#pending.size >= 4)
      throw failure("capacity_exceeded");
    const response = new Promise<T>((resolve, reject) => {
      const abort = () => settle(failure("request_aborted"));
      let done = false;
      const settle = (error: Error | null, result?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.#pending.delete(requestId);
        if (error !== null) reject(error);
        else {
          try {
            resolve(input.parse(result));
          } catch {
            reject(failure("response_invalid"));
          }
        }
      };
      const timer = setTimeout(
        () => settle(failure("deadline_exceeded")),
        deadlineMs,
      );
      this.#pending.set(requestId, {
        timer,
        settle,
        schema: input.responseSchema,
      });
      signal?.addEventListener("abort", abort, { once: true });
    });
    let physical!: Promise<void>;
    physical = new Promise<void>((resolve) => {
      let done = false;
      const finish = (error?: Error | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error)
          this.#pending.get(requestId)?.settle(failure("send_unavailable"));
        resolve();
      };
      const timer = setTimeout(
        () => finish(new Error("deadline_exceeded")),
        deadlineMs,
      );
      try {
        this.#send(input.request, finish);
      } catch {
        finish(new Error("send_unavailable"));
      }
    });
    this.#physical.add(physical);
    void physical.finally(() => this.#physical.delete(physical));
    const result = await response;
    this.#assertCurrent();
    if (signal?.aborted) throw failure("request_aborted");
    return result;
  }
  /** Actual Host project path. A Native result is scoped evidence, never a SQL/Thread/Run grant. */
  async allocateForProject(
    input: Readonly<{
      preparation: PluginProjectWorkspacePreparation;
      ticket: DesktopNativeProjectWorkspaceTicket;
      signal?: AbortSignal;
    }>,
  ): Promise<DesktopNativeProjectWorkspaceResponse> {
    this.#assertCurrent();
    const fields = allocationInput(input);
    const source = qualifyPluginProjectWorkspacePreparation(fields.preparation);
    const ticket = parseDesktopNativeProjectWorkspaceTicket(fields.ticket);
    await source.assertCurrent();
    source.assertActive();
    const result = await this.allocate(ticket, fields.signal);
    await source.assertCurrent();
    source.assertActive();
    if (
      result.outcome === "observed" &&
      result.allocation.workspaceId !== source.expectedWorkspaceId
    )
      throw failure("project_mismatch");
    return result;
  }
  async observeForProject(
    input: Parameters<
      DesktopNativeProjectWorkspaceClient["allocateForProject"]
    >[0],
  ): Promise<PluginProjectWorkspaceNativeObservation> {
    const fields = allocationInput(input);
    const response = await this.allocateForProject(fields);
    return issuePluginProjectWorkspaceNativeObservation(
      fields.preparation,
      response,
      () => this.#assertCurrent(),
    );
  }
  /** Trusted Control only: a real live UI preparation is required before the parent ticket request. */
  async observePreparedProject(
    preparation: PluginProjectWorkspacePreparation,
    signal?: AbortSignal,
  ): Promise<PluginProjectWorkspaceNativeObservation> {
    this.#assertCurrent();
    const source = qualifyPluginProjectWorkspacePreparation(preparation);
    await source.assertCurrent();
    source.assertActive();
    const request = parseDesktopNativeProjectWorkspacePrepareRequest({
      schemaVersion: DESKTOP_PROJECT_WORKSPACE_PREPARE_REQUEST_SCHEMA,
      requestId: `preparation-${randomBytes(24).toString("hex")}`,
      projectId: source.owner.projectId,
      packageIdentity: source.packageIdentity,
    });
    const response = await this.#exchange({
      request,
      responseSchema: DESKTOP_PROJECT_WORKSPACE_PREPARE_RESPONSE_SCHEMA,
      parse: parseDesktopNativeProjectWorkspacePrepareResponse,
      deadlineMs: this.#deadlineMs,
      ...(signal === undefined ? {} : { signal }),
    });
    await source.assertCurrent();
    source.assertActive();
    if (response.outcome !== "prepared") throw failure(response.reasonCode);
    return this.observeForProject({
      preparation,
      ticket: response.ticket,
      ...(signal === undefined ? {} : { signal }),
    });
  }
  withdraw(): void {
    this.#withdrawn = true;
    for (const pending of this.#pending.values())
      pending.settle(failure("unavailable"));
  }
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.withdraw();
    process.removeListener("message", this.#message);
    process.removeListener("disconnect", this.#withdraw);
    this.#signal.removeEventListener("abort", this.#withdraw);
    this.#closing = Promise.all([...this.#physical]).then(() => {
      if (owner === this) owner = undefined;
    });
    return this.#closing;
  }
  #assertCurrent(): void {
    if (this.#withdrawn || this.#signal.aborted || !process.connected)
      unavailable();
  }
  #accept(input: unknown): void {
    if (
      this.#withdrawn ||
      ![
        DESKTOP_PROJECT_WORKSPACE_RESPONSE_SCHEMA,
        DESKTOP_PROJECT_WORKSPACE_PREPARE_RESPONSE_SCHEMA,
      ].includes(dataProperty(input, "schemaVersion") as string)
    )
      return;
    const id = dataProperty(input, "requestId");
    if (typeof id !== "string") return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    try {
      if (dataProperty(input, "schemaVersion") !== pending.schema)
        throw failure("response_invalid");
      pending.settle(null, input);
    } catch {
      pending.settle(failure("response_invalid"));
    }
  }
}
function dataProperty(input: unknown, key: string): unknown {
  return input !== null && typeof input === "object"
    ? Object.getOwnPropertyDescriptor(input, key)?.value
    : undefined;
}
function failure(reason: string): Error {
  return new Error(`desktop_native_project_workspace_client_${reason}`);
}
function allocationInput(
  input: Parameters<
    DesktopNativeProjectWorkspaceClient["allocateForProject"]
  >[0],
) {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    unavailable();
  const fields = [
    "preparation",
    "ticket",
    ...(Object.hasOwn(input, "signal") ? ["signal"] : []),
  ];
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    unavailable();
  for (const key of fields) {
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (!d?.enumerable || !Object.hasOwn(d, "value")) unavailable();
  }
  return Object.freeze({
    preparation: Object.getOwnPropertyDescriptor(input, "preparation")!
      .value as PluginProjectWorkspacePreparation,
    ticket: Object.getOwnPropertyDescriptor(input, "ticket")!
      .value as DesktopNativeProjectWorkspaceTicket,
    signal: Object.getOwnPropertyDescriptor(input, "signal")?.value as
      | AbortSignal
      | undefined,
  });
}
function unavailable(): never {
  throw failure("unavailable");
}
