import { createHash } from "node:crypto";

import {
  BROWSER_ACT_SCOPED_TOOL_NAME,
  BROWSER_ACT_TOOL_NAME,
  BROWSER_MAX_ARTIFACT_BYTES,
  BROWSER_MAX_OUTPUT_BYTES,
  BROWSER_OBSERVE_TOOL_NAME,
  BROWSER_TIMEOUT_MS,
  ContractValidationError,
  parseBrowserActInput,
  parseBrowserObserveInput,
  type BrowserActInput,
  type BrowserObserveInput,
} from "@crewon/contracts";
import {
  ToolBrokerError,
  validateToolExecutionCommand,
  validateToolExecutionPolicyMatchesIntent,
  type ToolCallKind,
  type ToolDefinition,
  type ToolExecutionCommand,
  type ToolExecutionPolicy,
  type ToolExecutionResolution,
  type ToolJsonValue,
  type ToolRuntimePort,
} from "@crewon/tool-broker";

export type BrowserDownloadImporter = (
  input: Readonly<{
    runId: string;
    executionId: string;
    name: string;
    mediaType: string;
    content: Uint8Array;
  }>,
) => Promise<unknown>;

export type BrowserExecutionRuntimeOptions = Readonly<{
  importDownloadedFile?: BrowserDownloadImporter;
}>;

type Operation = "execute" | "reconcile" | "cancel";
type DownloadReceipt = Readonly<{
  receiptId: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
}>;
const MAX_RESPONSE_BYTES = 64 * 1024;
const XLSX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function createConfiguredBrowserExecutionToolRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options: BrowserExecutionRuntimeOptions = {},
): BrowserExecutionToolRuntime | undefined {
  const url = environment.CREWON_BROWSER_BRIDGE_URL;
  const token = environment.CREWON_BROWSER_BRIDGE_TOKEN;
  if (url === undefined && token === undefined) return undefined;
  if (url === undefined || token === undefined)
    throw new ToolBrokerError("browser_bridge_config_incomplete");
  return new BrowserExecutionToolRuntime({ url, token, ...options });
}

/** Adapts the existing durable Tool command to one authenticated local Electron host. */
export class BrowserExecutionToolRuntime implements ToolRuntimePort {
  readonly #url: string;
  readonly #token: string;
  #importDownloadedFile: BrowserDownloadImporter | undefined;

