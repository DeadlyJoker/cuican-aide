import type { PoolClient } from "pg";
import type { CreativeProjectMutationResult } from "@crewon/application";
import {
  creativeOwnerValues,
  creativeRecordJson,
  type creativeMutationIdentity,
} from "./creative-project-store-records.ts";
/** Original receipt SQL shared by ordinary and qualified creation. */
export async function savePostgresCreativeProjectReceipt(
  input: Readonly<{
    client: PoolClient;
    prefix: string;
    identity: ReturnType<typeof creativeMutationIdentity>;
    result: CreativeProjectMutationResult;
    assertOpen(): void;
  }>,
) {
  input.assertOpen();
  await input.client.query(
    `INSERT INTO ${input.prefix}creative_project_mutation_receipts
         (tenant_id,space_id,principal_id,actor_id,kind,idempotency_key,request_digest,project_id,result_json)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      ...creativeOwnerValues(input.identity.owner),
      input.identity.actor.actorId,
      input.identity.kind,
      input.identity.receipt.idempotencyKey,
      input.identity.receipt.requestDigest,
      input.result.project.projectId,
      creativeRecordJson(input.result),
    ],
  );
  input.assertOpen();
}
