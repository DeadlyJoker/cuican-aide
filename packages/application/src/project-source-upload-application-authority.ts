import { ApplicationError } from "./application-error.ts";
import {
  captureSourceUploadAuthority,
  captureSourceUploadPermission,
} from "./project-source-upload-validation.ts";
import type { ActorContext } from "./authorization-port.ts";
import type {
  ProjectSourceUploadAction,
  ProjectSourceUploadAuthorizationPort,
  ProjectSourceUploadExecutionAuthority,
} from "./project-source-upload-port.ts";

/** Business PDP and actual invocation are separate fences. SQL callbacks never reenter the Store pool. */
export function projectSourceUploadBusinessAuthority(
  input: Readonly<{
    authorization: ProjectSourceUploadAuthorizationPort;
    actor: ActorContext;
    action: ProjectSourceUploadAction;
    uploadId: string | null;
    projectId: string | null;
    execution?: ProjectSourceUploadExecutionAuthority;
  }>,
) {
  const { authorization, actor, action, uploadId, projectId, execution } =
    input;
  const permission = captureSourceUploadPermission({
    actor,
    action,
    resource: {
      kind: "projectSourceUpload",
      owner: {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        principalId: actor.principalId,
      },
      uploadId,
      projectId,
    },
  });
  const active = () => {
    syncActive(() => authorization.assertActive(permission));
    if (execution !== undefined) syncActive(execution.assertActive);
  };
  const policyCurrent = async () => {
    const decision = await authorization.authorize(permission);
    if (decision.outcome !== "allow")
      throw new ApplicationError(
        "authorization",
        "project_source_upload_permission_denied",
      );
    active();
  };
  return captureSourceUploadAuthority({
    version: "crewon.project-source-upload-commit.v1",
    permission,
    assertCurrent: async () => {
      await policyCurrent();
      if (
        execution !== undefined &&
        (await execution.assertCurrent()) !== undefined
      )
        throw new ApplicationError(
          "internal",
          "project_source_upload_authority_invalid",
        );
      active();
    },
    assertActive: active,
    ...(execution?.transaction === undefined
      ? {}
      : {
          transaction: {
            ...execution.transaction,
            assertCurrent: async () => {
              await policyCurrent();
              if ((await execution.transaction!.assertCurrent()) !== undefined)
                throw new ApplicationError(
                  "internal",
                  "project_source_upload_authority_invalid",
                );
              active();
            },
          },
        }),
  });
}
function syncActive(check: () => void): void {
  const result: unknown = check();
  if (result === undefined) return;
  try {
    void Promise.prototype.then.call(
      result,
      () => undefined,
      () => undefined,
    );
  } catch {
    /* Never execute an arbitrary thenable. */
  }
  throw new ApplicationError(
    "internal",
    "project_source_upload_authority_invalid",
  );
}