  constructor(
    config: { url: string; token: string } & BrowserExecutionRuntimeOptions,
  ) {
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/u.test(config.url))
      throw new ToolBrokerError("browser_bridge_url_invalid");
    const url = new URL(config.url);
    if (Number(url.port || 80) > 65535)
      throw new ToolBrokerError("browser_bridge_url_invalid");
    if (!/^[a-f0-9]{64}$/u.test(config.token))
      throw new ToolBrokerError("browser_bridge_token_invalid");
    this.#url = url.origin;
    this.#token = config.token;
    this.#importDownloadedFile = config.importDownloadedFile;
  }

  setDownloadImporter(importer: BrowserDownloadImporter): void {
    this.#importDownloadedFile = importer;
  }

  definitions(): readonly ToolDefinition[] {
    return browserExecutionToolDefinitions();
  }
  executionPolicy(
    kind: ToolCallKind,
    name: string,
  ): ToolExecutionPolicy | null {
    return browserExecutionPolicy(kind, name);
  }
  execute(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    return this.#invoke("execute", command, signal);
  }
  reconcile(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    return this.#invoke("reconcile", command, signal);
  }
  cancel(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    return this.#invoke("cancel", command, signal);
  }

  async #invoke(
    operation: Operation,
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    validateToolExecutionCommand(command);
    const policy = browserExecutionPolicy(command.kind, command.name);
    if (policy === null) throw new ToolBrokerError("browser_tool_unavailable");
    validateToolExecutionPolicyMatchesIntent(policy, command.actionIntent);
    signal.throwIfAborted();
    const remainingLeaseMs =
      Date.parse(command.executionLease.expiresAt) - Date.now();
    if (operation === "execute" && remainingLeaseMs <= 0)
      throw new ToolBrokerError("browser_execution_lease_expired");
    let input: BrowserObserveInput | BrowserActInput;
    try {
      const value: unknown = JSON.parse(command.input);
      input =
        command.name === BROWSER_OBSERVE_TOOL_NAME
          ? parseBrowserObserveInput(value)
          : parseBrowserActInput(value);
    } catch (error) {
      if (
        !(
          error instanceof SyntaxError ||
          error instanceof ContractValidationError
        )
      )
        throw error;
      // This command never reached the host. Settle deterministically so the
      // model can repair its arguments, including after an uncommitted result.
      return rejectedInput(command);
    }
    const download = "action" in input && input.action === "download";
    if (
      download &&
      operation !== "cancel" &&
      this.#importDownloadedFile === undefined
    )
      throw new ToolBrokerError("browser_download_import_unavailable");
    const timeout = AbortSignal.timeout(
      operation === "execute"
        ? Math.min(BROWSER_TIMEOUT_MS, Math.max(1, remainingLeaseMs))
        : BROWSER_TIMEOUT_MS,
    );
    const requestSignal = AbortSignal.any([signal, timeout]);
    try {
      const response = await this.#post(operation, { command }, requestSignal);
      const resolution = parseResolution(
        parseJson(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await readBounded(response, MAX_RESPONSE_BYTES, "application/json"),
          ),
        ),
        command,
      );
      requestSignal.throwIfAborted();
      if (
        download &&
        operation !== "cancel" &&
        resolution.status === "completed" &&
        !resolution.result.isError
      ) {
        return await this.#importDownload(command, resolution, requestSignal);
      }
      return resolution;
    } catch {
      // A disconnected request may have taken effect. No retry of execute is safe here.
      if (operation === "execute" && requestSignal.aborted) {
        try {
          const response = await this.#post(
            "cancel",
            { command },
            AbortSignal.timeout(1000),
          );
          await response.body?.cancel();
        } catch {
          /* The host still enforces the command deadline and its durable fence. */
        }
      }
      return unknownOutcome(command);
    }
  }

  async #post(
    operation: Operation | "download",
    payload: unknown,
    signal: AbortSignal,
  ): Promise<Response> {
    const response = await fetch(`${this.#url}/v1/browser/${operation}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${this.#token}`,
      },
      body: JSON.stringify(payload),
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ToolBrokerError("browser_bridge_request_failed");
    }
    return response;
  }

  async #importDownload(
    command: ToolExecutionCommand,
    resolution: Extract<ToolExecutionResolution, { status: "completed" }>,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution> {
    const envelope = record(parseJson(resolution.result.output));
    exactKeys(envelope, ["downloadReceipt"]);
    const receipt = parseDownloadReceipt(envelope.downloadReceipt);
    const response = await this.#post(
      "download",
      { command, receiptId: receipt.receiptId },
      signal,
    );
    const content = await readBounded(
      response,
      BROWSER_MAX_ARTIFACT_BYTES,
      "application/octet-stream",
    );
    if (
      content.byteLength !== receipt.sizeBytes ||
      sha256(content) !== receipt.sha256
    )
      throw new ToolBrokerError("browser_download_integrity_invalid");
    signal.throwIfAborted();
    const importer = this.#importDownloadedFile;
    if (importer === undefined)
      throw new ToolBrokerError("browser_download_import_unavailable");
    const imported = record(
      await withinSignal(
        importer({
          runId: command.runId,
          executionId: command.executionId,
          name: receipt.name,
          mediaType: receipt.mediaType,
          content,
        }),
        signal,
      ),
    );
    signal.throwIfAborted();
    const file = projectImportedFile(imported, receipt, command.runId);
    const output = JSON.stringify({ status: "completed", file });
    if (Buffer.byteLength(output, "utf8") > BROWSER_MAX_OUTPUT_BYTES)
      throw new ToolBrokerError("browser_download_result_too_large");
    return {
      ...resolution,
      result: { ...resolution.result, output, artifactRef: null },
    };
  }
}

