import { extensionCanonicalJson } from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { creativeOwner } from "./creative-project-application-support.ts";
import type { ProjectSourcePreparationRequest } from "./project-source-preparation-port.ts";
import type { ProjectSourceUploadCommitAuthority } from "./project-source-upload-port.ts";
import {
  assertSourceUploadActive,
  assertSourceUploadCurrent,
  captureSourceUploadAuthority,
} from "./project-source-upload-validation.ts";
import {
  assertProjectFoundationCommitActive,
  assertProjectFoundationCommitCurrent,
  assertProjectFoundationCommitTransactionCurrent,
} from "./project-foundation-commit-authority.ts";
import type { ProjectFoundationCommitOptions } from "./project-foundation-store-port.ts";

/** A callback for another actor, purpose, owner, upload or target cannot authorize adoption. */
export function captureProjectSourceAdoptionAuthority(
  input: unknown,
  request: ProjectSourcePreparationRequest,
): ProjectSourceUploadCommitAuthority {
  const captured = captureSourceUploadAuthority(input),
    expected = {
      actor: request.actor,
      action: "projectSourceUpload:adopt",
      resource: {
        kind: "projectSourceUpload",
        owner: creativeOwner(request.actor),
        uploadId: request.uploadId,
        projectId: request.projectId,
      },
    };
  if (
    extensionCanonicalJson(captured.permission) !==
    extensionCanonicalJson(expected)
  )
    throw new ApplicationError(
      "authorization",
      "project_foundation_source_adoption_authority_mismatch",
    );
  return captured;
}

/** External policy never borrows SQL. Preserve the existing independent installation pin. */
export function bindSourceAdoption(
  options: ProjectFoundationCommitOptions,
  adoption: ProjectSourceUploadCommitAuthority | null,
): ProjectFoundationCommitOptions {
  if (adoption === null) return options;
  const original = options.authority;
  return Object.freeze({
    ...(options.projectScope === undefined
      ? {}
      : { projectScope: options.projectScope }),
    authority: Object.freeze({
      async assertCurrent() {
        await assertProjectFoundationCommitCurrent(original);
        await assertSourceUploadCurrent(adoption);
      },
      assertActive() {
        assertProjectFoundationCommitActive(original);
        assertSourceUploadActive(adoption);
      },
      ...(original?.transaction === undefined
        ? {}
        : {
            transaction: Object.freeze({
              ...original.transaction,
              async assertCurrent() {
                await assertProjectFoundationCommitTransactionCurrent(original);
                await assertSourceUploadCurrent(adoption);
              },
            }),
          }),
    }),
  });
}
