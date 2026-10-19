import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";
import type { TestContext } from "node:test";
import {
  CreativeProjectApplicationService,
  ProjectAssetApplicationService,
  ProjectAssetReferenceImageApplicationService,
  PluginInstallationApplicationService,
  ExtensionConfigurationApplicationService,
  ProjectMaterialTargetApplicationService,
  type ProjectMaterialPreparationAuthorizationPort,
  type AuthorizationDecision,
} from "@crewon/application";
import { FilesystemProjectMaterialArchive } from "@crewon/artifacts";
import {
  materialPreparationFixture,
  materialPreparationAt,
} from "../../../packages/store/src/project-material-preparation.test-support.ts";
import { selectionVerifier } from "../../../packages/store/src/project-concept-selection.test-support.ts";
import { ProjectReferenceMaterialReader } from "./project-reference-material-reader.ts";
import { ProjectReferenceMaterialFreezer } from "./project-reference-material-freezer.ts";
import {
  ProjectMaterialPreparer,
  type PrepareProjectMaterialInput,
} from "./project-material-preparer.ts";
import { materialPng } from "./project-material-png.test-support.ts";
import type {
  PinnedHttpRequest,
  PinnedHttpResponse,
} from "./pinned-node-http.ts";
import type { ProjectMaterialTargetIdentity } from "./project-material-preparation-support.ts";

const digester = {
  sha256: (text: string) =>
    `sha256:${createHash("sha256").update(text).digest("hex")}`,
};
/** Real project/Run/selected source, installed target/config, SQL journal and encrypted PNG archive.
 * External PDP/profile/deployment review, DNS and provider socket responses are named fixtures.
 * No Main/UI/Agent or generation Run acceptance is claimed by these integration tests.
 */
