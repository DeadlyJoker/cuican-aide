import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  ActorContext,
  ProjectPlanningRuntimePort,
  ProjectPlanningRuntimeRead,
} from "@crewon/application";
import {
  parseProjectPlanningCapabilities,
  type ProjectPlanningCapability,
} from "@crewon/contracts/project-planning";
import type {
  DesktopProjectExecutionConfiguration,
} from "@crewon/contracts/plugins";
import type { DesktopProjectHistoryConfiguration } from "@crewon/contracts";
import type { RunState, PluginProfileScope } from "@crewon/domain";
import { verifyLocalPluginPackage } from "@crewon/plugin-host";
import type { SqliteRunStore } from "@crewon/store";
import type {
  InstalledPluginReleaseDocument,
  InstalledPluginReleaseIdentity,
} from "./installed-plugin-release-document.ts";
import { nativeAuthorityFailure as fail } from "./installed-plugin-native-authority-files.ts";

/** Internal Native composition inputs, captured from the actual Main authority owner. */
type Owner = Readonly<{
  actor: ActorContext;
  scope: PluginProfileScope;
  projects: DesktopProjectHistoryConfiguration | DesktopProjectExecutionConfiguration;
  installRoot: string;
  store: SqliteRunStore;
  current(signal?: AbortSignal): void;
  operate<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  release(): InstalledPluginReleaseDocument;
  target(
    identity: InstalledPluginReleaseIdentity,
    configuration: InstalledPluginReleaseDocument["entries"][number]["configuration"],
    target: InstalledPluginReleaseDocument["entries"][number]["target"],
    purpose: "submit",
  ): Promise<boolean>;
}>;
const DRAFT_SERVICE = "crewon.project-planning-drafts";
function sameActor(run: RunState, actor: ActorContext): boolean {
  return run.tenantId === actor.tenantId && run.spaceId === actor.spaceId &&
    run.createdByActorId === actor.actorId;
}

