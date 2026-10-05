import { useCallback, useMemo, useRef, useState } from "react";
import type { ProjectPlanningProposal } from "@crewon/contracts/project-planning";
import { parseProjectPlanningProposal } from "@crewon/contracts/project-planning";
import type {
  ControlPluginUiCatalog,
  ControlPluginUiModule,
} from "../plugins/controlPluginUiCatalog";

export function matchesProjectPlanningModule(
  module: ControlPluginUiModule,
  proposal: ProjectPlanningProposal,
): boolean {
  const source = proposal.capability.source,
    descriptor = module.plugin.descriptor;
  return (
    descriptor.pluginId === source.pluginId &&
    descriptor.publisherId === source.publisherId &&
    descriptor.version === source.version &&
    module.plugin.packageDigest === source.packageDigest &&
    module.contributionId === source.contributionId &&
    descriptor.requires.some(
      (r) =>
        r.service === "crewon.project-planning-drafts" && r.apiVersion === "1",
    )
  );
}
/** A host navigation hint only. Accepting a proposal performs no business write. */
export function useInstalledPluginPlanningNavigation<Scope>({
  scope,
  catalog,
  threadId,
}: {
  scope: Scope | null;
  catalog: ControlPluginUiCatalog | null;
  threadId: string | null;
}) {
  const current = useRef({ scope, catalog, threadId });
  current.current = { scope, catalog, threadId };
  const [pending, setPending] = useState<Readonly<{
    scope: Scope;
    moduleId: string;
    requestKey: string;
    proposal: ProjectPlanningProposal;
  }> | null>(null);
  const canOpen = useCallback((proposal: ProjectPlanningProposal) => {
    const now = current.current;
    return (
      now.scope !== null &&
      now.catalog !== null &&
      now.threadId === proposal.origin.threadId &&
      now.catalog.modules.some((module) =>
        matchesProjectPlanningModule(module, proposal),
      )
    );
  }, []);
  const open = useCallback(
    (value: ProjectPlanningProposal) => {
      const proposal = parseProjectPlanningProposal(value),
        now = current.current;
      if (!canOpen(proposal) || now.scope === null)
        throw new Error("project_planning_module_unavailable");
      const module = now.catalog!.modules.find((m) =>
        matchesProjectPlanningModule(m, proposal),
      )!;
      setPending({
        scope: now.scope,
        moduleId: module.key,
        proposal,
        requestKey: crypto.randomUUID(),
      });
    },
    [canOpen],
  );
  const active =
    pending !== null &&
    pending.scope === scope &&
    pending.proposal.origin.threadId === threadId &&
    catalog?.modules.some(
      (module) =>
        module.key === pending.moduleId &&
        matchesProjectPlanningModule(module, pending.proposal),
    )
      ? pending
      : null;
  return {
    navigation: useMemo(
      () => ({ threadId, canOpen, open }),
      [threadId, canOpen, open],
    ),
    request: useMemo(
      () =>
        active === null
          ? null
          : { id: active.moduleId, requestKey: active.requestKey },
      [active],
    ),
    draftFor(module: ControlPluginUiModule) {
      return active !== null && module.key === active.moduleId
        ? active.proposal
        : undefined;
    },
    revision: active?.requestKey ?? null,
  };
}
