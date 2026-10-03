import assert from "node:assert/strict";
import { createServer, request as httpsRequest } from "node:https";
import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import type { ActorContext } from "@crewon/application";
import type {
  OpenPluginUiMountResponse,
  PluginInstallationResponse,
  PluginSelectionResponse,
} from "@crewon/contracts";
import {
  parseCreativeProjectUiActionRequest,
  parseCreativeProjectUiActionResponse,
  type CreativeProjectUiAction,
  type CreativeProjectUiInputMap,
  type CreativeProjectUiResponseMap,
} from "@crewon/contracts/plugins";
import {
  TEST_CA_CERT,
  TEST_SERVER_CERT,
  TEST_SERVER_KEY,
} from "../../device-gateway/src/mtls-test-certificates.test-support.ts";
import { HttpControlTokenVerifier } from "./production-http-security-ports.ts";
import {
  PRODUCTION_BFF_AUTHORIZATION_HEADER,
  ProductionControlApiIdentity,
  StaticTrustedBffRequestVerifier,
} from "./production-security-adapters.ts";
import {
  pluginRouteActor,
  pluginRouteCredentials,
  pluginRouteHeaders,
  pluginRouteScope,
} from "./plugin-control-route.test-support.ts";

export const projectPluginDisabledScans = Object.freeze({
  heartbeatIntervalMs: null,
  outboxScanIntervalMs: null,
  outboxRetention: null,
  artifactRetention: null,
  automationScanIntervalMs: null,
});
export type ProjectPluginPackage = Readonly<{
  sourceId: string;
  pluginId: string;
  publisherId: string;
  packageDigest: string;
}>;

