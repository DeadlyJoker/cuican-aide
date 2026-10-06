import { projectAssetId } from "@crewon/domain";
import { materialPreparationFields } from "./project-material-preparation-record.ts";
import {
  mediaInputActor,
  projectMediaInputFail,
} from "./project-media-input-record.ts";
import type { ProjectMediaInputListQuery } from "./project-media-input-port.ts";

export function parseProjectMediaInputListQuery(
  input: unknown,
): ProjectMediaInputListQuery {
  const f = materialPreparationFields(input, [
    "actor",
    "projectId",
    "afterMediaInputId",
    "limit",
  ]);
  if (
    !Number.isSafeInteger(f.limit) ||
    (f.limit as number) < 1 ||
    (f.limit as number) > 16
  )
    projectMediaInputFail("catalog_invalid");
  return Object.freeze({
    actor: mediaInputActor(f.actor),
    projectId: projectAssetId(f.projectId),
    afterMediaInputId:
      f.afterMediaInputId === null ? null : projectAssetId(f.afterMediaInputId),
    limit: f.limit as number,
  });
}
