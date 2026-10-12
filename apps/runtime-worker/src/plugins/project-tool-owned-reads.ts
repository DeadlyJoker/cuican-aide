import {
  issuePluginProjectRunReadScope,
  type CreativeProjectRunReadAuthority,
} from "@crewon/application/host-project-workspaces";
import {
  PROJECT_TOOL_OPERATIONS,
  type ProjectToolsMethod,
} from "@crewon/contracts/project-tools";
import type { ProjectToolsRequests } from "./project-tools-service-request.ts";
import type { ProjectToolsServiceOwnerDependencies } from "./project-tools-service-owner.ts";
import type { PluginProjectReadOptions } from "@crewon/application";
/** Only the original owner lends current dispatch evidence. The service never accepts it from a plugin request. */
export async function prepareProjectToolOwnedReads(
  input: Readonly<{
    dependencies: ProjectToolsServiceOwnerDependencies;
    method: ProjectToolsMethod;
    request: ProjectToolsRequests[ProjectToolsMethod];
    evidence: Omit<
      CreativeProjectRunReadAuthority,
      "version" | "operationId" | "assertCurrent"
    >;
    assertCurrent(): Promise<void>;
    assertActive(): void;
  }>,
): Promise<
  Readonly<{
    dependencies: Pick<
      ProjectToolsServiceOwnerDependencies,
      "projects" | "texts" | "outlines"
    >;
    projectReadOptions?: PluginProjectReadOptions;
  }>
> {
  const { dependencies, method } = input;
  if (
    dependencies.projectOwnership === undefined ||
    ![
      "readProject",
      "readOutline",
      "readScript",
      "readContent",
      "listRevisions",
    ].includes(method)
  )
    return { dependencies };
  if (
    dependencies.projectOwnership !== "plugin-project-v1" ||
    input.evidence.projectStageAdmission === undefined
  )
    throw new Error("plugin_project_tools_authority_denied");
  const scope = await issuePluginProjectRunReadScope({
    authority: {
      ...input.evidence,
      version: "crewon.creative-project-run-read.v1",
      operationId: PROJECT_TOOL_OPERATIONS[
        method
      ] as CreativeProjectRunReadAuthority["operationId"],
      assertCurrent: input.assertCurrent,
    },
    assertActive: input.assertActive,
  });
  const text =
    method !== "readProject" &&
    (method !== "readContent" ||
      (input.request as ProjectToolsRequests["readContent"]).source.kind ===
        "text");
  if (text && dependencies.readServices === undefined)
    throw new Error("plugin_project_text_read_binding_unavailable");
  return {
    projectReadOptions: { readScope: scope },
    dependencies: text
      ? { ...dependencies, ...dependencies.readServices!(scope) }
      : dependencies,
  };
}
