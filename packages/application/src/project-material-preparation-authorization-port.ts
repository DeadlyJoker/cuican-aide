import type {
  ActorContext,
  AuthorizationDecision,
} from "./authorization-port.ts";
import type { ProjectMaterialPreparationRequest } from "./project-material-preparation-port.ts";

/** Separate host preparation/transfer purposes. No project/text/read permission implies these grants.
 * Callbacks must use external authority only, never borrow the journal's committing database pool.
 */
export interface ProjectMaterialPreparationAuthorizationPort {
  authorize(
    input: Readonly<{
      actor: ActorContext;
      action:
        | "projectMaterial:prepare"
        | "projectMaterial:upload"
        | "projectMaterial:observe";
      resource: Readonly<{
        request: ProjectMaterialPreparationRequest;
        initialDigest: string | null;
        transferRequestDigest: string | null;
      }>;
    }>,
  ): Promise<AuthorizationDecision>;
  /** Mandatory synchronous host-profile/owner/permission fence, including inside journal commits. */
  assertActive(
    input: Readonly<{ request: ProjectMaterialPreparationRequest }>,
  ): void;
}