export async function projectMaterialPreparerFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  options: {
    serviceProtocol?: "native" | "workflow-panel-v1" | "workflow-api-v1";
    targetFixture?: import("../../../packages/store/src/project-material-preparation.test-support.ts").MaterialTargetFixture;
  } = {},
) {
  const f = await materialPreparationFixture(t, backend, options),
    root = mkdtempSync(join(tmpdir(), "crewon-material-preparer-")),
    archives: FilesystemProjectMaterialArchive[] = [];
  t.after(() => {
    for (const archive of archives) archive.close();
    rmSync(root, { recursive: true, force: true });
  });
  const state: {
    bytes: Buffer;
    sourceGets: number;
    uploads: number;
    targetGets: number;
    dnsCalls: number;
    tick: number;
    prepareAllowed: boolean;
    uploadAllowed: boolean;
    observeAllowed: boolean;
    readAllowed: boolean;
    freezeAllowed: boolean;
    installationAllowed: boolean;
    configurationAllowed: boolean;
    active: boolean;
    profileId: string;
    files: Map<string, Buffer>;
    grants: Parameters<
      ProjectMaterialPreparationAuthorizationPort["authorize"]
    >[0][];
    requests: PinnedHttpRequest[];
    onPost?: () => Promise<void>;
    onGet?: () => Promise<void>;
    onDns?: () => Promise<void>;
    onAuthorize?: (
      input: Parameters<
        ProjectMaterialPreparationAuthorizationPort["authorize"]
      >[0],
    ) => Promise<void>;
    reply?: (expected: PinnedHttpResponse) => PinnedHttpResponse;
  } = {
    bytes: materialPng(),
    sourceGets: 0,
    uploads: 0,
    targetGets: 0,
    dnsCalls: 0,
    tick: 0,
    prepareAllowed: true,
    uploadAllowed: true,
    observeAllowed: true,
    readAllowed: true,
    freezeAllowed: true,
    installationAllowed: true,
    configurationAllowed: true,
    active: true,
    profileId: f.target.installation.profileId,
    files: new Map(),
    grants: [],
    requests: [],
  };
  const now = () =>
    new Date(Date.parse(materialPreparationAt) + state.tick++).toISOString();
  const decision = (allow: boolean): AuthorizationDecision =>
    allow
      ? { outcome: "allow" }
      : { outcome: "deny", reasonCode: "named_media_permission_denied" };
  const reviewedTarget: ProjectMaterialTargetIdentity = {
    pluginId: "crewon.short-drama",
    version: f.target.package.version,
    publisherId: f.target.package.publisherId,
    packageDigest: f.target.package.packageDigest,
    manifestDigest: f.target.configuration.manifestDigest,
    implementationDigest: f.target.configuration.implementationDigest,
  };
  const authorization: ProjectMaterialPreparationAuthorizationPort = {
    async authorize(input) {
      state.grants.push(input);
      await state.onAuthorize?.(input);
      return decision(
        input.action === "projectMaterial:prepare"
          ? state.prepareAllowed
          : input.action === "projectMaterial:upload"
            ? state.uploadAllowed
            : state.observeAllowed,
      );
    },
    assertActive({ request }) {
      if (!state.active || request.target.profileId !== state.profileId)
        throw new Error("named_material_owner_retired");
    },
  };
  const unused = async (): Promise<never> => {
    throw new Error("named_unused_mutation_host");
  };
  const archiveConfiguration = {
    archiveId: "actual-project-source-archive",
    rootDirectory: root,
    encryptionKey: Buffer.alloc(32, 86),
    keyId: "named-material-test-key",
  };
  const open = (parent = f.first.parent, identities = [reviewedTarget]) => {
    const common = {
        authorization: { authorize: async () => decision(f.policy.allow) },
        clock: { now },
        digester,
        ids: { nextId: () => randomUUID() },
      },
      assetStore = parent.projectAssetStore({ verifier: selectionVerifier }),
      projects = new CreativeProjectApplicationService({
        ...common,
        store: parent.creativeProjectStore(),
      }),
      assets = new ProjectAssetApplicationService({
        ...common,
        store: assetStore,
        projects: parent.creativeProjectStore(),
        texts: parent.projectTextStore(),
      }),
      sources = new ProjectAssetReferenceImageApplicationService({
        projects,
        assets,
        store: assetStore,
        digester,
      }),
      installations = new PluginInstallationApplicationService({
        store: parent.pluginInstallationStore(),
        profiles: {
          resolve: async () => ({
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            profileId: state.profileId,
          }),
        },
        authorization: {
          authorize: async () => decision(state.installationAllowed),
        },
        host: { install: unused, prepareSelection: unused },
        clock: { now },
        digester,
      }),
      configurations = new ExtensionConfigurationApplicationService({
        store: parent.extensionStore(),
        catalog: { list: () => [], resolve: () => null },
        host: { validateConfiguration: unused, evaluate: unused },
        authorization: {
          authorize: async () => decision(state.configurationAllowed),
        },
        clock: { now },
        digester,
      }),
      targets = new ProjectMaterialTargetApplicationService({
        installations,
        configurations,
      }),
      archive = new FilesystemProjectMaterialArchive(archiveConfiguration);
    archives.push(archive);
    const reader = new ProjectReferenceMaterialReader({
        sources,
        adapter: {
          deriveReadDestination(source) {
            const url = new URL(source.resultLink.image.url);
            return {
              origin: url.origin + "/",
              path: url.pathname + url.search,
              output: {
                filename: source.resultLink.image.filename,
                subfolder: "named-source-output",
                type: "output",
              },
            };
          },
        },
        authorization: { authorize: async () => decision(state.readAllowed) },
        clock: { now },
        dns: { resolveAll: async () => [{ address: "8.8.8.8", family: 4 }] },
        transport: {
          request: async () => {
            state.sourceGets++;
            return {
              status: 200,
              headers: { "content-type": "image/png" },
              body: Buffer.from(state.bytes),
            };
          },
        },
      }),
      freezer = new ProjectReferenceMaterialFreezer({
        sources,
        reader,
        archive,
        authorization: { authorize: async () => decision(state.freezeAllowed) },
      }),
      journal = assetStore.projectMaterialPreparationStore();
    const dependencies = {
      freezer,
      targets,
      journal,
      reviewedTargets: identities,
      authorization,
      clock: { now },
      dns: {
        resolveAll: async () => {
          state.dnsCalls++;
          await state.onDns?.();
          return [{ address: "8.8.8.8", family: 4 as const }];
        },
      },
      uploadTransport: {
        async request(request: PinnedHttpRequest): Promise<PinnedHttpResponse> {
          state.uploads++;
          state.requests.push(request);
          assert.equal(request.method, "POST");
          const workflowApi =
            options.serviceProtocol === "workflow-panel-v1" ||
            options.serviceProtocol === "workflow-api-v1";
          assert.equal(
            request.target.endpoint.pathname,
            workflowApi ? "/api/comfy/upload/file" : "/upload/image",
          );
          assert.equal(request.target.address, "8.8.8.8");
          const body = Buffer.from(request.body!),
            boundary = request.headers!["content-type"]!.split("boundary=")[1]!,
            name = /name="(?:image|file)"; filename="([^"\r\n]+)"/u.exec(
              body.toString("latin1"),
            )![1]!,
            subfolder = workflowApi
              ? ""
              : /name="subfolder"\r\n\r\n([^\r\n]+)/u.exec(
                  body.toString("latin1"),
                )![1]!,
            imageStart =
              body.indexOf(Buffer.from("Content-Type: image/png\r\n\r\n")) +
              Buffer.byteLength("Content-Type: image/png\r\n\r\n"),
            imageEnd = body.indexOf(
              Buffer.from(`\r\n--${boundary}--`),
              imageStart,
            ),
            output = {
              filename: name,
              subfolder,
              type: workflowApi ? "input" : "output",
            };
          assert.ok(imageStart > 0 && imageEnd > imageStart);
          state.files.set(
            `${workflowApi ? "/api/comfy/view" : "/view"}?${new URLSearchParams(output)}`,
            Buffer.from(body.subarray(imageStart, imageEnd)),
          );
          await state.onPost?.();
          const response = {
            status: 200,
            headers: { "content-type": "application/json" },
            body: Buffer.from(
              JSON.stringify({ name, subfolder, type: output.type }),
            ),
          };
          return state.reply?.(response) ?? response;
        },
      },
      observationTransport: {
        async request(request: PinnedHttpRequest): Promise<PinnedHttpResponse> {
          state.targetGets++;
          state.requests.push(request);
          assert.equal(request.method, "GET");
          assert.equal(request.target.address, "8.8.8.8");
          await state.onGet?.();
          const bytes = state.files.get(
            request.target.endpoint.pathname + request.target.endpoint.search,
          );
          return bytes
            ? {
                status: 200,
                headers: {
                  "content-type": "image/png",
                  "content-length": String(bytes.length),
                },
                body: Buffer.from(bytes),
              }
            : { status: 404, headers: {}, body: Buffer.alloc(0) };
        },
      },
    };
    return {
      parent,
      archive,
      sources,
      reader,
      freezer,
      installations,
      configurations,
      targets,
      journal,
      dependencies,
      preparer: new ProjectMaterialPreparer(dependencies),
    };
  };
  const opened = open(),
    input: PrepareProjectMaterialInput = {
      source: {
        query: f.request.source.query,
        idempotencyKey: f.request.source.idempotencyKey,
      },
      target: f.request.target,
      idempotencyKey: f.request.idempotencyKey,
    };
  const cold = async () => {
    const next = await f.openJournal();
    return open(next.parent);
  };
  // Inspect physical state without a current-source qualification; never fabricate rows.
  const headPhases = async () => {
    const sql = `SELECT phase FROM ${f.prefix}project_material_preparation_heads`;
    if (backend === "sqlite") {
      const db = new DatabaseSync(f.databasePath, { readOnly: true });
      try {
        return db
          .prepare(sql)
          .all()
          .map((row) => row.phase);
      } finally {
        db.close();
      }
    }
    const client = new Client({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
    });
    await client.connect();
    try {
      return (await client.query(sql)).rows.map(
        (row: { phase: string }) => row.phase,
      );
    } finally {
      await client.end();
    }
  };
  return {
    ...f,
    ...opened,
    root,
    archiveConfiguration,
    state,
    input,
    open,
    cold,
    headPhases,
    reviewedTarget,
    authorization,
    decision,
    digester,
  };
}
export const materialSignal = () => ({ signal: new AbortController().signal });
