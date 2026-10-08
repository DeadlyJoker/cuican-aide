import {
  creativeProjectDigest,
  creativeProjectOpaqueId,
  validateCreativeProjectActor,
} from "@crewon/domain";
import type { ProjectSourceUploadApplicationService } from "./project-source-upload-application-service.ts";
import type {
  ProjectSourcePreparationPort,
  ProjectSourcePreparationRequest,
} from "./project-source-preparation-port.ts";
import { sourceUploadFields } from "./project-source-upload-validation.ts";

/** Same durable upload service and independent adopt PDP; no bytes, parser or Store bypass. */
export class ProjectSourceUploadFoundationAdapter
  implements ProjectSourcePreparationPort
{
  readonly #getPrepared: ProjectSourceUploadApplicationService["getPreparedForAdoption"];
  readonly #captureAdoption: ProjectSourceUploadApplicationService["captureAdoptionAuthority"];
  constructor(
    uploads: Pick<
      ProjectSourceUploadApplicationService,
      "getPreparedForAdoption" | "captureAdoptionAuthority"
    >,
  ) {
    this.#getPrepared = uploads.getPreparedForAdoption.bind(uploads);
    this.#captureAdoption = uploads.captureAdoptionAuthority.bind(uploads);
    Object.freeze(this);
  }
  async loadPrepared(request: ProjectSourcePreparationRequest) {
    const { actor, ...reference } = capturedRequest(request);
    return this.#getPrepared(actor, reference);
  }
  captureAdoptionAuthority(request: ProjectSourcePreparationRequest) {
    const { actor, ...reference } = capturedRequest(request);
    return this.#captureAdoption(actor, reference);
  }
}
function capturedRequest(request: ProjectSourcePreparationRequest) {
  const v = sourceUploadFields(request, [
      "actor",
      "uploadId",
      "fileDigest",
      "projectId",
    ]),
    actor = validateCreativeProjectActor(v.actor),
    uploadId = creativeProjectOpaqueId(v.uploadId),
    fileDigest = creativeProjectDigest(v.fileDigest),
    projectId =
      v.projectId === null ? null : creativeProjectOpaqueId(v.projectId);
  return Object.freeze({ actor, uploadId, fileDigest, projectId });
}
