import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ControlApiClient } from "@crewon/control-client";
import {
  parsePluginControlIdempotencyKey,
  parsePluginControlPluginId,
  parseSelectPluginPackageRequest,
  type PluginSelectionResponse,
  type PluginSelectionView,
  type SelectPluginPackageRequest,
} from "@crewon/contracts";
import {
  extensionCanonicalJson,
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  type ExtensionConfiguration,
  type ExtensionExecutionTarget,
} from "@crewon/domain";
import type {
  DesktopInstalledPluginExpectedCatalogEntry,
  DesktopInstalledPluginRuntime,
} from "./desktopInstalledPluginRuntime.ts";
import type { AutomaticDesktopInstalledPluginRuntime } from "./desktopAutomaticInstalledPluginRuntime.ts";

export type DesktopPluginSelectionCommand = Readonly<{
  pluginId: string;
  request: SelectPluginPackageRequest;
  idempotencyKey: string;
}>;
type PackageIdentity = Readonly<{
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
}>;
type Entry = Readonly<{
  identity: DesktopInstalledPluginExpectedCatalogEntry["identity"];
  configuration: ExtensionConfiguration;
  configuredTarget: ExtensionExecutionTarget;
}>;
type Binding = Readonly<{
  entries: readonly Entry[];
  approvedPluginIds: ReadonlySet<string>;
  assertCurrent(): void;
  queues: Map<string, Promise<unknown>>;
  budget: { pending: number };
}>;
const nativeBindings = new WeakMap<DesktopInstalledPluginRuntime, Binding>();
const nativePreparations = new WeakMap<
  AutomaticDesktopInstalledPluginRuntime,
  Readonly<{ approvedPluginIds: ReadonlySet<string>; assertCurrent(): void }>
>();

/** Retains genuine Native mode even when no approved capability produced a usable release. */
export function bindDesktopNativePluginPreparationBusinessActivation(
  owner: AutomaticDesktopInstalledPluginRuntime,
  approvedPackages: readonly PackageIdentity[],
): void {
  owner.assertCurrent();
  if (nativePreparations.has(owner)) fail("binding_exists");
  nativePreparations.set(
    owner,
    Object.freeze({
      approvedPluginIds: new Set(approvedPackages.map((item) => item.pluginId)),
      assertCurrent: owner.assertCurrent.bind(owner),
    }),
  );
}

/** Called only by the real Native Main issuer after its private policy and release are pinned. */
export function bindDesktopNativePluginBusinessActivation(
  runtime: DesktopInstalledPluginRuntime,
  approvedPackages: readonly PackageIdentity[],
): void {
  runtime.assertCurrent();
  if (nativeBindings.has(runtime)) fail("binding_exists");
  const entries = Object.freeze(
    runtime.expectedCatalogEntries.map((entry) =>
      Object.freeze({
        identity: Object.freeze({ ...entry.identity }),
        configuration: parseExtensionConfiguration(entry.configuration, {
          sha256: (value) =>
            `sha256:${createHash("sha256").update(value).digest("hex")}`,
        }),
        configuredTarget: parseExtensionExecutionTarget(entry.configuredTarget),
      }),
    ),
  );
  if (
    entries.some(
      (entry) =>
        !approvedPackages.some((approved) =>
          (
            ["pluginId", "publisherId", "version", "packageDigest"] as const
          ).every((key) => entry.identity[key] === approved[key]),
        ),
    )
  )
    fail("publication_unapproved");
  nativeBindings.set(
    runtime,
    Object.freeze({
      entries,
      approvedPluginIds: new Set(approvedPackages.map((item) => item.pluginId)),
      assertCurrent: runtime.assertCurrent.bind(runtime),
      queues: new Map(),
      budget: { pending: 0 },
    }),
  );
}

export function parseDesktopPluginSelectionCommand(
  input: unknown,
): DesktopPluginSelectionCommand {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    fail("command_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Object.getOwnPropertySymbols(input).length !== 0 ||
    Object.keys(descriptors).sort().join("\0") !==
      ["idempotencyKey", "pluginId", "request"].join("\0") ||
    Object.values(descriptors).some(
      (entry) => !("value" in entry) || !entry.enumerable,
    )
  )
    fail("command_invalid");
  return Object.freeze({
    pluginId: parsePluginControlPluginId(descriptors.pluginId!.value),
    request: parseSelectPluginPackageRequest(descriptors.request!.value),
    idempotencyKey: parsePluginControlIdempotencyKey(
      descriptors.idempotencyKey!.value,
    ),
  });
}

