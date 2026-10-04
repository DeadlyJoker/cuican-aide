import {
  parseRenewPluginUiMountRequest,
  parseRenewPluginUiMountResponse,
} from "@crewon/contracts";
import type { PluginUiLease } from "@crewon/contracts/plugins";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { RenewPluginUiMountCommand } from "./plugin-ui-commands.ts";
import type {
  PluginUiPackageContext,
  PluginUiPackagePort,
} from "./plugin-ui-ports.ts";
import {
  uiActor,
  uiInput,
  uiOutput,
  uiProjection,
  uiRecord,
  uiRef,
  uiSameActor,
} from "./plugin-ui-application-support.ts";

/** Stable private owner. Public snapshots remain frozen while existing fences keep this identity. */
export class PluginUiMountBinding {
  readonly context: PluginUiPackageContext;
  readonly authorityEpoch: string;
  #lease: PluginUiLease;
  constructor(
    context: PluginUiPackageContext,
    lease: PluginUiLease,
    authorityEpoch: string,
  ) {
    this.context = context;
    this.#lease = lease;
    this.authorityEpoch = authorityEpoch;
    Object.freeze(this);
  }
  get lease(): PluginUiLease {
    return this.#lease;
  }
  replaceLease(lease: PluginUiLease): void {
    this.#lease = lease;
  }
}

export class PluginUiMountRegistry extends Map<string, PluginUiMountBinding> {
  readonly #now: () => number;
  constructor(now: () => number) {
    super();
    this.#now = now;
  }
  binding(actor: ActorContext, mountRef: string): PluginUiMountBinding {
    const binding = this.get(mountRef);
    if (!binding || !uiSameActor(actor, binding.context.actor))
      throw new ApplicationError("notFound", "plugin_ui_mount_unavailable");
    this.alive(binding);
    return binding;
  }
  alive(binding: PluginUiMountBinding): void {
    if (this.get(binding.lease.mountRef) !== binding)
      throw new ApplicationError("notFound", "plugin_ui_mount_unavailable");
    if (this.#now() >= Date.parse(binding.lease.expiresAt)) {
      this.delete(binding.lease.mountRef);
      throw new ApplicationError("conflict", "plugin_ui_mount_expired");
    }
  }
  expected(binding: PluginUiMountBinding, expiresAt: string): void {
    this.alive(binding);
    if (binding.lease.expiresAt !== expiresAt)
      throw new ApplicationError("conflict", "plugin_ui_mount_lease_changed");
  }
  purge(): void {
    const now = this.#now();
    for (const [reference, binding] of this)
      if (Date.parse(binding.lease.expiresAt) <= now) this.delete(reference);
  }
}

export async function renewPluginUiMount(
  actorInput: ActorContext,
  input: RenewPluginUiMountCommand,
  dependencies: Readonly<{
    mounts: PluginUiMountRegistry;
    packages: PluginUiPackagePort;
    fence(actor: ActorContext, binding: PluginUiMountBinding): Promise<void>;
    now(): number;
    ttlMs: number;
  }>,
): Promise<PluginUiLease> {
  const actor = uiActor(actorInput);
  const command = uiInput(() => {
    const fields = uiRecord(input, ["mountRef", "expectedExpiresAt"]);
    return {
      mountRef: uiRef(fields.mountRef),
      ...parseRenewPluginUiMountRequest({
        expectedExpiresAt: fields.expectedExpiresAt,
      }),
    };
  });
  const binding = dependencies.mounts.binding(actor, command.mountRef);
  const original = binding.lease;
  dependencies.mounts.expected(binding, command.expectedExpiresAt);
  await dependencies.fence(actor, binding);
  dependencies.mounts.expected(binding, original.expiresAt);
  const publication = uiProjection(
    await dependencies.packages.verify(binding.context),
    binding.context,
    original.contributionId,
  );
  if (
    JSON.stringify(publication.descriptor) !==
      JSON.stringify(original.descriptor) ||
    JSON.stringify(publication.publicAssets) !==
      JSON.stringify(original.publicAssets)
  )
    throw new ApplicationError(
      "conflict",
      "plugin_ui_mount_publication_changed",
    );
  await dependencies.fence(actor, binding);
  dependencies.mounts.expected(binding, original.expiresAt);
  const expiresAt = new Date(
    dependencies.now() + dependencies.ttlMs,
  ).toISOString();
  if (Date.parse(expiresAt) <= Date.parse(original.expiresAt))
    throw new ApplicationError("conflict", "plugin_ui_mount_renewal_not_due");
  const renewed = uiOutput(() =>
    parseRenewPluginUiMountResponse({ ...original, expiresAt }, original),
  );
  // No await between the final old-lease CAS and publishing this immutable snapshot.
  dependencies.mounts.expected(binding, original.expiresAt);
  binding.replaceLease(renewed);
  return renewed;
}
