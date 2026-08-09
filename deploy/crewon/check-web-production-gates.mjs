import { readFile } from "node:fs/promises";

const controlMain = await readWorkspaceFile("apps/control-api/src/main.ts");
const controlComposition = await readWorkspaceFile(
  "apps/control-api/src/standalone-composition.ts",
);
const productionComposition = await readOptionalWorkspaceFile(
  "apps/control-api/src/production-composition.ts",
);
const productionSecurity = await readOptionalWorkspaceFile(
  "apps/control-api/src/production-security-adapters.ts",
);

const standaloneCompositionRemainsIsolated =
  controlComposition.includes("new StandaloneIdentity({") &&
  controlComposition.includes("new StandaloneAuthorization(config.actor)");
const productionIdentityCompositionPresent =
  controlMain.includes('securityMode === "production"') &&
  controlMain.includes("createProductionPostgresControlApi") &&
  productionComposition.includes("createProductionPostgresControlApi") &&
  productionComposition.includes("ControlApiIdentityPort") &&
  productionComposition.includes("AuthorizationPort") &&
  productionComposition.includes("ProductionAgentVersionRunRouteResolver") &&
  productionComposition.includes("ProductionStoreReadiness") &&
  !productionComposition.includes("StandaloneIdentity") &&
  !productionComposition.includes("StandaloneAuthorization") &&
  controlMain.includes("CREWON_CONTROL_BFF_TOKEN") &&
  controlMain.includes("CREWON_IDENTITY_VERIFY_URL") &&
  controlMain.includes("CREWON_IDENTITY_EXPECTED_ISSUER") &&
  controlMain.includes("CREWON_IDENTITY_EXPECTED_AUDIENCE") &&
  controlMain.includes("CREWON_POLICY_DECISION_URL") &&
  productionSecurity.includes("x-crewon-bff-authorization") &&
  productionSecurity.includes("ControlTokenVerifierPort") &&
  productionSecurity.includes("PolicyDecisionPort") &&
  productionSecurity.includes("actor_header_forbidden");

if (
  !standaloneCompositionRemainsIsolated ||
  !productionIdentityCompositionPresent
) {
  process.stderr.write(
    [
      "web_production_identity_gate_blocked",
      "PostgreSQL production Control startup is not wired to request-scoped identity and policy authorities.",
      "Implement and wire production ControlApiIdentityPort and AuthorizationPort adapters before Web production cutover.",
      "The production composition must configure a trusted token verifier, expected issuer/audience and dynamic policy authority without a fixed ActorContext.",
      "It must also validate CREWON_CONTROL_BFF_TOKEN from X-CrewON-BFF-Authorization independently of the user token.",
      "The Web BFF boundary alone does not establish multi-user identity.",
    ].join("\n") + "\n",
  );
  process.exitCode = 1;
} else {
  process.stdout.write("web_production_identity_source_gate_passed\n");
}

async function readWorkspaceFile(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

async function readOptionalWorkspaceFile(relativePath) {
  try {
    return await readWorkspaceFile(relativePath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return "";
    }
    throw error;
  }
}