/** The original selection response is returned only after this Native business capability is reconciled. */
export async function setDesktopPluginSelectionWithNativeBusinessActivation(
  input: Readonly<{
    runtime: DesktopInstalledPluginRuntime | null;
    nativePreparation?: AutomaticDesktopInstalledPluginRuntime | null;
    client: ControlApiClient;
    command: DesktopPluginSelectionCommand;
    signal: AbortSignal;
  }>,
): Promise<PluginSelectionResponse> {
  const command = parseDesktopPluginSelectionCommand(input.command);
  const binding =
    input.runtime === null ? undefined : nativeBindings.get(input.runtime);
  const entry = binding?.entries.find(
    (value) => value.identity.pluginId === command.pluginId,
  );
  const select = () =>
    input.client.plugins.setSelection(
      command.pluginId,
      command.request,
      command.idempotencyKey,
      { signal: input.signal },
    );
  const preparation =
    input.nativePreparation == null
      ? undefined
      : nativePreparations.get(input.nativePreparation);
  if (
    binding === undefined &&
    preparation?.approvedPluginIds.has(command.pluginId)
  ) {
    input.signal.throwIfAborted();
    preparation.assertCurrent();
    if (command.request.state === "enabled") fail("runtime_unprepared");
    const result = await select();
    input.signal.throwIfAborted();
    preparation.assertCurrent();
    return result;
  }
  // Pure UI packages and the established remote runtime keep their original selection behavior.
  if (binding === undefined || !binding.approvedPluginIds.has(command.pluginId))
    return select();
  if (entry === undefined) {
    if (command.request.state === "enabled") fail("runtime_unprepared");
    // A broken execution candidate must remain removable through the original real selection API.
    return serialized(binding, command.pluginId, async () => {
      active(binding, input.signal);
      const result = await select();
      active(binding, input.signal);
      return result;
    });
  }
  return serialized(binding, command.pluginId, async () => {
    active(binding, input.signal);
    // A replacement is selected while disabled, then prepared with its own
    // configuration. The old pinned release must never activate the new digest.
    const replacingDisabledPackage =
      command.request.state === "disabled" &&
      command.request.selectedPackageDigest !== entry.identity.packageDigest;
    const assertInactive = async () => {
      const { activation } = await input.client.getExtensionActivation(
        command.pluginId,
        { signal: input.signal },
      );
      active(binding, input.signal);
      if (activation?.state === "enabled")
        fail("version_change_requires_disable");
    };
    if (replacingDisabledPackage) {
      const current = await input.client.plugins.getSelection(
        command.pluginId,
        {
          signal: input.signal,
        },
      );
      active(binding, input.signal);
      if (current.selection?.state !== "disabled")
        fail("version_change_requires_disable");
      await assertInactive();
    }
    const result = await select();
    active(binding, input.signal);
    try {
      if (replacingDisabledPackage) {
        await assertInactive();
        const current = await input.client.plugins.getSelection(
          command.pluginId,
          {
            signal: input.signal,
          },
        );
        active(binding, input.signal);
        if (!isDeepStrictEqual(current.selection, result.mutation.selection))
          fail("selection_changed");
      } else if (result.mutation.selection.state !== "uninstalled")
        await reconcile({
          binding,
          entry,
          client: input.client,
          selection: result.mutation.selection,
          signal: input.signal,
          reason: "selection",
        });
      active(binding, input.signal);
      return result;
    } catch (cause) {
      // Selection may already be durable. The renderer retains this exact request/key for retry.
      // Do not manufacture a projection acknowledgement or rewrite the saved selection.
      throw new Error("desktop_native_plugin_business_activation_failed", {
        cause,
      });
    }
  });
}

/** Restores only currently enabled package selections; business disable/revocation remains explicit. */
export async function restoreDesktopNativePluginBusinessActivations(
  input: Readonly<{
    runtime: DesktopInstalledPluginRuntime;
    client: ControlApiClient;
    signal: AbortSignal;
  }>,
): Promise<readonly Readonly<{ pluginId: string; reasonCode: string }>[]> {
  const binding = nativeBindings.get(input.runtime);
  if (binding === undefined) return [];
  active(binding, input.signal);
  // Native preparation validates the first sibling as the plugin's prepared
  // default. Model siblings are per-turn choices, not separate activations.
  const seenPluginIds = new Set<string>();
  const defaults = binding.entries.filter((entry) => {
    const pluginId = entry.identity.pluginId;
    if (seenPluginIds.has(pluginId)) return false;
    seenPluginIds.add(pluginId);
    return true;
  });
  const results = await Promise.allSettled(
    defaults.map((entry) =>
      serialized(binding, entry.identity.pluginId, async () => {
        active(binding, input.signal);
        const { selection } = await input.client.plugins.getSelection(
          entry.identity.pluginId,
          { signal: input.signal },
        );
        active(binding, input.signal);
        if (selection?.state !== "enabled") return;
        await reconcile({
          ...input,
          binding,
          entry,
          selection,
          reason: "restore",
        });
      }),
    ),
  );
  active(binding, input.signal);
  return Object.freeze(
    results.flatMap((result, index) =>
      result.status === "fulfilled"
        ? []
        : [
            Object.freeze({
              pluginId: defaults[index]!.identity.pluginId,
              reasonCode: "desktop_native_plugin_business_activation_failed",
            }),
          ],
    ),
  );
}