/** Real Control routes are the only adapter used by this metadata workflow. */
export function projectPluginHarness(
  app: () => FastifyInstance,
  headers: Readonly<Record<string, string>>,
) {
  const request = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: object,
    key?: string,
  ) =>
    app().inject({
      method,
      url,
      headers: {
        ...headers,
        ...(key === undefined ? {} : { "idempotency-key": key }),
      },
      ...(payload === undefined ? {} : { payload }),
    });
  const mount = async (pkg: ProjectPluginPackage, revision: number) => {
    const response = await request("POST", "/api/v1/plugins/ui/mounts", {
      pluginId: pkg.pluginId,
      contributionId: "workbench",
      expectedSelectionRevision: revision,
      expectedPackageDigest: pkg.packageDigest,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<OpenPluginUiMountResponse>();
  };
  const install = async (pkg: ProjectPluginPackage, key = pkg.sourceId) => {
    const installed = await request(
      "POST",
      "/api/v1/plugins/installations",
      {
        sourceId: pkg.sourceId,
        expectedPluginId: pkg.pluginId,
        expectedPackageDigest: pkg.packageDigest,
        expectedSelectionRevision: null,
      },
      `install-${key}`,
    );
    assert.equal(installed.statusCode, 200, installed.body);
    const result = installed.json<PluginInstallationResponse>();
    assert.equal(result.selection.state, "disabled");
    return result;
  };
  const enable = async (pkg: ProjectPluginPackage, key = pkg.sourceId) => {
    const selected = await request(
      "PUT",
      `/api/v1/plugins/selections/${encodeURIComponent(pkg.pluginId)}`,
      {
        expectedSelectionRevision: 1,
        state: "enabled",
        selectedPackageDigest: pkg.packageDigest,
      },
      `enable-${key}`,
    );
    assert.equal(selected.statusCode, 200, selected.body);
    const result = selected.json<PluginSelectionResponse>();
    assert.equal(result.projection.outcome, "applied");
    assert.equal(result.mutation.selection.state, "enabled");
    return mount(pkg, result.mutation.selection.revision);
  };
  const invoke = async <Action extends CreativeProjectUiAction>(
    lease: OpenPluginUiMountResponse,
    action: Action,
    input: CreativeProjectUiInputMap[Action],
  ): Promise<CreativeProjectUiResponseMap[Action]> => {
    const command = parseCreativeProjectUiActionRequest({ action, input });
    const reply = await request(
      "POST",
      `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      command,
    );
    assert.equal(reply.statusCode, 200, reply.body);
    return parseCreativeProjectUiActionResponse(
      command,
      reply.json().output,
    ) as CreativeProjectUiResponseMap[Action];
  };
  return { request, install, enable, mount, invoke };
}
export type ProjectPluginHarness = ReturnType<typeof projectPluginHarness>;

export async function savePluginProjectHistory(
  f: ProjectPluginHarness,
  lease: OpenPluginUiMountResponse,
) {
  const createInput = {
    request: { title: "保存前的短剧", briefText: "第一版：雨夜收到一封信。" },
    idempotencyKey: "project-create-once",
  };
  const created = await f.invoke(
    lease,
    "crewon.creative-projects.v1.createProject",
    createInput,
  );
  assert.equal(created.disposition, "committed");
  const projectId = created.project.projectId;
  const renameInput = {
    projectId,
    request: {
      title: "未寄出的信",
      expectedProjectRevision: created.project.revision,
    },
    idempotencyKey: "project-rename-once",
  };
  const renamed = await f.invoke(
    lease,
    "crewon.creative-projects.v1.renameProject",
    renameInput,
  );
  const briefInput = {
    projectId,
    request: {
      text: "第二版：窗边读信，结尾留白。",
      expectedProjectRevision: renamed.project.revision,
    },
    idempotencyKey: "brief-append-once",
  };
  const brief = await f.invoke(
    lease,
    "crewon.creative-projects.v1.appendBrief",
    briefInput,
  );
  const conceptInput = {
    projectId,
    request: {
      briefRevision: 1,
      name: "窗边的信",
      prompt: "雨夜，窗边，暖色灯光。",
      expectedProjectRevision: brief.project.revision,
    },
    idempotencyKey: "concept-create-once",
  };
  const concept = await f.invoke(
    lease,
    "crewon.creative-projects.v1.createConcept",
    conceptInput,
  );
  const revisionInput = {
    projectId,
    assetId: concept.asset.assetId,
    request: {
      briefRevision: 2,
      prompt: "清晨，窗边，信封特写。",
      expectedProjectRevision: concept.project.revision,
      expectedAssetMetadataRevision: concept.asset.revision,
    },
    idempotencyKey: "concept-revision-once",
  };
  const revision = await f.invoke(
    lease,
    "crewon.creative-projects.v1.appendConceptRevision",
    revisionInput,
  );
  assert.equal(revision.assetRevision.assetRevision, 2);
  assert.equal(
    revision.assetRevision.briefContentDigest,
    brief.brief.contentDigest,
  );
  for (const [action, input, original] of [
    ["crewon.creative-projects.v1.renameProject", renameInput, renamed],
    ["crewon.creative-projects.v1.appendBrief", briefInput, brief],
    ["crewon.creative-projects.v1.createConcept", conceptInput, concept],
    [
      "crewon.creative-projects.v1.appendConceptRevision",
      revisionInput,
      revision,
    ],
  ] as const) {
    assert.deepEqual(await f.invoke(lease, action, input), {
      ...original,
      disposition: "replayed",
    });
  }
  const archived = await f.invoke(
    lease,
    "crewon.creative-projects.v1.setProjectState",
    {
      projectId,
      request: {
        state: "archived",
        expectedProjectRevision: revision.project.revision,
      },
      idempotencyKey: "project-archive-once",
    },
  );
  assert.equal(
    (
      await f.invoke(lease, "crewon.creative-projects.v1.listProjects", {
        query: {},
      })
    ).projects.length,
    0,
  );
  assert.deepEqual(
    (
      await f.invoke(lease, "crewon.creative-projects.v1.listProjects", {
        query: { state: "archived" },
      })
    ).projects,
    [archived.project],
  );
  const restored = await f.invoke(
    lease,
    "crewon.creative-projects.v1.setProjectState",
    {
      projectId,
      request: {
        state: "active",
        expectedProjectRevision: archived.project.revision,
      },
      idempotencyKey: "project-restore-once",
    },
  );
  return {
    createInput,
    created,
    renamed,
    brief,
    concept,
    revision,
    project: restored.project,
  };
}
export type SavedPluginProjectHistory = Awaited<
  ReturnType<typeof savePluginProjectHistory>
>;

export async function assertPluginProjectHistory(
  f: ProjectPluginHarness,
  lease: OpenPluginUiMountResponse,
  saved: SavedPluginProjectHistory,
) {
  const projectId = saved.project.projectId;
  const assetId = saved.concept.asset.assetId;
  assert.deepEqual(
    await f.invoke(lease, "crewon.creative-projects.v1.getProject", {
      projectId,
    }),
    { project: saved.project },
  );
  assert.deepEqual(
    (
      await f.invoke(lease, "crewon.creative-projects.v1.listProjects", {
        query: {},
      })
    ).projects,
    [saved.project],
  );
  assert.deepEqual(
    await f.invoke(lease, "crewon.creative-projects.v1.getBrief", {
      projectId,
      briefRevision: 1,
    }),
    { brief: saved.created.brief },
  );
  assert.deepEqual(
    await f.invoke(lease, "crewon.creative-projects.v1.getBrief", {
      projectId,
      briefRevision: 2,
    }),
    { brief: saved.brief.brief },
  );
  assert.deepEqual(
    (
      await f.invoke(lease, "crewon.creative-projects.v1.listBriefs", {
        projectId,
        query: {},
      })
    ).briefs,
    [saved.created.brief, saved.brief.brief],
  );
  assert.deepEqual(
    await f.invoke(lease, "crewon.creative-projects.v1.getConceptAsset", {
      projectId,
      assetId,
    }),
    { asset: saved.revision.asset },
  );
  assert.deepEqual(
    (
      await f.invoke(lease, "crewon.creative-projects.v1.listConceptAssets", {
        projectId,
        query: {},
      })
    ).assets,
    [saved.revision.asset],
  );
  assert.deepEqual(
    await f.invoke(lease, "crewon.creative-projects.v1.getConceptRevision", {
      projectId,
      assetId,
      assetRevision: 1,
    }),
    { assetRevision: saved.concept.assetRevision },
  );
  assert.deepEqual(
    await f.invoke(lease, "crewon.creative-projects.v1.getConceptRevision", {
      projectId,
      assetId,
      assetRevision: 2,
    }),
    { assetRevision: saved.revision.assetRevision },
  );
  assert.deepEqual(
    (
      await f.invoke(
        lease,
        "crewon.creative-projects.v1.listConceptRevisions",
        { projectId, assetId, query: {} },
      )
    ).revisions,
    [saved.concept.assetRevision, saved.revision.assetRevision],
  );
  assert.deepEqual(
    await f.invoke(
      lease,
      "crewon.creative-projects.v1.createProject",
      saved.createInput,
    ),
    { ...saved.created, disposition: "replayed" },
  );
}

/** Test identity/profile/PDP authorities serve actual TLS requests; they create no users or funds. */
export async function projectPluginHttpsAuthorities(t: TestContext) {
  const tokens = {
    verify: "v".repeat(48),
    profile: "p".repeat(48),
    policy: "d".repeat(48),
  };
  const state = {
    actor: { ...pluginRouteActor } as ActorContext,
    profileId: pluginRouteScope.profileId as string,
    deny: false,
    foreignProfile: false,
    profileReplies: [] as string[],
    revokedToken: false,
    epoch: "creative-project-test-grant-v1",
    requests: [] as { path: string; body: Record<string, unknown> }[],
  };
  const server = createServer(
    { key: TEST_SERVER_KEY, cert: TEST_SERVER_CERT, minVersion: "TLSv1.3" },
    async (req, res) => {
      assert.equal(
        (req.socket as import("node:tls").TLSSocket).getProtocol(),
        "TLSv1.3",
      );
      const path = req.url;
      assert.ok(
        path === "/verify" || path === "/profile" || path === "/policy",
      );
      assert.equal(req.method, "POST");
      assert.equal(
        req.headers.authorization,
        `Bearer ${tokens[path.slice(1) as keyof typeof tokens]}`,
      );
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      assert.ok(bytes.byteLength <= 16 * 1024);
      const body = JSON.parse(bytes.toString("utf8")) as Record<
        string,
        unknown
      >;
      state.requests.push({ path, body });
      res.setHeader("content-type", "application/json");
      if (path === "/verify") {
        assert.equal(body.accessToken, pluginRouteCredentials.sessionToken);
        if (state.revokedToken) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: "test_identity_revoked" }));
          return;
        }
        const now = Date.now();
        res.end(
          JSON.stringify({
            ...state.actor,
            issuer: "https://identity.project-test.example",
            audience: "crewon-control",
            issuedAt: new Date(now - 1000).toISOString(),
            expiresAt: new Date(now + 60_000).toISOString(),
          }),
        );
      } else if (path === "/profile") {
        assert.deepEqual(body.actor, state.actor);
        res.end(
          JSON.stringify({
            tenantId: state.actor.tenantId,
            spaceId: state.foreignProfile
              ? "foreign-space"
              : state.actor.spaceId,
            profileId: state.profileReplies.shift() ?? state.profileId,
          }),
        );
      } else {
        assert.deepEqual(body.actor, state.actor);
        res.end(
          JSON.stringify(
            state.deny
              ? { outcome: "deny", reasonCode: "test_plugin_policy_revoked" }
              : { outcome: "allow", authorityEpoch: state.epoch },
          ),
        );
      }
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `https://localhost:${address.port}`;
  // The transport adapter changes only CA trust/loopback DNS, preserving real HTTP and signals.
  const fetch: typeof globalThis.fetch = async (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.origin, origin);
      const req = httpsRequest(
        url,
        {
          method: init?.method,
          headers: init?.headers as Record<string, string>,
          ca: TEST_CA_CERT,
          family: 4,
          signal: init?.signal ?? undefined,
          lookup: (_hostname, _options, callback) =>
            callback(null, "127.0.0.1", 4),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("error", reject);
          res.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: {
                  "content-type": String(res.headers["content-type"]),
                },
              }),
            ),
          );
        },
      );
      req.on("error", reject);
      req.end(init?.body as string | undefined);
    });
  const bffToken = "b".repeat(48);
  const identity = new ProductionControlApiIdentity({
    trustedBff: new StaticTrustedBffRequestVerifier({
      serviceToken: bffToken,
      allowedOrigins: [pluginRouteCredentials.origin],
      allowedRemoteAddresses: ["127.0.0.1"],
    }),
    tokens: new HttpControlTokenVerifier({
      url: `${origin}/verify`,
      serviceToken: tokens.verify,
      fetch,
    }),
    expectedIssuer: "https://identity.project-test.example",
    expectedAudience: "crewon-control",
    timeoutMs: 2000,
    cacheTtlMs: 0,
  });
  return {
    state,
    fetch,
    identity,
    headers: {
      ...pluginRouteHeaders,
      [PRODUCTION_BFF_AUTHORIZATION_HEADER]: `Bearer ${bffToken}`,
    },
    profileAuthority: {
      url: `${origin}/profile`,
      serviceToken: tokens.profile,
    },
    policyAuthority: { url: `${origin}/policy`, serviceToken: tokens.policy },
  };
}
