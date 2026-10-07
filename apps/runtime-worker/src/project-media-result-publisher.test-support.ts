import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type {
  ProjectMediaResultAuthorizationPort,
  ProjectMediaResultPermission,
} from "@crewon/application";
import { FilesystemProjectMediaResultArchive } from "@crewon/artifacts";
import { ProjectMediaResultPublisher } from "./project-media-result-publisher.ts";
import type { ProjectMediaResultOutputApproval } from "@crewon/media-runtime/project-media-result-publisher";
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";
import { mediaPluginFixture } from "./project-media-plugin-handler.test-support.ts";
import { providerId } from "./project-media-execution.test-support.ts";
import { materialPng } from "./project-material-png.test-support.ts";
import type {
  PinnedHttpRequest,
  PinnedHttpResponse,
} from "./pinned-node-http.ts";
/** Actual installed Short21 handler, original media Run/operation, SQL child and encrypted result files.
 * PDP/review, DNS/provider sockets and private Tool receipt issuer remain named fixtures.
 */
export async function mediaResultFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  kind: "T10" | "D18" = "T10",
  options: {
    generate?: boolean;
    observe?: boolean;
    migrate?: boolean;
    outputApproval?: ProjectMediaResultOutputApproval;
    archiveConfiguration?: (
      scope: import("@crewon/domain").PluginProfileScope,
    ) => ConstructorParameters<typeof FilesystemProjectMediaResultArchive>[0];
  } = {},
) {
  const f = await mediaPluginFixture(t, backend, kind),
    opened = await f.open();
  if (options.generate !== false) {
    await f.invoke(opened, f.makeCommand(opened.runtime));
    f.controls.transport = async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from(
        JSON.stringify({
          [providerId]: {
            status: { status_str: "success", completed: true },
            outputs: {
              [kind === "T10" ? "129" : "17"]: {
                images: [0, 1].map((i) => ({
                  filename: `original-${kind}-${i}.png`,
                  subfolder: "actual-output",
                  type: "output",
                })),
              },
            },
          },
        }),
      ),
    });
    if (options.observe !== false)
      await f.invoke(opened, f.makeCommand(opened.runtime, "media_observe"));
  }
  await opened.close();
  const root = mkdtempSync(join(tmpdir(), "crewon-media-results-")),
    archives: FilesystemProjectMediaResultArchive[] = [],
    publishers: ProjectMediaResultPublisher[] = [];
  t.after(async () => {
    await Promise.all(publishers.map((p) => p.close()));
    for (const a of archives) a.close();
    rmSync(root, { recursive: true, force: true });
  });
  const query = {
      projectId: f.query.projectId,
      runId: f.accepted.binding.runId,
      resultIndex: 0,
    },
    request = { actor: f.actor, query };
  const state: {
    read: boolean;
    publish: boolean;
    active: boolean;
    dns: number;
    gets: number;
    tick: number;
    bytes: Buffer;
    onDns?: () => Promise<void>;
    onGet?: (request: PinnedHttpRequest) => Promise<void>;
    onGrant?: (p: ProjectMediaResultPermission) => Promise<void>;
    onActive?: (p: ProjectMediaResultPermission) => void;
    response?: (r: PinnedHttpResponse) => PinnedHttpResponse;
    requests: PinnedHttpRequest[];
    addresses: readonly { address: string; family: 4 | 6 }[];
  } = {
    read: true,
    publish: true,
    active: true,
    dns: 0,
    gets: 0,
    tick: 0,
    bytes: materialPng(),
    requests: [],
    addresses: [{ address: "8.8.8.8", family: 4 }],
  };
  const authorization: ProjectMediaResultAuthorizationPort = {
    async authorize(p) {
      await state.onGrant?.(p);
      return f.decision(
        p.action === "projectMediaResult:publish" ? state.publish : state.read,
      );
    },
    assertActive(p) {
      state.onActive?.(p);
      if (!state.active) throw new Error("named_media_result_owner_retired");
      if (
        !(p.action === "projectMediaResult:publish"
          ? state.publish
          : state.read)
      )
        throw new Error("named_media_result_permission_revoked");
    },
  };
  const store = f.ext.projectMediaResults();
  if (options.migrate !== false) await store.migrate();
  const archiveConfig = options.archiveConfiguration?.({
    tenantId: f.target.installation.tenantId,
    spaceId: f.target.installation.spaceId,
    profileId: f.target.installation.profileId,
  }) ?? {
    archiveId: "named-real-result-archive",
    rootDirectory: join(root, "bytes"),
    keyId: "named-result-key",
    encryptionKey: Buffer.alloc(32, 82),
  };
  const open = async (currentStore = store) => {
    const archive = new FilesystemProjectMediaResultArchive(archiveConfig);
    archives.push(archive);
    const publisher = new ProjectMediaResultPublisher({
      store: currentStore,
      archive,
      reviews: f.reviews.map(({ targetIdentity, workflow }) => ({
        targetIdentity,
        workflow,
      })),
      authorization,
      outputApproval: options.outputApproval,
      clock: {
        now: () =>
          new Date(Date.UTC(2026, 9, 6, 12, 0, 0, state.tick++)).toISOString(),
      },
      dns: {
        resolveAll: async () => {
          state.dns++;
          await state.onDns?.();
          return state.addresses;
        },
      },
      transport: {
        request: async (r) => {
          state.gets++;
          state.requests.push(r);
          assert.equal(r.method, "GET");
          assert.equal(r.target.endpoint.pathname, "/view");
          await state.onGet?.(r);
          const reply = {
            status: 200,
            headers: {
              "content-type": "image/png",
              "content-length": String(state.bytes.length),
            },
            body: Buffer.from(state.bytes),
          };
          return state.response?.(reply) ?? reply;
        },
      },
    });
    publishers.push(publisher);
    return { publisher, archive };
  };
  const current = await open();
  const authority = (action: "read" | "publish" = "read") => ({
    request,
    action,
    assertCurrent: async () => {
      if (!state.active) throw new Error("named_result_transaction_inactive");
    },
    assertActive: () => {
      if (!state.active) throw new Error("named_result_transaction_inactive");
    },
  });
  const count = async () => {
    const sql = `SELECT count(*) AS n FROM ${f.prefix}project_media_result_candidates`;
    if (backend === "sqlite") {
      const db = new DatabaseSync(f.databasePath, { readOnly: true });
      try {
        return Number(db.prepare(sql).get()!.n);
      } finally {
        db.close();
      }
    }
    const c = new Client({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
    });
    await c.connect();
    try {
      return Number((await c.query(sql)).rows[0].n);
    } finally {
      await c.end();
    }
  };
  return {
    ...f,
    pluginRoot: f.root,
    root,
    query,
    request,
    state,
    authorization,
    store,
    archiveConfig,
    open,
    ...current,
    authority,
    count,
    materialCounts: () => [
      f.state.uploads,
      f.state.sourceGets,
      f.state.targetGets,
    ],
    referenceSource: () =>
      f.resolver().resolveSelectedReference(f.actor, f.query),
  };
}
