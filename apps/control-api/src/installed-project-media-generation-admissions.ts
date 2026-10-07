import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  ApplicationError,
  mediaInputSame as same,
  type ActorContext,
  type CreativeProjectCommitAuthority,
} from "@crewon/application";
import { PROJECT_MEDIA_GENERATE_UI_ACTION } from "@crewon/contracts/project-media-generations";
import {
  parseProjectConversationBinding,
  parseInstalledPluginPackage,
  parsePluginSelection,
  parsePluginTaskAdmissionPin,
  type PluginTaskAdmission,
  type PluginTaskAdmissionPin,
} from "@crewon/domain";
import {
  verifyLocalPluginPackage,
  loadInstalledPluginBusinessRegistration,
} from "@crewon/plugin-host";
import type {
  GenerateProjectMediaCommand,
  ProjectMediaGenerationAdmission,
} from "@crewon/media-runtime";
import {
  installedProjectMediaGenerationTaskAuthority,
  type InstalledPluginTaskRuntimeCore,
} from "./installed-plugin-task-runtime-core.ts";

const hash = {
  sha256: (value: string) =>
    "sha256:" + createHash("sha256").update(value).digest("hex"),
};

/** Live admission for both adapters. It issues no material permission and never accepts a client-supplied installation pin. */
export class InstalledProjectMediaGenerationAdmissions {
  readonly #journalAuthorities = new WeakMap<
    ProjectMediaGenerationAdmission,
    CreativeProjectCommitAuthority
  >();
  readonly #host: ReturnType<
    typeof installedProjectMediaGenerationTaskAuthority
  >;
  readonly #conversations: ReturnType<
    ReturnType<
      typeof installedProjectMediaGenerationTaskAuthority
    >["store"]["projectConversationStore"]
  >;
  readonly #installations: ReturnType<
    ReturnType<
      typeof installedProjectMediaGenerationTaskAuthority
    >["store"]["pluginInstallationStore"]
  >;
  private constructor(
    host: ReturnType<typeof installedProjectMediaGenerationTaskAuthority>,
  ) {
    this.#host = host;
    this.#conversations = host.store.projectConversationStore();
    this.#installations = host.store.pluginInstallationStore();
  }
  static async prepare(core: InstalledPluginTaskRuntimeCore) {
    const host = installedProjectMediaGenerationTaskAuthority(core);
    const owner = new InstalledProjectMediaGenerationAdmissions(host);
    await owner.#conversations.migrate();
    host.assertActive();
    await owner.#installations.migrate();
    host.assertActive();
    return owner;
  }
  async resolve(
    input: Readonly<{
      actor: ActorContext;
      command: GenerateProjectMediaCommand;
      previous: PluginTaskAdmission | null;
      signal: AbortSignal;
    }>,
  ): Promise<ProjectMediaGenerationAdmission> {
    return this.#resolve(input, "submit");
  }
  async resolveRecovery(
    input: Readonly<{
      actor: ActorContext;
      command: Readonly<{ projectId: string; threadId: string }>;
      signal: AbortSignal;
    }>,
  ): Promise<ProjectMediaGenerationAdmission> {
    return this.#resolve({ ...input, previous: null }, "read");
  }
  /** Actual installation snapshot for the original journal, never a fabricated UI invocation. */
  journalAuthority(admission: ProjectMediaGenerationAdmission) {
    const authority = this.#journalAuthorities.get(admission);
    if (!authority) denied();
    authority.assertActive();
    return authority;
  }
  async #resolve(
    input: Readonly<{
      actor: ActorContext;
      command: Readonly<{ projectId: string; threadId: string }>;
      previous: PluginTaskAdmission | null;
      signal: AbortSignal;
    }>,
    purpose: "read" | "submit",
  ): Promise<ProjectMediaGenerationAdmission> {
    const { actor, command, previous } = input;
    const h = this.#host,
      requests = h.requests;
    h.assertActive();
    const scope = requests.currentScope();
    const signal = AbortSignal.any([input.signal, requests.currentSignal()]);
    const active = () => {
      h.assertActive();
      signal.throwIfAborted();
      if (
        !same(actor, requests.currentActor()) ||
        !same(scope, requests.currentScope())
      )
        denied();
    };
    const requestCurrent = async () => {
      active();
      await requests.assertCurrent();
      active();
    };
    await requestCurrent();
    const readBinding = async () => {
      const raw = await this.#conversations.loadBinding({
        actor,
        profileId: scope.profileId,
        threadId: command.threadId,
      });
      if (!raw) denied();
      const b = parseProjectConversationBinding(raw, hash);
      if (
        !same(b.owner, actor) ||
        b.profileId !== scope.profileId ||
        b.projectId !== command.projectId ||
        b.threadId !== command.threadId ||
        b.state !== "active"
      )
        denied();
      return b;
    };
    const b = await readBinding(),
      installation = b.currentInstallation;
    if (
      installation.pluginId !== "crewon.short-drama" ||
      !h.publications.some(
        (p) =>
          p.pluginId === installation.pluginId &&
          p.packageDigest === installation.packageDigest,
      )
    )
      denied();
    const readThread = async () => {
      const thread = await h.store.loadThreadInSpace({
        ...actor,
        threadId: command.threadId,
      });
      if (
        !thread ||
        thread.status !== "active" ||
        thread.createdByActorId !== actor.actorId ||
        (thread.workspaceId ?? null) !== b.workspaceId
      )
        denied();
      return thread;
    };
    await readThread();
    // Original TaskCore checks the expected revision after its receipt lookup;
    // an earlier revision check would reject a concurrent retry that just committed.
    const rawSelection = await this.#installations.loadSelection({
      scope,
      pluginId: installation.pluginId,
    });
    const rawPackage = await this.#installations.loadPackage({
      scope,
      packageDigest: installation.packageDigest,
    });
    if (!rawSelection || !rawPackage) denied();
    const selection = parsePluginSelection(rawSelection),
      pkg = parseInstalledPluginPackage(rawPackage);
    if (
      selection.state !== "enabled" ||
      selection.selectedPackageDigest !== installation.packageDigest ||
      selection.revision !== installation.selectionRevision ||
      selection.publisherId !== installation.publisherId ||
      pkg.pluginId !== installation.pluginId ||
      pkg.publisherId !== installation.publisherId ||
      pkg.version !== installation.version ||
      !same(scope, {
        tenantId: pkg.tenantId,
        spaceId: pkg.spaceId,
        profileId: pkg.profileId,
      })
    )
      denied();
    const candidate = await verifyLocalPluginPackage({
      directory: join(h.installRoot, "packages", pkg.packageDigest.slice(7)),
      signal,
    });
    if (
      candidate.packageDigest !== pkg.packageDigest ||
      candidate.descriptor.pluginId !== pkg.pluginId ||
      candidate.descriptor.version !== pkg.version ||
      candidate.descriptor.publisherId !== pkg.publisherId ||
      candidate.descriptor.entrypoints.node === null ||
      !candidate.descriptor.contributions.some(
        (c) =>
          c.id === "workbench" &&
          c.kind === "module" &&
          c.slot === "main.content",
      )
    )
      denied();
    const checkPackage = async (purpose: "read" | "submit") => {
      if (
        (await h.authorizePackage(
          {
            actor,
            scope,
            candidate: {
              descriptor: candidate.descriptor,
              packageDigest: candidate.packageDigest,
            },
            purpose,
          },
          signal,
        )) !== "allow"
      )
        denied();
    };
    await checkPackage("read");
    const registration = await loadInstalledPluginBusinessRegistration({
      installRoot: h.installRoot,
      expectedPluginId: pkg.pluginId,
      expectedPublisherId: pkg.publisherId,
      expectedVersion: pkg.version,
      expectedPackageDigest: pkg.packageDigest,
      signal,
      authorizeRead: async () => {
        await requestCurrent();
        await checkPackage("read");
        return "allow";
      },
    });
    for (const [operationId, effect, recovery, capability] of [
      ["media_submit", "mutation", "reconcilable", "extension.image.generate"],
      ["media_observe", "readOnly", "replaySafe", "extension.image.read"],
    ])
      if (
        !registration.manifest.tools.some(
          (t) =>
            t.operationId === operationId &&
            t.adapterId === "crewon.project-media-execution" &&
            t.effect === effect &&
            t.recovery === recovery &&
            t.capability === capability,
        )
      )
        denied();
    const resource = {
      kind: "pluginUi" as const,
      ...scope,
      pluginId: pkg.pluginId,
      packageDigest: pkg.packageDigest,
      selectionRevision: selection.revision,
      contributionId: "workbench",
    };
    const decision = await h.authorization.authorize({
      actor,
      action: "invoke",
      resource,
    });
    if (decision.outcome !== "allow") denied();
    const currentPin = parsePluginTaskAdmissionPin({
      ...installation,
      principalId: actor.principalId,
      actorId: actor.actorId,
      contributionId: "workbench",
      action: "media.generate",
      authorityEpoch: decision.authorityEpoch,
    });
    // Recovery retains the original accepted identity while current request/installation is independently authorized.
    const pin =
      previous === null
        ? currentPin
        : parsePluginTaskAdmissionPin(
            Object.fromEntries(
              Object.keys(currentPin).map((k) => [
                k,
                previous[k as keyof PluginTaskAdmissionPin],
              ]),
            ),
          );
    const assertTransactionCurrent = async () => {
      await requestCurrent();
      const next = await h.authorization.authorize({
        actor,
        action: "invoke",
        resource,
      });
      if (
        next.outcome !== "allow" ||
        next.authorityEpoch !== decision.authorityEpoch
      )
        denied();
      await checkPackage(previous === null ? purpose : "read");
      active();
    };
    const assertCurrent = async () => {
      await assertTransactionCurrent();
      if (!same(await readBinding(), b)) denied();
      await readThread();
      const nextSelection = await this.#installations.loadSelection({
        scope,
        pluginId: pkg.pluginId,
      });
      const nextPackage = await this.#installations.loadPackage({
        scope,
        packageDigest: pkg.packageDigest,
      });
      if (!same(nextSelection, selection) || !same(nextPackage, pkg)) denied();
      const bytes = await verifyLocalPluginPackage({
        directory: candidate.directory,
        signal,
      });
      if (
        bytes.packageDigest !== pkg.packageDigest ||
        !same(bytes.descriptor, candidate.descriptor)
      )
        denied();
      active();
    };
    await assertCurrent();
    const admission = Object.freeze({
      pin,
      conversation: b,
      assertCurrent,
      assertTransactionCurrent,
      assertActive: active,
    });
    this.#journalAuthorities.set(
      admission,
      Object.freeze({
        assertCurrent,
        assertActive: active,
        transaction: Object.freeze({
          version: "crewon.creative-project-plugin-commit.v1" as const,
          // The journal describes the shared logical command; TaskCore retains media.generate.
          pin: parsePluginTaskAdmissionPin({
            ...currentPin,
            action: PROJECT_MEDIA_GENERATE_UI_ACTION,
          }),
          selection,
          package: pkg,
          assertCurrent: assertTransactionCurrent,
        }),
      }),
    );
    return admission;
  }
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "project_media_generation_scope_changed",
  );
}
