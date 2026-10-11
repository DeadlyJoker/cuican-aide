import { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  DESKTOP_PROJECT_WORKSPACE_REQUEST_SCHEMA as REQUEST_SCHEMA,
  DESKTOP_PROJECT_WORKSPACE_RESPONSE_SCHEMA as RESPONSE_SCHEMA,
  DESKTOP_PROJECT_WORKSPACE_TICKET_SCHEMA as TICKET_SCHEMA,
  type DesktopNativePluginPackageIdentity,
  type DesktopNativeProjectWorkspaceTicket,
  type DesktopNativeProjectWorkspaceRequest,
  type DesktopNativeProjectWorkspaceResponse,
} from "@crewon/contracts/plugins";
export type {
  DesktopNativeProjectWorkspaceTicket,
  DesktopNativeProjectWorkspaceRequest,
  DesktopNativeProjectWorkspaceResponse,
} from "@crewon/contracts/plugins";
import { parsePluginProjectWorkspaceOwner } from "@crewon/domain";
import { captureDesktopNativePluginAuthorityOwner } from "./desktopNativePluginAuthority.ts";
import { LocalWorkspaceAuthority } from "./localWorkspaceRegistry.ts";
import { LocalWorkspaceProjectAllocator } from "./localWorkspaceProjectAllocator.ts";
import { exactRecord } from "./localWorkspaceProjectAllocationJournal.ts";
import {
  qualifyDesktopNativeProjectWorkspaceState,
  type DesktopNativeProjectWorkspaceState,
} from "./desktopNativeProjectWorkspaceState.ts";

const MAX_TICKETS = 16;
const MAX_PENDING_REQUESTS = 4;
const children = new WeakMap<
  ChildProcess,
  DesktopNativeProjectWorkspaceBridge
>();

type FailureCode = Extract<
  DesktopNativeProjectWorkspaceResponse,
  { outcome: "unavailable" }
>["reasonCode"];
type Preparation = Readonly<{
  projectId: string;
  packageIdentity: DesktopNativePluginPackageIdentity;
}>;
type Ticket = Readonly<{
  child: ChildProcess;
  generation: string;
  authorityEpoch: string;
  authorityId: string;
  owner: ReturnType<typeof parsePluginProjectWorkspaceOwner>;
  expiresAtMs: number;
  timer: ReturnType<typeof setTimeout>;
  projectState?: ReturnType<typeof qualifyDesktopNativeProjectWorkspaceState>;
}>;
type CapturedRequest =
  | Readonly<{ kind: "valid"; request: DesktopNativeProjectWorkspaceRequest }>
  | Readonly<{ kind: "invalid"; requestId: string }>;
type Input = Readonly<{
  nativeAuthority: unknown;
  workspaces: LocalWorkspaceAuthority;
  control: ChildProcess;
  signal: AbortSignal;
  deadlineMs?: number;
}>;

/**
 * Private Main transport only. Main preparation permits empty Native allocation;
 * neither a child identity, ticket nor registered directory grants metadata, SQL or Agent access.
 * This module is deliberately absent from renderer IPC, the plugin SDK and production bootstrap.
 */
