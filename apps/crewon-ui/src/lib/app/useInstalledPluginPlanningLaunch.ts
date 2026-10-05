import { useMemo, useRef } from "react";
import type { ControlApiClient } from "@crewon/control-client";
import type { ProjectPlanningProposal } from "@crewon/contracts/project-planning";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import type {
  ControlPluginUiCatalog,
  ControlPluginUiModule,
} from "../plugins/controlPluginUiCatalog";
import type { ControlPluginUiHost } from "../plugins/controlPluginUiHost";
import { pluginUiControlRequest } from "../plugins/controlPluginUiSupport";
import {
  isInstalledPluginConversationAction,
  invokeInstalledPluginConversation,
} from "../plugins/installedPluginConversationTransport";
import { createProjectPlanningLaunch } from "../plugins/projectPlanningLaunch";
import { createProjectPlanningLaunchIntentStore } from "../plugins/projectPlanningLaunchIntent";
import { matchesProjectPlanningModule } from "./useInstalledPluginPlanningNavigation";

/** Account and installed source are borrowed from the original App composition, never from a proposal. */
export function useInstalledPluginPlanningLaunch<
  Scope extends { client: ControlApiClient; sessionKey: string | null },
>({
  scope,
  catalog,
  host,
  threadId,
  assertScopeCurrent,
}: {
  scope: Scope | null;
  catalog: ControlPluginUiCatalog | null;
  host: ControlPluginUiHost | null;
  threadId: string | null;
  assertScopeCurrent(scope: Scope): void;
}) {
  const current = useRef({
    scope,
    catalog,
    threadId,
    host,
    assertScopeCurrent,
  });
  current.current = { scope, catalog, threadId, host, assertScopeCurrent };
  return useMemo(() => {
    if (!scope || !scope.sessionKey || !host) return null;
    const assertCurrent = (
      proposal: ProjectPlanningProposal,
      module: ControlPluginUiModule,
    ) => {
      const now = current.current;
      now.assertScopeCurrent(scope);
      if (
        now.scope !== scope ||
        now.host !== host ||
        now.threadId !== proposal.origin.threadId ||
        !now.catalog?.modules.some(
          (m) =>
            m.key === module.key &&
            m.mountKey === module.mountKey &&
            matchesProjectPlanningModule(m, proposal),
        )
      )
        throw new Error("project_planning_launch_context_changed");
    };
    const moduleFor = (proposal: ProjectPlanningProposal) => {
      const module = current.current.catalog?.modules.find(
        (m) =>
          matchesProjectPlanningModule(m, proposal) &&
          [
            "crewon.creative-projects",
            "crewon.project-conversations",
            "crewon.project-conversation-association",
            "crewon.project-text-plans",
          ].every((service) =>
            m.plugin.descriptor.requires.some(
              (r) => r.service === service && r.apiVersion === "1",
            ),
          ),
      );
      if (!module)
        throw new Error("project_planning_launch_module_unavailable");
      assertCurrent(proposal, module);
      return module;
    };
    try {
      const leases = new Map<
        string,
        { proposal: ProjectPlanningProposal; module: ControlPluginUiModule }
      >();
      const store = createProjectPlanningLaunchIntentStore(
        localStorage,
        JSON.stringify([scope.client.requestOrigin, scope.sessionKey]),
      );
      return createProjectPlanningLaunch(store, {
        module: moduleFor,
        assertCurrent,
        async originThread(proposal) {
          const module = moduleFor(proposal);
          const run = await pluginUiControlRequest((signal) =>
            scope.client.getRunInThread(
              proposal.origin.threadId,
              proposal.origin.runId,
              { signal },
            ),
          );
          assertCurrent(proposal, module);
          if (
            run.run.purpose !== "turn" ||
            run.run.collaborationMode !== "default" ||
            !["completed", "failed", "canceled"].includes(run.run.status)
          )
            throw new Error("project_planning_launch_wait_for_turn");
          const active = await pluginUiControlRequest((signal) =>
            scope.client.getThreadActiveRun(proposal.origin.threadId, {
              signal,
            }),
          );
          assertCurrent(proposal, module);
          if (active.run)
            throw new Error("project_planning_launch_wait_for_turn");
          const response = await pluginUiControlRequest((signal) =>
            scope.client.getThread(proposal.origin.threadId, { signal }),
          );
          assertCurrent(proposal, module);
          if (response.thread.status !== "active")
            throw new Error("project_planning_launch_thread_unavailable");
          return {
            revision: response.thread.revision,
            workspaceId: response.thread.workspaceId ?? null,
          };
        },
        async acquire(module, proposal) {
          if (leases.size >= 16)
            throw new Error("project_planning_launch_mount_limit");
          const lease = await host.acquireMount(
            module.plugin,
            module.contributionId,
            new AbortController().signal,
          );
          leases.set(lease.mountRef, { proposal, module });
          return lease;
        },
        async invoke(lease, request) {
          const owner = leases.get(lease.mountRef);
          if (!owner) throw new Error("project_planning_launch_source_changed");
          assertCurrent(owner.proposal, owner.module);
          const signal = new AbortController().signal;
          await host.validateLease(lease, signal);
          assertCurrent(owner.proposal, owner.module);
          if (isInstalledPluginConversationAction(request.action))
            return invokeInstalledPluginConversation(
              {
                client: scope.client,
                assertCurrent: () =>
                  assertCurrent(owner.proposal, owner.module),
              },
              lease,
              {
                action: request.action,
                input: parsePluginUiJsonValue(request.input),
                signal,
              },
            );
          const response = await pluginUiControlRequest(
            (requestSignal) =>
              scope.client.plugins.invoke(
                lease.mountRef,
                {
                  action: request.action,
                  input: parsePluginUiJsonValue(request.input),
                },
                { signal: requestSignal },
              ),
            signal,
          );
          return response.output;
        },
        async release(lease) {
          try {
            await host.loader.closeUnusedMount(lease);
          } finally {
            leases.delete(lease.mountRef);
          }
        },
        retainUntilExpiry(lease) {
          const arm = () => {
            const delay = Date.parse(lease.expiresAt) - Date.now();
            if (delay > 0) setTimeout(arm, Math.min(delay, 2_147_483_647));
            else
              void host.loader
                .closeUnusedMount(lease)
                .catch(() => undefined)
                .finally(() => leases.delete(lease.mountRef));
          };
          arm();
        },
      });
    } catch {
      // Unreadable/corrupt recovery data withdraws launch; original workbench navigation stays available.
      return null;
    }
  }, [scope, host]);
}