export function browserExecutionPolicy(
  kind: ToolCallKind,
  name: string,
): ToolExecutionPolicy | null {
  if (
    kind !== "function" ||
    ![
      BROWSER_OBSERVE_TOOL_NAME,
      BROWSER_ACT_TOOL_NAME,
      BROWSER_ACT_SCOPED_TOOL_NAME,
    ].some((tool) => tool === name)
  )
    return null;
  const observe = name === BROWSER_OBSERVE_TOOL_NAME;
  return {
    effect: observe ? "readOnly" : "mutation",
    recovery: observe ? "replaySafe" : "reconcilable",
    resourceBindingId: "desktop-browser",
    credentialBindingId: null,
    executionTarget: { kind: "control", bindingId: "desktop-browser" },
    capability: observe
      ? "browser.observe.v1"
      : name === BROWSER_ACT_SCOPED_TOOL_NAME
        ? "browser.act.scoped.v1"
        : "browser.act.v1",
    approvalRequirement: name === BROWSER_ACT_TOOL_NAME ? "perAction" : "none",
    limits: {
      timeoutMs: BROWSER_TIMEOUT_MS,
      maxOutputBytes: BROWSER_MAX_OUTPUT_BYTES,
      maxArtifactBytes: BROWSER_MAX_ARTIFACT_BYTES,
    },
  };
}

export function browserExecutionToolDefinitions(): readonly ToolDefinition[] {
  const target: ToolJsonValue = {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          targetId: { type: "string", minLength: 1, maxLength: 128 },
        },
        required: ["targetId"],
      },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          role: { type: "string", minLength: 1, maxLength: 32 },
          name: { type: "string", minLength: 1, maxLength: 256 },
        },
        required: ["role", "name"],
      },
    ],
  };
  const actSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 1, maxLength: 128 },
      generation: { type: "integer", minimum: 0 },
      observationId: { type: "string", minLength: 1, maxLength: 128 },
      action: {
        type: "string",
        enum: ["navigate", "click", "fill", "select", "download"],
      },
      target,
      url: { type: "string", maxLength: 2048 },
      value: { type: "string", maxLength: 512 },
    },
    required: ["sessionId", "generation", "observationId", "action"],
  };
  return [
    {
      schemaVersion: "crewon.tool-definition.v0",
      kind: "function",
      name: BROWSER_OBSERVE_TOOL_NAME,
      description:
        "Observe the browser page authorized for this Run. Omit sessionId to discover the bound session; never pass an empty string. Returns bounded standard-control targets and ordinary control values; sensitive fields, sensitive values, and page secrets are excluded.",
      execution: "serial",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sessionId: { type: "string", minLength: 1, maxLength: 128 },
        },
        required: [],
      },
    },
    {
      schemaVersion: "crewon.tool-definition.v0",
      kind: "function",
      name: BROWSER_ACT_TOOL_NAME,
      description:
        "Perform one approved browser action using a current observation. navigate requires url and no target/value; click/download require target; fill/select require target and value. Download imports the real file into this Run's file inputs. Never retry an unknown outcome.",
      execution: "serial",
      inputSchema: actSchema,
    },
    {
      schemaVersion: "crewon.tool-definition.v0",
      kind: "function",
      name: BROWSER_ACT_SCOPED_TOOL_NAME,
      description:
        "Perform one browser action only within an explicit host grant for this Run, fixed Skill version, session, origin, and action target. The host rejects actions outside the grant. Uses the same inputs as crewon_browser_act. Never retry an unknown outcome.",
      execution: "serial",
      inputSchema: structuredClone(actSchema),
    },
  ];
}