async function reconcile(
  input: Readonly<{
    binding: Binding;
    entry: Entry;
    client: ControlApiClient;
    selection: PluginSelectionView;
    signal: AbortSignal;
    reason: "restore" | "selection";
  }>,
): Promise<void> {
  const { binding, entry, client, selection, signal } = input;
  const options = { signal };
  const current = async () => {
    active(binding, signal);
    const selected = await client.plugins.getSelection(
      entry.identity.pluginId,
      options,
    );
    active(binding, signal);
    if (
      !isDeepStrictEqual(selected.selection, selection) ||
      selection.pluginId !== entry.identity.pluginId ||
      selection.publisherId !== entry.identity.publisherId ||
      selection.selectedPackageDigest !== entry.identity.packageDigest
    )
      fail("selection_changed");
    const installed = await client.plugins.getPackage(
      entry.identity.packageDigest,
      options,
    );
    active(binding, signal);
    if (
      installed.package === null ||
      (["pluginId", "publisherId", "version", "packageDigest"] as const).some(
        (key) => installed.package![key] !== entry.identity[key],
      )
    )
      fail("package_changed");
    const configured = await client.getExtensionConfiguration(
      entry.identity.pluginId,
      {},
      options,
    );
    active(binding, signal);
    if (!isDeepStrictEqual(configured.configuration, entry.configuration))
      fail("configuration_changed");
  };
  await current();
  const { activation } = await client.getExtensionActivation(
    entry.identity.pluginId,
    options,
  );
  await current();
  const activationCurrent = async (expected: typeof activation) => {
    const latest = await client.getExtensionActivation(
      entry.identity.pluginId,
      options,
    );
    await current();
    if (!isDeepStrictEqual(latest.activation, expected))
      fail("activation_changed");
  };
  if (
    input.reason === "restore" &&
    activation !== null &&
    activation.state !== "enabled"
  )
    return activationCurrent(activation);
  const state = selection.state === "enabled" ? "enabled" : "disabled";
  if (state === "disabled" && activation?.state === "revoked")
    return activationCurrent(activation);
  if (
    activation?.state === state &&
    activation.configurationRevision === entry.configuration.revision &&
    activation.configurationDigest === entry.configuration.contentDigest &&
    isDeepStrictEqual(
      activation.target,
      state === "enabled" ? entry.configuredTarget : null,
    )
  )
    return activationCurrent(activation);
  if (state === "disabled" && activation === null)
    return activationCurrent(null);
  const request = {
    configurationRevision: entry.configuration.revision,
    expectedRevision: activation?.revision ?? 0,
    state,
    agentVersionId:
      state === "enabled" ? entry.configuredTarget.agentVersionId : null,
  } as const;
  const key = `native-business-${createHash("sha256")
    .update(
      extensionCanonicalJson({
        selection,
        configuration: entry.configuration,
        target: entry.configuredTarget,
        request,
      }),
    )
    .digest("hex")}`;
  await current();
  const result = await client.setExtensionActivation(
    entry.identity.pluginId,
    request,
    key,
    options,
  );
  await current();
  if (
    result.activation.configurationDigest !==
      entry.configuration.contentDigest ||
    !isDeepStrictEqual(
      result.activation.target,
      state === "enabled" ? entry.configuredTarget : null,
    )
  )
    fail("activation_changed");
  await activationCurrent(result.activation);
}

function active(binding: Binding, signal: AbortSignal): void {
  signal.throwIfAborted();
  binding.assertCurrent();
}
async function serialized<T>(
  binding: Binding,
  pluginId: string,
  work: () => Promise<T>,
): Promise<T> {
  if (binding.budget.pending >= 128) fail("capacity_exceeded");
  binding.budget.pending++;
  const previous = binding.queues.get(pluginId) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(work);
  binding.queues.set(pluginId, pending);
  void pending
    .finally(() => {
      binding.budget.pending--;
      if (binding.queues.get(pluginId) === pending)
        binding.queues.delete(pluginId);
    })
    .catch(() => {});
  return pending;
}
function fail(code: string): never {
  throw new Error(`desktop_native_plugin_business_${code}`);
}
