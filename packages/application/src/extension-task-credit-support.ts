import {
  extensionCanonicalJson,
  assertExtensionCreditAdmission,
  createExtensionCreditAdmission,
  type ExtensionCreditAdmission,
  type ExtensionRunBinding,
  type WorkflowSchemaValue,
  type ProjectStageRunAdmission,
  type ProjectAssetStageRunAdmission,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { ExtensionTaskApplicationDependencies } from "./extension-task-application-service.ts";
import { extensionCommand } from "./extension-application-support.ts";

export async function quoteExtensionTaskGeneration(
  dependencies: Pick<
    ExtensionTaskApplicationDependencies,
    "extensions" | "creditQuotes" | "digester"
  >,
  actor: ActorContext,
  binding: ExtensionRunBinding,
  receipt: { actorId: string; idempotencyKey: string; requestDigest: string },
  input: WorkflowSchemaValue,
  qualification?:
    | Readonly<{ projectStageAdmission: ProjectStageRunAdmission }>
    | Readonly<{ projectAssetStageAdmission: ProjectAssetStageRunAdmission }>,
): Promise<ExtensionCreditAdmission> {
  if (
    dependencies.extensions.creditAdmissionVersion !==
    "crewon.extension-credit-admission.v0"
  )
    throw new ApplicationError(
      "conflict",
      "extension_credit_admission_unavailable",
    );
  let raw: unknown;
  try {
    const request = Object.freeze({
      actor,
      binding,
      input: JSON.parse(extensionCanonicalJson(input)) as WorkflowSchemaValue,
      commandRequestDigest: receipt.requestDigest,
    });
    if (qualification === undefined)
      raw = await dependencies.creditQuotes!.quoteGeneration(request);
    else if ("projectAssetStageAdmission" in qualification) {
      const quote = dependencies.creditQuotes?.quoteProjectAssetStageGeneration;
      if (typeof quote !== "function")
        throw new ApplicationError(
          "conflict",
          "extension_project_asset_stage_credit_quote_unavailable",
        );
      raw = await quote.call(
        dependencies.creditQuotes,
        Object.freeze({
          ...request,
          projectAssetStageAdmission: qualification.projectAssetStageAdmission,
        }),
      );
    } else {
      const quote =
        dependencies.creditQuotes?.quoteProjectConversationGeneration;
      if (typeof quote !== "function")
        throw new ApplicationError(
          "conflict",
          "extension_project_conversation_credit_quote_unavailable",
        );
      raw = await quote.call(
        dependencies.creditQuotes,
        Object.freeze({
          ...request,
          projectStageAdmission: qualification.projectStageAdmission,
        }),
      );
    }
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(
      "conflict",
      "extension_credit_quote_unavailable",
      { cause: error },
    );
  }
  try {
    const quote = extensionCommand(raw, [
      "poolId",
      "priceRevision",
      "quotedCredits",
    ]);
    return createExtensionCreditAdmission(
      {
        binding,
        receipt,
        principalId: actor.principalId,
        poolId: quote.poolId as string,
        priceRevision: quote.priceRevision as number,
        quotedCredits: quote.quotedCredits as string,
      },
      dependencies.digester,
    );
  } catch (error) {
    throw new ApplicationError("internal", "extension_credit_quote_invalid", {
      cause: error,
    });
  }
}

export function assertExtensionTaskCreditPrincipal(
  digester: ContentDigester,
  actor: ActorContext,
  admission: ExtensionCreditAdmission | undefined,
  binding: ExtensionRunBinding,
  receipt: { actorId: string; idempotencyKey: string; requestDigest: string },
): void {
  if (admission === undefined) return;
  let checked: ExtensionCreditAdmission;
  try {
    checked = assertExtensionCreditAdmission(
      { admission, binding, receipt },
      digester,
    );
  } catch (error) {
    throw new ApplicationError(
      "internal",
      "extension_credit_admission_invalid",
      { cause: error },
    );
  }
  if (
    checked.reservation.scope.principalId !== actor.principalId ||
    checked.tenantId !== actor.tenantId ||
    checked.spaceId !== actor.spaceId
  )
    throw new ApplicationError(
      "authorization",
      "extension_credit_account_owner_mismatch",
    );
}
