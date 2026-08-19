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
const nginx = await readWorkspaceFile("deploy/crewon/nginx.conf");
const webDockerfile = await readWorkspaceFile("deploy/crewon/web.Dockerfile");
const productionCompose = await readWorkspaceFile(
  "deploy/crewon/compose.production.yml",
);
const webEnvironment = await readWorkspaceFile(
  "deploy/crewon/web-bff.production.env.example",
);
const controlEnvironment = await readWorkspaceFile(
  "deploy/crewon/control.production.env.example",
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
const legacyAppServerRouteRemoved =
  !nginx.includes("/app-server") &&
  !nginx.includes("6176") &&
  !nginx.includes("/agent-platform-api") &&
  !nginx.includes("127.0.0.1:8000");
const productionNginxConfigurationPackaged = webDockerfile.includes(
  "COPY deploy/crewon/nginx.conf /etc/nginx/conf.d/default.conf",
);
const publicEdgeIsNonRootAndHardened =
  webDockerfile.includes("USER nginx") &&
  productionCompose.includes("- /tmp:size=64m,mode=1777,nosuid,nodev,noexec") &&
  nginx.includes("Content-Security-Policy") &&
  nginx.includes("script-src 'self'") &&
  !nginx.includes("unsafe-eval") &&
  nginx.includes("frame-ancestors 'none'");
const publicHealthRoutesAreExact =
  nginx.includes("location = /control-api/health/live") &&
  nginx.includes("location = /control-api/health/ready");
const publicOriginMatchesListener =
  nginx.includes("listen 6175 ssl") &&
  webEnvironment.includes(
    "CREWON_WEB_PUBLIC_ORIGIN=https://crewon.example.com:6175",
  ) &&
  controlEnvironment.includes(
    "CREWON_BFF_ALLOWED_ORIGINS=https://crewon.example.com:6175",
  );

if (
  !standaloneCompositionRemainsIsolated ||
  !productionIdentityCompositionPresent ||
  !legacyAppServerRouteRemoved ||
  !productionNginxConfigurationPackaged ||
  !publicEdgeIsNonRootAndHardened ||
  !publicHealthRoutesAreExact ||
  !publicOriginMatchesListener
) {
  process.stderr.write(
    [
      "web_production_identity_gate_blocked",
      "PostgreSQL production Control startup is not wired to request-scoped identity and policy authorities.",
      "Implement and wire production ControlApiIdentityPort and AuthorizationPort adapters before Web production cutover.",
      "The production composition must configure a trusted token verifier, expected issuer/audience and dynamic policy authority without a fixed ActorContext.",
      "It must also validate CREWON_CONTROL_BFF_TOKEN from X-CrewON-BFF-Authorization independently of the user token.",
      "nginx must not publish the removed Rust App Server or Agent Platform compatibility routes.",
      "The static Web image must install the checked-in production nginx configuration.",
      "The public nginx edge must run non-root with a strict no-eval Content Security Policy.",
      "Public live/ready routes and the browser origin must match the only TLS listener exactly.",
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