export class DesktopNativeProjectWorkspaceBridge {
  readonly #nativeOwner: unknown;
  readonly #pin: ReturnType<typeof captureDesktopNativePluginAuthorityOwner>;
  readonly #workspaces: LocalWorkspaceAuthority;
  readonly #control: ChildProcess;
  readonly #signal: AbortSignal;
  readonly #deadlineMs: number;
  readonly #generation = randomBytes(32).toString("hex");
  readonly #tickets = new Map<string, Ticket>();
  readonly #physical = new Set<Promise<void>>();
  readonly #send: NonNullable<ChildProcess["send"]>;
  readonly #message = (input: unknown) => this.#accept(input);
  readonly #withdraw = () => this.withdraw();
  #withdrawn = false;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(input: Input) {
    const fields = exactRecord(input, [
      "nativeAuthority",
      "workspaces",
      "control",
      "signal",
      ...(Object.hasOwn(input, "deadlineMs") ? ["deadlineMs"] : []),
    ]);
    this.#nativeOwner = fields.nativeAuthority;
    this.#pin = captureDesktopNativePluginAuthorityOwner(this.#nativeOwner);
    this.#workspaces = input.workspaces;
    this.#control = input.control;
    this.#signal = input.signal;
    this.#deadlineMs = input.deadlineMs ?? 5000;
    if (
      !Number.isSafeInteger(this.#deadlineMs) ||
      this.#deadlineMs < 10 ||
      this.#deadlineMs > 30_000 ||
      !(this.#signal instanceof AbortSignal) ||
      !(this.#control instanceof ChildProcess) ||
      !this.#control.connected ||
      this.#control.channel === null ||
      this.#control.channel === undefined ||
      !Number.isSafeInteger(this.#control.pid) ||
      Number(this.#control.pid) < 1 ||
      this.#control.exitCode !== null ||
      this.#control.signalCode !== null ||
      typeof this.#control.send !== "function" ||
      children.has(this.#control)
    )
      unavailable();
    this.#assertCurrent();
    this.#send = this.#control.send.bind(this.#control);
    children.set(this.#control, this);
    this.#control.on("message", this.#message);
    for (const event of ["disconnect", "exit", "error", "close"])
      this.#control.on(event, this.#withdraw);
    this.#signal.addEventListener("abort", this.#withdraw, { once: true });
    this.#pin.signal.addEventListener("abort", this.#withdraw, { once: true });
  }

  /** Main-internal only: a future caller must separately qualify the real Host project operation. */
  prepare(input: Preparation): DesktopNativeProjectWorkspaceTicket {
    return this.#prepare({ preparation: input });
  }
  /** Current persistent project/selection proof from this exact Main owner; Control's independent live UI qualification is still required. */
  prepareForProject(
    reference: DesktopNativeProjectWorkspaceState,
  ): DesktopNativeProjectWorkspaceTicket {
    this.#assertCurrent();
    const projectState = qualifyDesktopNativeProjectWorkspaceState(reference);
    if (projectState.nativeAuthority !== this.#nativeOwner) unavailable();
    return this.#prepare({
      preparation: {
        projectId: projectState.owner.projectId,
        packageIdentity: projectState.packageIdentity,
      },
      projectState,
    });
  }
  #prepare(
    input: Readonly<{
      preparation: Preparation;
      projectState?: ReturnType<
        typeof qualifyDesktopNativeProjectWorkspaceState
      >;
    }>,
  ): DesktopNativeProjectWorkspaceTicket {
    this.#assertCurrent();
    const { preparation, projectState } = input;
    const value = exactRecord(preparation, ["projectId", "packageIdentity"]),
      identity = exactRecord(value.packageIdentity, [
        "pluginId",
        "publisherId",
        "version",
        "packageDigest",
      ]);
    const approved = this.#pin.packages.find((pkg) =>
      ["pluginId", "publisherId", "version", "packageDigest"].every(
        (key) => pkg[key as keyof typeof pkg] === identity[key],
      ),
    );
    if (
      approved === undefined ||
      approved.approvalRequirement !== "none" ||
      this.#tickets.size >= MAX_TICKETS
    )
      unavailable();
    const owner = parsePluginProjectWorkspaceOwner({
      ...this.#pin.authority.actor,
      profileId: this.#pin.authority.scope.profileId,
      pluginId: approved.pluginId,
      publisherId: approved.publisherId,
      projectId: value.projectId,
    });
    const ticketId = randomBytes(32).toString("hex"),
      expiresAtMs = Date.now() + this.#deadlineMs;
    const timer = setTimeout(() => this.#burn(ticketId), this.#deadlineMs);
    timer.unref();
    this.#tickets.set(
      ticketId,
      Object.freeze({
        child: this.#control,
        generation: this.#generation,
        authorityEpoch: this.#pin.authorityEpoch,
        authorityId: this.#pin.authority.authorityId,
        owner,
        expiresAtMs,
        timer,
        ...(projectState === undefined ? {} : { projectState }),
      }),
    );
    try {
      this.#assertCurrent();
      projectState?.assertCurrent();
      return Object.freeze({
        schemaVersion: TICKET_SCHEMA,
        ticketId,
        expiresAt: new Date(expiresAtMs).toISOString(),
      });
    } catch (error) {
      this.#burn(ticketId);
      throw error;
    }
  }

  /** Logical revocation is synchronous; no new ticket or Native operation survives it. */
  withdraw(): void {
    this.#withdrawn = true;
    for (const ticketId of this.#tickets.keys()) this.#burn(ticketId);
  }

  /** Join this bridge's requests and remove only its listeners; never kill/disconnect the child. */
  close(): Promise<void> {
    this.withdraw();
    return (this.#closing ??= Promise.allSettled([...this.#physical]).then(
      () => {
        this.#closed = true;
        this.#control.removeListener("message", this.#message);
        for (const event of ["disconnect", "exit", "error", "close"])
          this.#control.removeListener(event, this.#withdraw);
        this.#signal.removeEventListener("abort", this.#withdraw);
        this.#pin.signal.removeEventListener("abort", this.#withdraw);
        if (children.get(this.#control) === this)
          children.delete(this.#control);
      },
    ));
  }

  #assertCurrent(): void {
    try {
      if (
        this.#withdrawn ||
        this.#closed ||
        this.#signal.aborted ||
        !this.#control.connected ||
        this.#control.exitCode !== null ||
        this.#control.signalCode !== null ||
        captureDesktopNativePluginAuthorityOwner(this.#nativeOwner) !==
          this.#pin ||
        LocalWorkspaceAuthority.prototype.projectAllocationDataDirectory.call(
          this.#workspaces,
        ) !== this.#pin.dataDirectory
      )
        unavailable();
    } catch {
      this.withdraw();
      unavailable();
    }
  }

  #burn(ticketId: string): Ticket | undefined {
    const ticket = this.#tickets.get(ticketId);
    if (ticket !== undefined) {
      this.#tickets.delete(ticketId);
      clearTimeout(ticket.timer);
    }
    return ticket;
  }

  #accept(input: unknown): void {
    if (this.#withdrawn || this.#closed) return;
    // Coexist with other private child protocols without reading or retaining their payloads.
    const schema = dataProperty(input, "schemaVersion");
    if (schema !== REQUEST_SCHEMA) return;
    const rawId = dataProperty(input, "ticketId"),
      ticket = validTicketId(rawId) ? this.#burn(rawId) : undefined;
    const requestId = dataProperty(input, "requestId");
    if (!validRequestId(requestId)) return;
    let captured: CapturedRequest;
    try {
      const request = exactRecord(input, [
        "schemaVersion",
        "requestId",
        "ticketId",
      ]);
      if (!validTicketId(request.ticketId)) throw new Error("request_invalid");
      captured = Object.freeze({
        kind: "valid",
        request: Object.freeze({
          schemaVersion: REQUEST_SCHEMA,
          requestId,
          ticketId: request.ticketId,
        }),
      });
    } catch {
      captured = Object.freeze({ kind: "invalid", requestId });
    }
    if (this.#physical.size >= MAX_PENDING_REQUESTS) {
      this.withdraw();
      return;
    }
    // Burn precedes validation/queueing. Malformed use, failure and send failure cannot reuse a ticket.
    // Retain only three bounded ASCII strings (or one invalid correlation id), never raw IPC JSON.
    const physical = Promise.resolve().then(() =>
      this.#dispatch(captured, ticket),
    );
    this.#physical.add(physical);
    void physical
      .finally(() => this.#physical.delete(physical))
      .catch(() => {});
  }

  async #dispatch(
    input: CapturedRequest,
    ticket: Ticket | undefined,
  ): Promise<void> {
    const requestId =
      input.kind === "valid" ? input.request.requestId : input.requestId;
    let reasonCode: FailureCode = "request_invalid";
    try {
      if (input.kind !== "valid") throw new Error("request_invalid");
      reasonCode = "ticket_unavailable";
      this.#assertCurrent();
      if (
        ticket === undefined ||
        ticket.child !== this.#control ||
        ticket.generation !== this.#generation ||
        ticket.authorityEpoch !== this.#pin.authorityEpoch ||
        ticket.authorityId !== this.#pin.authority.authorityId
      )
        throw new Error("ticket_unavailable");
      reasonCode = "deadline_exceeded";
      if (Date.now() >= ticket.expiresAtMs)
        throw new Error("deadline_exceeded");
      reasonCode = "allocation_unavailable";
      ticket.projectState?.assertCurrent();
      const allocation = new LocalWorkspaceProjectAllocator(
        this.#workspaces,
        ticket.owner,
      ).provision();
      reasonCode = "deadline_exceeded";
      if (Date.now() >= ticket.expiresAtMs)
        throw new Error("deadline_exceeded");
      // Native owner/profile/epoch/file pins and the actual child are rechecked immediately
      // before publishing. A prior Native commit does not compensate a revoked SQL grant.
      this.#assertCurrent();
      if (ticket.projectState !== undefined) {
        reasonCode = "allocation_unavailable";
        ticket.projectState.assertCurrent();
        if (Date.now() >= ticket.expiresAtMs) {
          reasonCode = "deadline_exceeded";
          throw new Error("deadline_exceeded");
        }
      }
      await this.#publish(
        Object.freeze({
          schemaVersion: RESPONSE_SCHEMA,
          requestId,
          outcome: "observed",
          allocation,
        }),
      );
    } catch {
      if (this.#withdrawn || this.#closed) return;
      await this.#publish(
        Object.freeze({
          schemaVersion: RESPONSE_SCHEMA,
          requestId,
          outcome: "unavailable",
          reasonCode,
        }),
      ).catch(() => {});
    }
  }

  #publish(response: DesktopNativeProjectWorkspaceResponse): Promise<void> {
    if (this.#withdrawn || this.#closed || !this.#control.connected)
      return Promise.resolve();
    this.#assertCurrent();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.withdraw();
          reject(
            new Error("desktop_native_project_workspace_send_unavailable"),
          );
        } else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error("deadline_exceeded")),
        this.#deadlineMs,
      );
      timer.unref();
      try {
        this.#send(response, (error: Error | null) => finish(error));
      } catch {
        finish(new Error("send_unavailable"));
      }
    });
  }
}

function dataProperty(input: unknown, key: string): unknown {
  return input !== null && typeof input === "object"
    ? Object.getOwnPropertyDescriptor(input, key)?.value
    : undefined;
}
function validRequestId(input: unknown): input is string {
  return (
    typeof input === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(input)
  );
}
function validTicketId(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.length === 64 &&
    /^[a-f0-9]{64}$/u.test(input)
  );
}
function unavailable(): never {
  throw new Error("desktop_native_project_workspace_bridge_unavailable");
}
