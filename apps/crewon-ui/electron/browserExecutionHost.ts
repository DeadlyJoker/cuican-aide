import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import {
  parseBrowserActInput,
  parseBrowserObserveInput,
  type BrowserActInput,
} from "@crewon/contracts";
import {
  validateToolExecutionCommand,
  validateToolExecutionPolicyMatchesIntent,
  type ToolExecutionCommand,
  type ToolExecutionResolution,
  type ToolExecutionPolicy,
} from "@crewon/tool-broker";
import type {
  BrowserExecutionAuthorizationRequest,
  BrowserExecutionAuthorizationState,
  BrowserGrantScope,
} from "../src/lib/browser-execution/browserExecutionGrant.ts";
import {
  assertBrowserGrantAllows,
  parseBrowserGrantScope,
  type BrowserRunIdentity,
} from "./browserExecutionGrants.ts";
import {
  BrowserViewAutomation,
  isBrowserAutomationInput,
} from "./browserExecutionPuppeteer.ts";
import { BrowserExecutionReceipts } from "./browserExecutionReceipts.ts";
import { BrowserExecutionDownloads } from "./browserExecutionDownload.ts";

export interface BrowserSessionAccess {
  getExecutionSession(
    sessionId?: string,
  ): {
    sessionId: string;
    webContents: WebContents;
    generation: number;
    mode: string;
  } | null;
  acquireExecution(input: {
    sessionId: string;
    ownerId: string;
    expectedGeneration: number;
  }): {
    leaseId: string;
    sessionId: string;
    generation: number;
    signal: AbortSignal;
  };
  releaseExecution(leaseId: string): void;
  revokeExecution(reason: string): void;
  subscribeExecutionRevoked?(listener: (reason: string) => void): () => void;
}
export interface BrowserExecutionAuthority {
  checkThread(threadId: string): Promise<void>;
  resolveRun(runId: string): Promise<BrowserRunIdentity>;
}
type Grant = BrowserExecutionAuthorizationState & {
  scope?: BrowserGrantScope;
  authorizedPageUrl: string;
  abort: AbortController;
};
type Observation = {
  observationId: string;
  generation: number;
  targets: { targetId: string; role: string; name: string }[];
};

