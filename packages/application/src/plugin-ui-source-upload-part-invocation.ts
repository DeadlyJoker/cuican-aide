import {
  parseProjectSourceUploadPartLocator,
  parseProjectSourceUploadPartResponse,
  type ProjectSourceUploadMutationResponse,
  type ProjectSourceUploadPartLocator,
} from "@crewon/contracts/project-source-uploads";
import { ApplicationError } from "./application-error.ts";
import {
  PluginProjectSourceUploadActionOwner,
  isPluginProjectSourceUploadActionOwner,
} from "./plugin-project-source-upload-action-owner.ts";
import { registerPluginUiInvocation } from "./plugin-ui-invocation-authority.ts";
import { registerPluginProjectSourceUploadRawInvocation } from "./plugin-project-source-upload-invocation.ts";
import {
  uiActor,
  uiInput,
  uiOperation,
  uiRecord,
  uiRef,
} from "./plugin-ui-application-support.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { PluginUiMountBinding } from "./plugin-ui-mount-lifecycle.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";

export type InvokePluginUiSourceUploadPartCommand = Readonly<{
  mountRef: string;
  locator: ProjectSourceUploadPartLocator;
}>;
export type InvokePluginUiSourceUploadPartOptions = Readonly<{
  signal?: AbortSignal;
}>;

/** Capture genuine frozen owner methods; duck-typed implementations cannot issue committed facts. */
export function capturePluginUiSourceUploadOwner(input: unknown) {
  if (input === undefined) return undefined;
  if (!isPluginProjectSourceUploadActionOwner(input))
    throw new ApplicationError(
      "internal",
      "plugin_project_source_upload_owner_invalid",
    );
  const proto = PluginProjectSourceUploadActionOwner.prototype;
  return Object.freeze({
    capturePartBytes: proto.capturePartBytes.bind(input),
    writePart: proto.writePart.bind(input),
    committedMetadata: input.committedMetadata,
  });
}
type Dependencies = Readonly<{
  owner: ReturnType<typeof capturePluginUiSourceUploadOwner>;
  binding(actor: ActorContext, mountRef: string): PluginUiMountBinding;
  assertCurrent(
    actor: ActorContext,
    binding: PluginUiMountBinding,
  ): Promise<void>;
  assertTransactionCurrent(
    actor: ActorContext,
    binding: PluginUiMountBinding,
  ): Promise<void>;
  assertActive(binding: PluginUiMountBinding): void;
}>;
const signalAborted = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)!.get!;
const signalThrowIfAborted = AbortSignal.prototype.throwIfAborted;
const byteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)!.get!;
function signalCheck(
  input: InvokePluginUiSourceUploadPartOptions | undefined,
): () => void {
  if (input === undefined) return () => {};
  const hasSignal =
    input !== null &&
    typeof input === "object" &&
    Object.hasOwn(input, "signal");
  const value = uiInput(() => uiRecord(input, hasSignal ? ["signal"] : []));
  const signal = value.signal;
  if (signal === undefined) return () => {};
  uiInput(() => signalAborted.call(signal));
  return () => {
    try {
      signalThrowIfAborted.call(signal);
    } catch (cause) {
      throw new ApplicationError(
        "conflict",
        "plugin_project_source_upload_aborted",
        { cause },
      );
    }
  };
}

/** Dedicated raw lifecycle. Bytes never enter JSON invoke, recovery staging, or task admission. */
export function invokePluginUiSourceUploadPart(
  actorInput: ActorContext,
  input: InvokePluginUiSourceUploadPartCommand,
  rawBytes: Uint8Array,
  options: InvokePluginUiSourceUploadPartOptions | undefined,
  dependencies: Dependencies,
): Promise<ProjectSourceUploadMutationResponse> {
  return uiOperation(async () => {
    const actor = uiActor(actorInput);
    const command = uiInput(() => {
      const v = uiRecord(input, ["mountRef", "locator"]);
      return Object.freeze({
        mountRef: uiRef(v.mountRef),
        locator: parseProjectSourceUploadPartLocator(v.locator),
      });
    });
    const owner = dependencies.owner;
    if (owner === undefined)
      throw new ApplicationError(
        "authorization",
        "plugin_project_source_upload_raw_unavailable",
      );
    const checkSignal = signalCheck(options);
    checkSignal();
    // Synchronous independent snapshot, before the first policy/SQL await.
    const bytes = owner.capturePartBytes(rawBytes);
    const length = byteLength.call(bytes) as number;
    const binding = dependencies.binding(actor, command.mountRef);
    const assertActive = () => {
      checkSignal();
      dependencies.assertActive(binding);
    };
    const assertCurrent = async () => {
      assertActive();
      await dependencies.assertCurrent(actor, binding);
      assertActive();
    };
    const assertTransactionCurrent = async () => {
      assertActive();
      await dependencies.assertTransactionCurrent(actor, binding);
      assertActive();
    };
    await assertCurrent();
    const context: PluginUiActionContext = Object.freeze({
      ...binding.context,
      lease: binding.lease,
      authorityEpoch: binding.authorityEpoch,
      action: "crewon.project-source-uploads.v1.writePart",
      input: command.locator,
    });
    const unregister = registerPluginUiInvocation(
      context,
      assertCurrent,
      assertActive,
    );
    let unregisterRaw: (() => void) | undefined;
    try {
      unregisterRaw = registerPluginProjectSourceUploadRawInvocation(
        context,
        assertTransactionCurrent,
      );
      const outcome = await owner.writePart(context, bytes);
      if (!owner.committedMetadata.isOutcome(outcome))
        throw new ApplicationError(
          "internal",
          "plugin_ui_committed_metadata_invalid",
        );
      // COMMIT is already confirmed. Verification checks identity/shape only, with no late signal/PDP fence.
      return parseProjectSourceUploadPartResponse(
        owner.committedMetadata.verify(context, outcome),
        command.locator,
        length,
      );
    } finally {
      unregisterRaw?.();
      unregister();
    }
  });
}
