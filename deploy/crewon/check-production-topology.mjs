import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const [compose, control, runtime, bff, backup, host] = await Promise.all(
  [
    "deploy/crewon/compose.production.yml",
    "deploy/crewon/control.production.env.example",
    "deploy/crewon/runtime.production.env.example",
    "deploy/crewon/web-bff.production.env.example",
    "deploy/crewon/backup.production.env.example",
    "deploy/crewon/compose.host.env.example",
  ].map((path) => readFile(new URL(path, root), "utf8")),
);

const failures = [];
const requireText = (source, text, code) => {
  if (!source.includes(text)) failures.push(code);
};
const forbidText = (source, text, code) => {
  if (source.includes(text)) failures.push(code);
};

for (const service of [
  "runtime-release:",
  "runtime-rollback:",
  "runtime-backup:",
  "runtime-worker:",
  "control-api:",
  "web-bff:",
  "web:",
]) {
  requireText(compose, service, `service_missing:${service}`);
}
requireText(compose, "network_mode: host", "host_network_missing");
forbidText(compose, "ports:", "published_port_forbidden");
requireText(
  compose,
  'command: ["node", "/app/init/release-main.mjs"]',
  "release_init_job_missing",
);
requireText(
  compose,
  'command: ["node", "/app/init/release-rollback-main.mjs"]',
  "release_rollback_job_missing",
);
requireText(compose, 'profiles: ["rollback"]', "rollback_profile_missing");
requireText(compose, 'profiles: ["backup"]', "backup_profile_missing");
requireText(
  compose,
  'entrypoint: ["node", "/app/ops/production-backup-main.mjs"]',
  "backup_entrypoint_missing",
);
requireText(
  compose,
  "condition: service_completed_successfully",
  "release_completion_fence_missing",
);
requireText(
  compose,
  "condition: service_healthy",
  "control_health_fence_missing",
);
requireText(
  compose,
  "http://127.0.0.1:3223/health/ready",
  "worker_readiness_probe_missing",
);
requireText(compose, "/api/v1/health/ready", "control_readiness_probe_missing");
requireText(
  compose,
  "/control-api/health/ready",
  "bff_readiness_probe_missing",
);
requireText(
  runtime,
  "CREWON_RUNTIME_READINESS_FILE=/tmp/crewon-runtime-worker.ready",
  "worker_readiness_file_missing",
);
requireText(
  runtime,
  "CREWON_RUNTIME_OPERATIONAL_PORT=3223",
  "worker_operational_port_missing",
);
requireText(compose, "read_only: true", "readonly_root_missing");
requireText(compose, "no-new-privileges:true", "privilege_fence_missing");
requireText(compose, "cap_drop:", "capability_drop_missing");
requireText(
  compose,
  "CREWON_CONTROL_ENV_FILE:-./control.production.env",
  "control_env_boundary_missing",
);
requireText(
  compose,
  "CREWON_RUNTIME_ENV_FILE:-./runtime.production.env",
  "runtime_env_boundary_missing",
);
requireText(
  compose,
  "CREWON_WEB_BFF_ENV_FILE:-./web-bff.production.env",
  "bff_env_boundary_missing",
);
requireText(
  compose,
  "CREWON_BACKUP_ENV_FILE:-./backup.production.env",
  "backup_env_boundary_missing",
);

for (const [source, forbidden] of [
  [
    control,
    ["OPENAI_API_KEY", "CREWON_WEB_CSRF_SECRET", "CREWON_MODEL_API_KEY"],
  ],
  [
    runtime,
    [
      "CREWON_CONTROL_BFF_TOKEN",
      "CREWON_POLICY_SERVICE_TOKEN",
      "CREWON_WEB_CSRF_SECRET",
    ],
  ],
  [
    bff,
    [
      "CREWON_CONTROL_DATABASE_URL",
      "OPENAI_API_KEY",
      "CREWON_POLICY_SERVICE_TOKEN",
    ],
  ],
  [
    backup,
    [
      "OPENAI_API_KEY",
      "CREWON_MODEL_API_KEY",
      "CREWON_PROVIDER_ROUTE_TOKEN",
      "CREWON_WORKSPACE_ROUTE_TOKEN",
    ],
  ],
]) {
  for (const name of forbidden) {
    forbidText(source, name, `secret_scope_violation:${name}`);
  }
}

requireText(control, "127.0.0.1:3221", "provider_control_route_missing");
requireText(runtime, '"port":3221', "provider_worker_listener_missing");
requireText(control, "127.0.0.1:3222", "workspace_control_route_missing");
requireText(runtime, '"port":3222', "workspace_worker_listener_missing");
requireText(bff, "CREWON_WEB_BFF_PORT=3211", "bff_port_missing");
requireText(control, "CREWON_CONTROL_PORT=3210", "control_port_missing");

for (const name of [
  "CREWON_ARTIFACT_KEY_FILE",
  "CREWON_AGENT_BINDINGS_FILE",
  "CREWON_WORKSPACE_ROOT",
  "CREWON_BACKUP_ENV_FILE",
  "CREWON_BACKUP_ROOT",
  "CREWON_SERVER_RELEASE_MANIFEST_FILE",
  "CREWON_SERVER_RELEASE_SIGNATURE_FILE",
  "CREWON_TLS_CERT_FILE",
  "CREWON_TLS_KEY_FILE",
]) {
  requireText(host, `${name}=`, `host_binding_missing:${name}`);
}

for (const marker of [
  "app-server",
  "6176",
  "CREWON_DEVICE_TOOL_CONFIG_PATH",
  "responsesLite",
  "deterministic-fake",
]) {
  forbidText(
    `${compose}\n${control}\n${runtime}\n${bff}\n${backup}\n${host}`,
    marker,
    `removed_runtime_marker:${marker}`,
  );
}

if (failures.length > 0) {
  throw new Error(`production_topology_gate_failed:${failures.join(",")}`);
}
process.stdout.write("production_topology_gate_passed\n");
