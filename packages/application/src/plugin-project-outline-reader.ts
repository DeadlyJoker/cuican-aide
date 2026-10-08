import {
  parseProjectOutlineUiRequest,
  parseProjectOutlineUiResponse,
  MAX_PROJECT_OUTLINE_UI_RESPONSE_BYTES,
  type ProjectOutlineUiRequest,
} from "@crewon/contracts/project-outlines";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import { ApplicationError } from "./application-error.ts";
import { ProjectStructuredOutlineApplicationService } from "./project-structured-outline-application-service.ts";
import {
  projectOutlinePublicSection,
  projectOutlinePublicSummary,
  projectOutlinePublicView,
} from "./project-outline-public-projection.ts";
import { capturePluginUiInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";
import {
  uiActor,
  uiEpoch,
  uiPackage,
  uiProfile,
  uiPublicLease,
  uiRecord,
  uiSelection,
} from "./plugin-ui-application-support.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";

function contextSnapshot(input: PluginUiActionContext) {
  const fields = uiRecord(input, [
    "actor",
    "scope",
    "selection",
    "package",
    "lease",
    "authorityEpoch",
    "action",
    "input",
  ]);
  const actor = uiActor(fields.actor as PluginUiActionContext["actor"]),
    scope = uiProfile(fields.scope, actor);
  const lease = uiPublicLease(fields.lease),
    selection = uiSelection(fields.selection, scope, lease.descriptor.pluginId);
  const pkg = uiPackage(fields.package, scope, selection),
    request = parseProjectOutlineUiRequest({
      action: fields.action,
      input: fields.input,
    });
  if (
    selection.state !== "enabled" ||
    selection.revision !== lease.selectionRevision ||
    pkg.packageDigest !== lease.packageDigest ||
    pkg.version !== lease.descriptor.version ||
    pkg.publisherId !== lease.descriptor.publisherId
  )
    throw new ApplicationError(
      "authorization",
      "plugin_project_outline_context_invalid",
    );
  const context = Object.freeze({
    actor,
    scope,
    selection,
    package: pkg,
    lease,
    authorityEpoch: uiEpoch(fields.authorityEpoch),
    action: request.action,
    input: request.input,
  }) as PluginUiActionContext;
  return Object.freeze({
    context,
    request,
    fingerprint: JSON.stringify(context),
  });
}

/** New read-only capability enters through the existing private invoke lifecycle; it issues no write receipt or Run. */
export function capturePluginProjectOutlineReader(input: unknown) {
  if (!(input instanceof ProjectStructuredOutlineApplicationService))
    throw new Error("plugin_project_outline_service_invalid");
  const proto = ProjectStructuredOutlineApplicationService.prototype;
  const service = Object.freeze({
    getOutline: proto.getOutline.bind(input),
    getRevision: proto.getRevision.bind(input),
    listRevisions: proto.listRevisions.bind(input),
  });
  return async (
    invocation: PluginUiActionContext,
    fences: Readonly<{
      assertAvailable(): void;
      assertPublication(context: PluginUiActionContext): void;
      authorize(
        context: PluginUiActionContext,
        request: ProjectOutlineUiRequest,
      ): Promise<void>;
    }>,
  ) => {
    // Check private membership before inspecting any public fields.
    const original = capturePluginUiInvocationCommitAuthority(invocation);
    if (original.transaction !== undefined)
      throw new ApplicationError(
        "authorization",
        "plugin_project_outline_read_authority_invalid",
      );
    const snapshot = contextSnapshot(invocation);
    fences.assertPublication(snapshot.context);
    const current = async () => {
      fences.assertAvailable();
      original.assertActive();
      await original.assertCurrent();
      const result: unknown = await fences.authorize(
        invocation,
        snapshot.request,
      );
      if (result !== undefined)
        throw new ApplicationError(
          "authorization",
          "plugin_project_outline_authorization_invalid",
        );
      fences.assertAvailable();
      original.assertActive();
      await original.assertCurrent();
      if (contextSnapshot(invocation).fingerprint !== snapshot.fingerprint)
        throw new ApplicationError(
          "authorization",
          "plugin_project_outline_context_changed",
        );
    };
    await current();
    const request = snapshot.request;
    let output: unknown;
    switch (request.action) {
      case "crewon.project-outlines.v2.getOutline":
        output = {
          view: projectOutlinePublicView(
            await service.getOutline(snapshot.context.actor, request.input),
          ),
        };
        break;
      case "crewon.project-outlines.v2.getSection":
        output = projectOutlinePublicSection(
          await service.getRevision(snapshot.context.actor, {
            projectId: request.input.projectId,
            artifactId: request.input.artifactId,
            contentRevision: request.input.contentRevision,
          }),
          request.input,
        );
        break;
      case "crewon.project-outlines.v2.listRevisions": {
        const page = await service.listRevisions(
          snapshot.context.actor,
          request.input,
        );
        output = {
          revisions: page.revisions.map(projectOutlinePublicSummary),
          nextContentRevision: page.nextContentRevision,
        };
        break;
      }
    }
    await current();
    return parsePluginUiJsonValue(
      parseProjectOutlineUiResponse(request, output),
      { maxBytes: MAX_PROJECT_OUTLINE_UI_RESPONSE_BYTES },
    );
  };
}