function parseResolution(
  input: unknown,
  command: ToolExecutionCommand,
): ToolExecutionResolution {
  const value = record(input);
  if (value.executionId !== command.executionId) invalidResult();
  if (value.status === "canceled" || value.status === "unknownOutcome") {
    exactKeys(value, ["status", "executionId", "providerReceiptId"]);
    if (value.providerReceiptId !== null) opaque(value.providerReceiptId);
  } else {
    exactKeys(value, ["status", "executionId", "providerReceiptId", "result"]);
    if (value.status !== "completed") invalidResult();
    opaque(value.providerReceiptId);
    const result = record(value.result);
    exactKeys(result, [
      "schemaVersion",
      "callId",
      "output",
      "isError",
      "artifactRef",
    ]);
    if (
      result.schemaVersion !== "crewon.tool-result.v0" ||
      result.callId !== command.callId ||
      typeof result.output !== "string" ||
      Buffer.byteLength(result.output, "utf8") > BROWSER_MAX_OUTPUT_BYTES ||
      typeof result.isError !== "boolean"
    )
      invalidResult();
    if (result.artifactRef !== null) opaque(result.artifactRef);
  }
  return structuredClone(value) as ToolExecutionResolution;
}
function parseDownloadReceipt(input: unknown): DownloadReceipt {
  const value = record(input);
  exactKeys(value, ["receiptId", "name", "mediaType", "sizeBytes", "sha256"]);
  opaque(value.receiptId);
  if (
    typeof value.name !== "string" ||
    value.name.length < 1 ||
    value.name.length > 255 ||
    /[\/\\\u0000-\u001f\u007f]/u.test(value.name) ||
    value.name === "." ||
    value.name === ".."
  )
    invalidResult();
  if (value.mediaType !== "text/csv" && value.mediaType !== XLSX_MEDIA_TYPE)
    invalidResult();
  if (
    !Number.isSafeInteger(value.sizeBytes) ||
    Number(value.sizeBytes) < 1 ||
    Number(value.sizeBytes) > BROWSER_MAX_ARTIFACT_BYTES
  )
    invalidResult();
  if (
    typeof value.sha256 !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.sha256)
  )
    invalidResult();
  return value as DownloadReceipt;
}
function projectImportedFile(
  value: Record<string, unknown>,
  receipt: DownloadReceipt,
  runId: string,
) {
  opaque(value.inputId);
  if (
    value.sourceRunId !== runId ||
    value.name !== receipt.name ||
    value.mediaType !== receipt.mediaType ||
    value.byteLength !== receipt.sizeBytes ||
    value.contentDigest !== receipt.sha256
  )
    invalidResult();
  return {
    inputId: value.inputId,
    name: value.name,
    mediaType: value.mediaType,
    byteLength: value.byteLength,
    contentDigest: value.contentDigest,
    sourceRunId: value.sourceRunId,
  };
}
async function readBounded(
  response: Response,
  limit: number,
  mediaType: string,
): Promise<Uint8Array> {
  if (
    response.headers.get("content-type")?.split(";")[0]?.trim() !== mediaType ||
    Number(response.headers.get("content-length")) > limit ||
    response.body === null
  ) {
    await response.body?.cancel();
    invalidResult();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) invalidResult();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
function parseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    throw new ToolBrokerError("browser_bridge_json_invalid");
  }
}
function record(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    invalidResult();
  return input as Record<string, unknown>;
}
function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(","))
    invalidResult();
}
function opaque(value: unknown): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  )
    invalidResult();
}
function invalidResult(): never {
  throw new ToolBrokerError("browser_bridge_result_invalid");
}
function rejectedInput(command: ToolExecutionCommand): ToolExecutionResolution {
  return {
    status: "completed",
    executionId: command.executionId,
    providerReceiptId: `browser-input:${createHash("sha256").update(command.executionId).digest("hex")}`,
    result: {
      schemaVersion: "crewon.tool-result.v0",
      callId: command.callId,
      isError: true,
      artifactRef: null,
      output: JSON.stringify({
        status: "rejected",
        code: "browser_execution_input_invalid",
        message:
          command.name === BROWSER_OBSERVE_TOOL_NAME
            ? "Omit sessionId to discover the authorized session; never pass an empty string. Otherwise provide a nonempty sessionId from a prior observation. No other fields are accepted. No browser action was dispatched."
            : "Use nonempty sessionId and observationId from a current observation, a nonnegative integer generation, and one supported action. navigate requires url without target/value; other actions require target, and fill/select also require value. No browser action was dispatched.",
      }),
    },
  };
}
function unknownOutcome(
  command: ToolExecutionCommand,
): ToolExecutionResolution {
  return {
    status: "unknownOutcome",
    executionId: command.executionId,
    providerReceiptId: null,
  };
}
function sha256(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/** A committed import is reconciled by F01's execution key; cancellation never retries it here. */
async function withinSignal<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let reject!: (reason: unknown) => void;
  const promise = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await Promise.race([pending, promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