const opaque = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value))
    throw new Error("browser_identity_invalid");
  return value;
};
export function browserHostPolicy(name: string): ToolExecutionPolicy {
  if (
    ![
      "crewon_browser_observe",
      "crewon_browser_act",
      "crewon_browser_act_scoped",
    ].includes(name)
  )
    throw new Error("browser_tool_unsupported");
  const observe = name === "crewon_browser_observe";
  return {
    effect: observe ? "readOnly" : "mutation",
    recovery: observe ? "replaySafe" : "reconcilable",
    resourceBindingId: "desktop-browser",
    credentialBindingId: null,
    executionTarget: { kind: "control", bindingId: "desktop-browser" },
    capability: observe
      ? "browser.observe.v1"
      : name.endsWith("_scoped")
        ? "browser.act.scoped.v1"
        : "browser.act.v1",
    approvalRequirement: name === "crewon_browser_act" ? "perAction" : "none",
    limits: {
      timeoutMs: 30000,
      maxOutputBytes: 9216,
      maxArtifactBytes: 10485760,
    },
  };
}
export class BrowserExecutionHost {
  readonly #automation = new Map<number, BrowserViewAutomation>();
  readonly #grants = new Map<string, Grant>();
  readonly #observations = new Map<string, Observation>();
  readonly #pending = new Map<
    string,
    {
      abort: AbortController;
      actionDigest: string;
      runId: string;
      promise: Promise<ToolExecutionResolution>;
    }
  >();
  readonly #receipts: BrowserExecutionReceipts;
  readonly #downloads: BrowserExecutionDownloads;
  readonly #unsubscribe: (() => void) | undefined;
  #revision = 0;
  #authorizationEpoch = 0;
  #closed = false;
  constructor(
    private readonly options: {
      sessions: BrowserSessionAccess;
      authority: BrowserExecutionAuthority;
      dataDirectory: string;
      inspectionBundle: string;
    },
  ) {
    this.#receipts = new BrowserExecutionReceipts(
      `${options.dataDirectory}/requests`,
    );
    this.#downloads = new BrowserExecutionDownloads(
      `${options.dataDirectory}/downloads`,
    );
    this.#unsubscribe = options.sessions.subscribeExecutionRevoked?.(
      (reason) => {
        if (reason !== "released") this.#observations.clear();
        if (!["page-generation-changed", "released"].includes(reason))
          for (const thread of [...this.#grants.keys()])
            this.revoke(thread, reason);
      },
    );
  }
  async authorize(
    input: BrowserExecutionAuthorizationRequest,
  ): Promise<BrowserExecutionAuthorizationState> {
    if (this.#closed) throw new Error("browser_host_closed");
    const epoch = this.#authorizationEpoch;
    const threadId = opaque(input.threadId);
    if (Object.keys(input).some((k) => !["threadId", "scope"].includes(k)))
      throw new Error("browser_authorization_invalid");
    await this.options.authority.checkThread(threadId);
    if (this.#closed || epoch !== this.#authorizationEpoch)
      throw new Error("browser_authorization_interrupted");
    const session = this.options.sessions.getExecutionSession();
    if (!session || session.mode !== "idle")
      throw new Error("browser_finish_recording_first");
    const scope =
      input.scope === undefined
        ? undefined
        : parseBrowserGrantScope(input.scope);
    for (const [thread, grant] of this.#grants)
      if (grant.sessionId === session.sessionId || thread === threadId)
        this.revoke(thread, "replaced");
    if (this.#grants.size >= 32) throw new Error("browser_grant_capacity");
    const grant: Grant = {
      threadId,
      sessionId: session.sessionId,
      revision: ++this.#revision,
      mode: scope ? "scoped" : "perAction",
      scope,
      authorizedPageUrl: session.webContents.getURL(),
      abort: new AbortController(),
    };
    this.#grants.set(threadId, grant);
    return this.status(threadId)!;
  }
  status(threadId: string): BrowserExecutionAuthorizationState | null {
    const grant = this.#grants.get(opaque(threadId));
    if (
      !grant ||
      grant.abort.signal.aborted ||
      !this.options.sessions.getExecutionSession(grant.sessionId)
    )
      return null;
    const { sessionId, revision, mode } = grant;
    return { threadId, sessionId, revision, mode };
  }
  revoke(threadId: string, reason = "user-takeover"): void {
    this.#authorizationEpoch++;
    const grant = this.#grants.get(opaque(threadId));
    if (!grant) return;
    this.#grants.delete(threadId);
    grant.abort.abort(reason);
    this.#observations.delete(grant.sessionId);
    this.options.sessions.revokeExecution(reason);
  }
  revokeAll(reason = "runtime-restarted"): void {
    this.#authorizationEpoch++;
    for (const id of [...this.#grants.keys()]) this.revoke(id, reason);
  }
  close(): void {
    this.#closed = true;
    this.#authorizationEpoch++;
    this.#unsubscribe?.();
    for (const id of [...this.#grants.keys()]) this.revoke(id, "host-closed");
    for (const automation of this.#automation.values()) void automation.close();
    this.#automation.clear();
  }
  validate(command: ToolExecutionCommand): void {
    validateToolExecutionCommand(command);
    validateToolExecutionPolicyMatchesIntent(
      browserHostPolicy(command.name),
      command.actionIntent,
    );
    if (command.kind !== "function")
      throw new Error("browser_tool_unsupported");
  }
  async #readIdentity(command: ToolExecutionCommand) {
    this.validate(command);
    const identity = await this.options.authority.resolveRun(command.runId);
    if (
      identity.runId !== command.runId ||
      identity.workspaceBindingId !== command.actionIntent.workspaceBindingId
    )
      throw new Error("browser_workspace_mismatch");
    return identity;
  }
  async #identity(command: ToolExecutionCommand, active: boolean) {
    this.validate(command);
    const identity = await this.options.authority.resolveRun(command.runId);
    if (
      identity.runId !== command.runId ||
      (active &&
        (!identity.active ||
          Date.parse(command.executionLease.expiresAt) <= Date.now()))
    )
      throw new Error("browser_run_inactive");
    // A null binding is the existing standalone desktop default; never invent a workspace ID.
    if (identity.workspaceBindingId !== command.actionIntent.workspaceBindingId)
      throw new Error("browser_workspace_mismatch");
    const grant = this.#grants.get(identity.threadId);
    if (!grant || grant.abort.signal.aborted)
      throw new Error("browser_authorization_required");
    const session = this.options.sessions.getExecutionSession(grant.sessionId);
    if (!session) {
      this.revoke(identity.threadId, "session-replaced");
      throw new Error("browser_session_unavailable");
    }
    if (!["idle", "executing"].includes(session.mode)) {
      this.revoke(identity.threadId, "recording-started");
      throw new Error("browser_finish_recording_first");
    }
    return { identity, grant, session };
  }
  async execute(
    command: ToolExecutionCommand,
  ): Promise<ToolExecutionResolution> {
    this.validate(command);
    const pending = this.#pending.get(command.executionId);
    const retained = this.#receipts.read(
      command.executionId,
      command.actionDigest,
      command.runId,
    );
    if (pending) {
      if (
        pending.actionDigest !== command.actionDigest ||
        pending.runId !== command.runId
      )
        throw new Error("browser_execution_identity_conflict");
      return pending.promise;
    }
    if (retained) {
      await this.#readIdentity(command);
      return retained;
    }
    const abort = new AbortController();
    const promise = this.#executeNew(command, abort);
    this.#pending.set(command.executionId, {
      abort,
      promise,
      actionDigest: command.actionDigest,
      runId: command.runId,
    });
    try {
      return await promise;
    } finally {
      this.#pending.delete(command.executionId);
    }
  }
  async #executeNew(
    command: ToolExecutionCommand,
    abort: AbortController,
  ): Promise<ToolExecutionResolution> {
    let lease: ReturnType<BrowserSessionAccess["acquireExecution"]> | null =
      null;
    let started = false;
    let effect = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    const identityKey = {
      executionId: command.executionId,
      actionDigest: command.actionDigest,
      runId: command.runId,
    };
    try {
      const { identity, grant, session } = await this.#identity(command, true);
      const input =
        command.name === "crewon_browser_observe"
          ? parseBrowserObserveInput(JSON.parse(command.input))
          : parseBrowserActInput(JSON.parse(command.input));
      if (
        input.sessionId !== undefined &&
        input.sessionId !== session.sessionId
      )
        throw new Error("browser_session_forbidden");
      const action = "action" in input ? (input as BrowserActInput) : null;
      const observation = this.#observations.get(session.sessionId);
      if (
        action &&
        (!observation ||
          observation.generation !== session.generation ||
          action.generation !== session.generation ||
          observation.observationId !== action.observationId)
      )
        throw new Error("browser_stale_observation");
      if (command.name === "crewon_browser_act_scoped") {
        if (!grant.scope || !action)
          throw new Error("requires_explicit_approval");
        const target =
          "target" in action
            ? observation!.targets.filter((t) =>
                "targetId" in action.target
                  ? t.targetId === action.target.targetId
                  : t.role === action.target.role &&
                    t.name === action.target.name,
              )
            : [];
        if ("target" in action && target.length !== 1)
          throw new Error("requires_explicit_approval");
        assertBrowserGrantAllows(
          grant.scope,
          identity,
          action,
          session.webContents.getURL(),
          target[0] ?? null,
          grant.authorizedPageUrl,
        );
      }
      lease = this.options.sessions.acquireExecution({
        sessionId: session.sessionId,
        ownerId: command.runId,
        expectedGeneration: session.generation,
      });
      const signal = AbortSignal.any([
        abort.signal,
        grant.abort.signal,
        AbortSignal.timeout(29000),
      ]);
      // Lease abortion on an expected navigation clears targets, while user takeover revokes the grant.
      const check = () => {
        if (signal.aborted) throw new Error("browser_execution_canceled");
      };
      check();
      if (lease.signal.aborted) throw new Error("browser_lease_revoked");
      const reserved = this.#receipts.begin(identityKey);
      if (!reserved.created) return reserved.resolution!;
      started = true;
      let checking = false;
      poll = setInterval(() => {
        if (checking) return;
        checking = true;
        void this.#identity(command, true)
          .then(
            (current) => {
              if (
                current.grant !== grant ||
                JSON.stringify(current.identity.skill) !==
                  JSON.stringify(identity.skill)
              )
                abort.abort("run-authority-changed");
            },
            () => abort.abort("authority-unavailable"),
          )
          .finally(() => {
            checking = false;
          });
      }, 500);
      let automation = this.#automation.get(session.webContents.id);
      if (!automation) {
        for (const previous of this.#automation.values())
          await previous.close();
        this.#automation.clear();
        automation = new BrowserViewAutomation(
          session.webContents,
          this.options.inspectionBundle,
          (reason) => this.revoke(identity.threadId, reason),
        );
        this.#automation.set(session.webContents.id, automation);
      }
      const nativeInput = () => {
        if (!isBrowserAutomationInput(session.webContents))
          this.revoke(identity.threadId, "user-takeover");
      };
      session.webContents.on("before-input-event", nativeInput);
      session.webContents.on("before-mouse-event", nativeInput);
      const onAbort = () => session.webContents.stop();
      signal.addEventListener("abort", onAbort, { once: true });
      let output: unknown;
      try {
        check();
        if (!action) {
          const observationId = randomUUID();
          output = await automation.observe();
          check();
          const current = this.options.sessions.getExecutionSession(
            session.sessionId,
          );
          if (!current || current.generation !== session.generation)
            throw new Error("browser_stale_observation");
          this.#observations.set(session.sessionId, {
            observationId,
            generation: session.generation,
            targets: (output as Observation).targets,
          });
          output = {
            schemaVersion: "crewon.browser-observation.v1",
            sessionId: session.sessionId,
            generation: session.generation,
            observationId,
            ...(output as object),
          };
        } else {
          const perform = async () => {
            check();
            if (lease!.signal.aborted) throw new Error("browser_lease_revoked");
            if (action.action === "navigate")
              throw new Error("browser_action_invalid");
            const target = observation!.targets.filter((t) =>
              "targetId" in action.target
                ? t.targetId === action.target.targetId
                : t.role === action.target.role &&
                  t.name === action.target.name,
            );
            if (target.length !== 1)
              throw new Error("browser_target_ambiguous");
            return automation!.act(action, target[0]!.targetId, signal, () => {
              check();
              if (lease!.signal.aborted)
                throw new Error("browser_lease_revoked");
              effect = true;
            });
          };
          if (action.action === "navigate") {
            effect = true;
            this.#observations.delete(session.sessionId);
            await session.webContents.loadURL(action.url);
            output = {
              status: "completed",
              sessionId: session.sessionId,
              generation: this.options.sessions.getExecutionSession(
                session.sessionId,
              )?.generation,
            };
          } else if (action.action === "download")
            output = {
              downloadReceipt: await this.#downloads.capture(
                session.webContents,
                command,
                signal,
                perform,
              ),
            };
          else {
            await perform();
            output = { status: "completed", sessionId: session.sessionId };
          }
          this.#observations.delete(session.sessionId);
          check();
        }
      } finally {
        session.webContents.removeListener("before-input-event", nativeInput);
        session.webContents.removeListener("before-mouse-event", nativeInput);
        signal.removeEventListener("abort", onAbort);
      }
      const encoded = JSON.stringify(output);
      if (Buffer.byteLength(encoded) > 9216)
        throw new Error("browser_output_limit");
      const resolution = this.#completed(command, encoded, false);
      this.#receipts.complete(identityKey, resolution);
      return resolution;
    } catch (error) {
      const resolution: ToolExecutionResolution = effect
        ? {
            status: "unknownOutcome",
            executionId: command.executionId,
            providerReceiptId: null,
          }
        : this.#completed(
            command,
            JSON.stringify({
              code:
                error instanceof Error && /^[a-z_]+$/.test(error.message)
                  ? error.message
                  : "browser_execution_failed",
            }),
            true,
          );
      if (started) this.#receipts.complete(identityKey, resolution);
      return resolution;
    } finally {
      if (poll) clearInterval(poll);
      if (lease) this.options.sessions.releaseExecution(lease.leaseId);
    }
  }
  async reconcile(
    command: ToolExecutionCommand,
  ): Promise<ToolExecutionResolution> {
    await this.#readIdentity(command);
    return (
      this.#receipts.read(
        command.executionId,
        command.actionDigest,
        command.runId,
      ) ?? {
        status: "unknownOutcome",
        executionId: command.executionId,
        providerReceiptId: null,
      }
    );
  }
  async cancel(
    command: ToolExecutionCommand,
  ): Promise<ToolExecutionResolution> {
    this.validate(command);
    this.#receipts.read(
      command.executionId,
      command.actionDigest,
      command.runId,
    );
    const pending = this.#pending.get(command.executionId);
    if (
      pending &&
      (pending.actionDigest !== command.actionDigest ||
        pending.runId !== command.runId)
    )
      throw new Error("browser_execution_identity_conflict");
    pending?.abort.abort("run-canceled");
    // Cancellation cannot prove an already dispatched effect did not happen.
    return (
      this.#receipts.read(
        command.executionId,
        command.actionDigest,
        command.runId,
      ) ?? {
        status: "canceled",
        executionId: command.executionId,
        providerReceiptId: null,
      }
    );
  }
  async download(
    command: ToolExecutionCommand,
    receiptId: string,
  ): Promise<Uint8Array> {
    await this.#readIdentity(command);
    return this.#downloads.read(receiptId, command);
  }

  #completed(
    command: ToolExecutionCommand,
    output: string,
    isError: boolean,
  ): ToolExecutionResolution {
    return {
      status: "completed",
      executionId: command.executionId,
      providerReceiptId: `browser:${command.executionId}`,
      result: {
        schemaVersion: "crewon.tool-result.v0",
        callId: command.callId,
        output,
        isError,
        artifactRef: null,
      },
    };
  }
}
