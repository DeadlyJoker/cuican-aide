import {
  assertProjectStructuredOutlineInputs,
  parseProjectOutlineSourceRevision,
  projectTextFailure,
  type ProjectOutlineSourceRevision,
} from "@crewon/domain";
import type { CreativeProjectOwnerScope } from "@crewon/application";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import { decodeStoredTextRevision } from "./project-structured-outline-store-support.ts";
import type { TextRow } from "./project-text-store-support.ts";
import type { ProjectFoundationDownstreamSnapshot } from "./project-foundation-downstream-guard.ts";

export function decodeOutlineSourceRevision(
  row: TextRow,
  owner: CreativeProjectOwnerScope,
  projectId: string,
  artifactId: string,
) {
  const value = decodeStoredTextRevision(row, owner, projectId, artifactId);
  return value === null
    ? null
    : parseProjectOutlineSourceRevision(value, creativeStoreDigester);
}

/** Only fresh writes/admissions compare live inputs. Receipt replay and historic reads keep their pinned source. */
export function assertOutlineSourceInputsCurrent(
  revision: ProjectOutlineSourceRevision | null,
  snapshot: ProjectFoundationDownstreamSnapshot,
) {
  if (revision?.schemaVersion !== "crewon.project-text-revision.v2") return;
  if (snapshot === null) projectTextFailure("project_outline_inputs_stale");
  assertProjectStructuredOutlineInputs(
    revision,
    snapshot.foundation,
    creativeStoreDigester,
  );
}