/** Metadata and proposal data only. This port has no project, Thread, plan or provider write. */
export function createNativeProjectPlanningRuntime(owner: Owner): ProjectPlanningRuntimePort {
  const publications = owner.projects.planningDrafts?.publications ?? [];
  const assertCurrent = async ({ run, claim, signal }: ProjectPlanningRuntimeRead) => {
    owner.current(signal);
    if (!sameActor(run, owner.actor) || claim.workItem.tenantId !== run.tenantId ||
      claim.workItem.runId !== run.runId || run.status !== "running" ||
      run.cancelRequested || (run.purpose ?? "turn") !== "turn" ||
      run.collaborationMode !== "default" || (run.origin ?? null) !== null)
      fail("project_planning_owner_invalid");
    const saved = await owner.store.loadRunInSpace({
      tenantId: run.tenantId, spaceId: run.spaceId, runId: run.runId,
    });
    owner.current(signal);
    if (!isDeepStrictEqual(saved, run)) fail("project_planning_run_changed");
    const thread = await owner.store.loadThreadInSpace({
      tenantId: run.tenantId, spaceId: run.spaceId, threadId: run.threadId,
    });
    owner.current(signal);
    if (thread === null || thread.status !== "active" ||
      thread.createdByActorId !== owner.actor.actorId)
      fail("project_planning_thread_invalid");
    const extensions = owner.store.extensionStore();
    const locator = { tenantId: run.tenantId, spaceId: run.spaceId, runId: run.runId };
    const admission = await extensions.loadPluginTaskAdmission(locator);
    owner.current(signal);
    const query = await extensions.loadPluginQueryTaskAdmission(locator);
    owner.current(signal);
    if (admission !== null || query !== null) fail("project_planning_run_invalid");
  };
  return Object.freeze({
    version: "crewon.project-planning-runtime.v1" as const,
    assertActive: () => owner.current(),
    canPublish(run: RunState) {
      try {
        owner.current();
        return publications.length > 0 && sameActor(run, owner.actor);
      } catch { return false; }
    },
    assertCurrent: (input: ProjectPlanningRuntimeRead) =>
      owner.operate(() => assertCurrent(input), input.signal),
    readCapabilities: (input: ProjectPlanningRuntimeRead) => owner.operate(async () => {
      await assertCurrent(input);
      const capabilities: ProjectPlanningCapability[] = [];
      for (const publication of publications) {
        owner.current(input.signal);
        if (!owner.projects.pluginUi?.publications.some((p) => isDeepStrictEqual(p, publication)) ||
          !owner.projects.conversations?.publications.some((p) => isDeepStrictEqual(p, publication)))
          fail("project_planning_publication_invalid");
        const selection = await owner.store.pluginInstallationStore().loadSelection({
          scope: owner.scope, pluginId: publication.pluginId,
        });
        owner.current(input.signal);
        if (selection === null || selection.state !== "enabled" ||
          selection.selectedPackageDigest !== publication.packageDigest) continue;
        const verified = await verifyLocalPluginPackage({
          directory: join(owner.installRoot, "packages", publication.packageDigest.slice(7)),
          signal: input.signal,
        });
        owner.current(input.signal);
        const descriptor = verified.descriptor;
        if (verified.packageDigest !== publication.packageDigest ||
          descriptor.pluginId !== publication.pluginId || descriptor.publisherId !== selection.publisherId)
          fail("project_planning_package_changed");
        // Optional data-props protocol; declaring it does not grant any service invocation.
        if (!descriptor.requires.some((r) => r.service === DRAFT_SERVICE && r.apiVersion === "1")) continue;
        const contribution = descriptor.contributions.find((c) => c.id === publication.contributionId &&
          c.kind === "module" && c.slot === "main.content");
        if (!contribution || descriptor.entrypoints.ui === null) fail("project_planning_module_invalid");
        const identity = {
          pluginId: descriptor.pluginId, publisherId: descriptor.publisherId,
          version: descriptor.version, packageDigest: publication.packageDigest,
        };
        // Main's pinned metadata publication and actual installation authorize discovery.
        // A separate Node execution approval is deliberately required only for executionReady.
        const installed = await owner.store.pluginInstallationStore().loadPackage({
          scope: owner.scope, packageDigest: publication.packageDigest,
        });
        owner.current(input.signal);
        if (!installed || Object.entries(identity).some(([field, value]) =>
          installed[field as keyof typeof installed] !== value)) fail("project_planning_installation_changed");
        let executionReady = false;
        if ("pluginGenerations" in owner.projects && owner.projects.pluginGenerations?.publications.some(
          (p) => isDeepStrictEqual(p.source, publication),
        )) {
          const entry = owner.release().entries.find((candidate) =>
            isDeepStrictEqual(candidate.packageIdentity, identity));
          if (entry) executionReady = await owner.target(identity, entry.configuration, entry.target, "submit");
          owner.current(input.signal);
        }
        const after = await owner.store.pluginInstallationStore().loadSelection({
          scope: owner.scope, pluginId: publication.pluginId,
        });
        owner.current(input.signal);
        if (!isDeepStrictEqual(after, selection)) fail("project_planning_selection_changed");
        const source = { ...identity, contributionId: publication.contributionId };
        capabilities.push({
          capabilityId: `sha256:${createHash("sha256").update(JSON.stringify({
            protocol: "crewon.project-planning-capability.v1", source,
          })).digest("hex")}`,
          source, title: contribution.title, kind: "short-drama",
          stages: ["brief", "outline", "script"], maximumEpisodes: 16,
          moduleAvailable: true, textPlansAvailable: true, executionReady,
        });
        if (capabilities.length > 8) fail("project_planning_capability_limit");
      }
      await assertCurrent(input);
      return parseProjectPlanningCapabilities({
        schemaVersion: "crewon.project-planning-capabilities.v1", capabilities,
      }).capabilities;
    }, input.signal),
  });
}
