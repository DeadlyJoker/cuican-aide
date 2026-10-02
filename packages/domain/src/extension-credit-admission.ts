import {
  extensionCanonicalJson,
  extensionDigest,
  extensionOpaqueId,
  type ExtensionContentDigester,
} from "./extension-configuration.ts";
import {
  parseExtensionRunBinding,
  type ExtensionRunBinding,
} from "./extension-run-binding.ts";
import {
  validateCreditReservationInput,
  validateCreditScope,
  type CreditReservationInput,
} from "./plugin-credit.ts";
import {
  copyExtensionJson,
  extensionFailure,
  extensionRecord,
} from "./extension-validation.ts";

export type ExtensionCreditCommandIdentity = Readonly<{
  actorId: string;
  idempotencyKey: string;
  requestDigest: string;
}>;

/** Immutable admission quote and payer; settlement remains a separate ledger operation. */
export type ExtensionCreditAdmission = Readonly<{
  schemaVersion: "crewon.extension-credit-admission.v0";
  tenantId: string;
  spaceId: string;
  actorId: string;
  runId: string;
  bindingDigest: string;
  commandIdempotencyKey: string;
  commandRequestDigest: string;
  reservation: CreditReservationInput;
}>;

export function createExtensionCreditAdmission(
  input: Readonly<{
    binding: ExtensionRunBinding;
    receipt: ExtensionCreditCommandIdentity;
    principalId: string;
    poolId: string;
    priceRevision: number;
    quotedCredits: string;
  }>,
  digester: ExtensionContentDigester,
): ExtensionCreditAdmission {
  const binding = parseExtensionRunBinding(input.binding, digester);
  if (binding.source !== null)
    extensionFailure("extension_credit_generation_required");
  if (input.receipt.actorId !== binding.actorId)
    extensionFailure("extension_credit_admission_identity_mismatch");
  const body = Object.freeze({
    schemaVersion: "crewon.extension-credit-admission.v0" as const,
    tenantId: binding.tenantId,
    spaceId: binding.spaceId,
    actorId: binding.actorId,
    runId: binding.runId,
    bindingDigest: binding.bindingDigest,
    commandIdempotencyKey: extensionOpaqueId(input.receipt.idempotencyKey),
    commandRequestDigest: extensionDigest(input.receipt.requestDigest),
  });
  const payerScope = validateCreditScope({
    tenantId: binding.tenantId,
    principalId: input.principalId,
    poolId: input.poolId,
  });
  const reservation = validateCreditReservationInput({
    scope: payerScope,
    reservationId: binding.runId,
    idempotencyKey: generationCreditKey(
      body,
      payerScope.principalId,
      binding.pluginId,
      digester,
    ),
    requestDigest: `sha256:${"0".repeat(64)}`,
    pluginId: binding.pluginId,
    priceRevision: input.priceRevision,
    quotedCredits: input.quotedCredits,
  });
  return parseExtensionCreditAdmission(
    {
      ...body,
      reservation: {
        ...reservation,
        requestDigest: reservationDigest(body, reservation, digester),
      },
    },
    digester,
  );
}

export function parseExtensionCreditAdmission(
  input: unknown,
  digester: ExtensionContentDigester,
): ExtensionCreditAdmission {
  const value = extensionRecord(copyExtensionJson(input, 8192), [
    "schemaVersion",
    "tenantId",
    "spaceId",
    "actorId",
    "runId",
    "bindingDigest",
    "commandIdempotencyKey",
    "commandRequestDigest",
    "reservation",
  ]);
  if (value.schemaVersion !== "crewon.extension-credit-admission.v0")
    extensionFailure("extension_credit_admission_version_unsupported");
  const body = Object.freeze({
    schemaVersion: "crewon.extension-credit-admission.v0" as const,
    tenantId: extensionOpaqueId(value.tenantId),
    spaceId: extensionOpaqueId(value.spaceId),
    actorId: extensionOpaqueId(value.actorId),
    runId: extensionOpaqueId(value.runId),
    bindingDigest: extensionDigest(value.bindingDigest),
    commandIdempotencyKey: extensionOpaqueId(value.commandIdempotencyKey),
    commandRequestDigest: extensionDigest(value.commandRequestDigest),
  });
  const reservation = validateCreditReservationInput(value.reservation);
  if (
    reservation.scope.tenantId !== body.tenantId ||
    reservation.reservationId !== body.runId
  )
    extensionFailure("extension_credit_admission_identity_mismatch");
  if (
    reservation.idempotencyKey !==
      generationCreditKey(
        body,
        reservation.scope.principalId,
        reservation.pluginId,
        digester,
      ) ||
    reservation.requestDigest !== reservationDigest(body, reservation, digester)
  )
    extensionFailure("extension_credit_admission_digest_mismatch");
  return Object.freeze({ ...body, reservation });
}

export function assertExtensionCreditAdmission(
  input: Readonly<{
    admission: ExtensionCreditAdmission;
    binding: ExtensionRunBinding;
    receipt: ExtensionCreditCommandIdentity;
  }>,
  digester: ExtensionContentDigester,
): ExtensionCreditAdmission {
  const admission = parseExtensionCreditAdmission(input.admission, digester);
  const binding = parseExtensionRunBinding(input.binding, digester);
  if (
    binding.source !== null ||
    admission.tenantId !== binding.tenantId ||
    admission.spaceId !== binding.spaceId ||
    admission.actorId !== binding.actorId ||
    admission.runId !== binding.runId ||
    admission.bindingDigest !== binding.bindingDigest ||
    admission.reservation.pluginId !== binding.pluginId ||
    admission.actorId !== input.receipt.actorId ||
    admission.commandIdempotencyKey !== input.receipt.idempotencyKey ||
    admission.commandRequestDigest !== input.receipt.requestDigest
  )
    extensionFailure("extension_credit_admission_identity_mismatch");
  return admission;
}

function generationCreditKey(
  body: Omit<ExtensionCreditAdmission, "reservation">,
  principalId: string,
  pluginId: string,
  digester: ExtensionContentDigester,
): string {
  return `extension-generation:${extensionDigest(
    digester.sha256(
      extensionCanonicalJson([
        body.tenantId,
        body.spaceId,
        body.actorId,
        principalId,
        pluginId,
        body.commandIdempotencyKey,
      ]),
    ),
  ).slice(7)}`;
}

function reservationDigest(
  body: Omit<ExtensionCreditAdmission, "reservation">,
  reservation: CreditReservationInput,
  digester: ExtensionContentDigester,
): string {
  const { requestDigest: _, ...quote } = reservation;
  return extensionDigest(
    digester.sha256(extensionCanonicalJson({ ...body, reservation: quote })),
  );
}
