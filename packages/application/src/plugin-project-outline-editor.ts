import {
  parseProjectOutlineEditResult,
  type ProjectOutlineEditRequest,
} from "@crewon/contracts/project-outline-edits";
import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import { ApplicationError } from "./application-error.ts";
import { ProjectStructuredOutlineApplicationService } from "./project-structured-outline-application-service.ts";
import { capturePluginProjectOutlineEditInvocation } from "./plugin-project-outline-edit-invocation.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import type { SaveProjectStructuredOutlineCommand } from "./project-structured-outline-commands.ts";

/** Actual save/adopt returns a small correlated acknowledgement. Reads, runs and old v1 writes remain separate. */
export function capturePluginProjectOutlineEditor(input: unknown) {
  if (!(input instanceof ProjectStructuredOutlineApplicationService))
    throw new Error("plugin_project_outline_service_invalid");
  const proto = ProjectStructuredOutlineApplicationService.prototype;
  const save = proto.saveCandidate.bind(input),
    select = proto.selectRevision.bind(input);
  return async (
    context: PluginUiActionContext,
    fences: Readonly<{
      assertAvailable(): void;
      assertPublication(context: PluginUiActionContext): void;
      authorize(
        context: PluginUiActionContext,
        request: ProjectOutlineEditRequest,
      ): Promise<void>;
    }>,
  ) => {
    const invocation = capturePluginProjectOutlineEditInvocation(context),
      snapshot = invocation.snapshot,
      request = snapshot.request;
    fences.assertPublication(snapshot.context);
    const active = () => {
      fences.assertAvailable();
      invocation.assertActive();
    };
    active();
    await invocation.assertCurrent();
    if ((await fences.authorize(context, request)) !== undefined)
      throw new ApplicationError(
        "authorization",
        "plugin_project_outline_edit_denied",
      );
    active();
    const authority = Object.freeze({
      assertCurrent: invocation.assertCurrent,
      assertActive: active,
      outlineUiTransaction: invocation.outlineUiTransaction,
    });
    const result = request.action.endsWith(".saveCandidate")
      ? await save(
          snapshot.context.actor,
          request.input as unknown as SaveProjectStructuredOutlineCommand,
          { authority },
        )
      : await select(
          snapshot.context.actor,
          request.input as Parameters<typeof select>[1],
          { authority },
        );
    if (result.contentRevision === null)
      throw new ApplicationError(
        "internal",
        "project_outline_edit_result_invalid",
      );
    const output = parsePluginUiJsonValue(
      parseProjectOutlineEditResult(request, {
        kind: result.kind,
        disposition: result.disposition,
        projectId: result.artifact.projectId,
        artifactId: result.artifact.artifactId,
        artifactRevision: result.artifact.revision,
        contentRevision: result.contentRevision.contentRevision,
        contentDigest: result.contentRevision.contentDigest,
      }),
    );
    return Object.freeze({ output, fingerprint: snapshot.fingerprint });
  };
}
