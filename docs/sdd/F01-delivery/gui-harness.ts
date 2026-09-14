/** Local synthetic acceptance harness; uses real Control/service/vault and production React components. */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { InMemoryArtifactStore } from "../../../packages/artifacts/src/index.ts";
import { SqliteDeliveryStore } from "../../../packages/store/src/index.ts";
import { createStandaloneControlApi } from "../../../apps/control-api/src/standalone-composition.ts";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const data = path.join(root, ".tmp-f01-gui");
mkdirSync(data, { recursive: true, mode: 0o700 });
const sessionToken = randomBytes(32).toString("hex");
const csrfToken = randomBytes(32).toString("hex");
const origin = "http://127.0.0.1:4560";
const headers = {
  "authorization": `Bearer ${sessionToken}`,
  origin,
  "x-csrf-token": csrfToken,
};
const app = createStandaloneControlApi({
  databasePath: path.join(data, "control.sqlite"),
  deliveryStore: new SqliteDeliveryStore({
    databasePath: path.join(data, "delivery.sqlite"),
    encryptionKey: new Uint8Array(32).fill(42),
  }),
  artifactStore: new InMemoryArtifactStore(),
  artifactEncryptionKeyId: "acceptance-artifacts",
  actor: {
    tenantId: "acceptance",
    spaceId: "local",
    actorId: "user",
    principalId: "user",
  },
  defaultAgentVersionId: "acceptance",
  sessionToken,
  csrfToken,
  allowedOrigins: [origin],
  outboxScanIntervalMs: null,
  automationScanIntervalMs: null,
  heartbeatIntervalMs: null,
}).app;
async function request(
  method: "GET" | "POST",
  url: string,
  payload?: object,
  key?: string,
) {
  const response = await app.inject({
    method,
    url,
    headers: { ...headers, ...(key ? { "idempotency-key": key } : {}) },
    ...(payload ? { payload } : {}),
  });
  if (response.statusCode >= 300) throw new Error(response.body);
  return response.json();
}
const first = await request(
  "POST",
  "/api/v1/threads",
  { title: "F01 合成订单交付验收" },
  "gui-main",
);
const other = await request(
  "POST",
  "/api/v1/threads",
  { title: "F01 隔离任务" },
  "gui-other",
);
const threadId = first.thread.threadId;
for (const name of ["orders-a.csv", "orders-b.csv", "orders-template.xlsx"])
  await request(
    "POST",
    `/api/v1/threads/${threadId}/delivery/inputs`,
    {
      name,
      role: name.endsWith(".xlsx") ? "template" : "data",
      mediaType: name.endsWith(".csv")
        ? "text/csv"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      contentBase64: readFileSync(
        new URL(`./fixtures/${name}`, import.meta.url),
      ).toString("base64"),
    },
    name,
  );
await app.listen({ host: "127.0.0.1", port: 4561 });
const vite = await createServer({
  configFile: false,
  root,
  plugins: [
    react(),
    {
      name: "f01-acceptance-session",
      configureServer(server) {
        server.middlewares.use("/__acceptance/session", (_req, res) => {
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(
            JSON.stringify({
              sessionToken,
              csrfToken,
              origin,
              threadId,
              otherThreadId: other.thread.threadId,
            }),
          );
        });
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 4560,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4561",
        changeOrigin: false,
        headers: { origin },
      },
    },
  },
});
await vite.listen();
process.stdout.write(
  "F01 acceptance: http://127.0.0.1:4560/docs/sdd/F01-delivery/gui.html\n",
);
async function close() {
  await vite.close();
  await app.close();
  process.exit(0);
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
