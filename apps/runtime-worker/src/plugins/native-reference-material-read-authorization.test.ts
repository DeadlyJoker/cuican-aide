import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectReferenceMaterialReadAuthorizationPort } from "@crewon/application";
import type { ExtensionConfiguration } from "@crewon/domain";
import type { DesktopNativePluginAuthority } from "@crewon/contracts/plugins";
import { createNativeReferenceMaterialReadAuthorization } from "./native-reference-material-read-authorization.ts";

const hash = (letter: string) => `sha256:${letter.repeat(64)}`;
const actor = {
  tenantId: "tenant",
  spaceId: "space",
  principalId: "principal",
  actorId: "actor",
};
const origin = "https://images.example.test:8443/";
const configuration: ExtensionConfiguration = {
  schemaVersion: "crewon.extension-configuration.v0",
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  pluginId: "crewon.short-drama",
  pluginVersion: "50.2.13",
  revision: 24,
  contentDigest: hash("c"),
  manifestDigest: hash("a"),
  implementationDigest: hash("b"),
  parameters: { baseUrl: origin, serviceProtocol: "workflow-api-v1" },
  credentialBindings: [],
  createdByActorId: actor.actorId,
  createdAt: "2026-10-17T00:00:00.000Z",
};
type Permission = Parameters<
  ProjectReferenceMaterialReadAuthorizationPort["authorize"]
>[0];
const permission: Permission = {
  actor,
  action: "projectReferenceMaterial:read",
  resource: {
    projectId: "project",
    assetId: "asset",
    referenceRevision: 1,
    referenceDigest: hash("d"),
    resultLinkDigest: hash("e"),
    sourceBindingDigest: hash("f"),
    pluginId: configuration.pluginId,
    pluginVersion: configuration.pluginVersion,
    packageDigest: hash("1"),
    configurationRevision: configuration.revision,
    configurationDigest: configuration.contentDigest,
    operationId: "operation",
    origin,
    path: "/api/comfy/view?filename=counter.png&subfolder=&type=output",
  },
};
const grant: DesktopNativePluginAuthority["networkGrants"][number] = {
  pluginId: configuration.pluginId,
  publisherId: "crewon",
  version: configuration.pluginVersion,
  packageDigest: hash("1"),
  baseUrlParameter: "baseUrl",
  baseUrl: origin,
  paths: [{ method: "GET", path: "/api/comfy/view" }],
};
function policy(
  c: ExtensionConfiguration | null = configuration,
  grants = [grant],
  current = () => {},
) {
  return createNativeReferenceMaterialReadAuthorization({
    current,
    networkGrants: grants,
    configurations: {
      getConfiguration: async (a, q) => {
        assert.deepEqual(a, actor);
        assert.deepEqual(q, { pluginId: configuration.pluginId, revision: 24 });
        return c;
      },
    },
  });
}
test("the retained source protocol selects only its separately approved read endpoint", async () => {
  for (const protocol of [
    undefined,
    "native",
    "workflow-panel-v1",
    "workflow-api-v1",
  ]) {
    const path =
      protocol === undefined || protocol === "native"
        ? "/view"
        : "/api/comfy/view";
    const p = {
      ...permission,
      resource: {
        ...permission.resource,
        path: path + "?filename=counter.png&subfolder=&type=output",
      },
    };
    const c = {
      ...configuration,
      parameters: {
        baseUrl: origin,
        ...(protocol === undefined ? {} : { serviceProtocol: protocol }),
      },
    };
    assert.deepEqual(
      await policy(c, [
        { ...grant, paths: [{ method: "GET", path }] },
      ]).authorize(p),
      { outcome: "allow" },
    );
    await assert.rejects(
      policy(c, [{ ...grant, paths: [{ method: "POST", path }] }]).authorize(p),
    );
    await assert.rejects(
      policy(c, [
        {
          ...grant,
          paths: [
            {
              method: "GET",
              path: path === "/view" ? "/api/comfy/view" : "/view",
            },
          ],
        },
      ]).authorize(p),
    );
  }
});
test("missing, changed or foreign source configuration cannot inherit a view grant", async () => {
  for (const c of [
    null,
    { ...configuration, revision: 25 },
    { ...configuration, contentDigest: hash("0") },
    { ...configuration, spaceId: "foreign" },
    { ...configuration, pluginVersion: "50.2.14" },
    {
      ...configuration,
      parameters: { baseUrl: origin, serviceProtocol: "future" },
    },
    {
      ...configuration,
      parameters: {
        baseUrl: "https://foreign.test/",
        serviceProtocol: "workflow-api-v1",
      },
    },
  ]) {
    await assert.rejects(policy(c).authorize(permission));
  }
  await assert.rejects(
    policy(configuration, [{ ...grant, packageDigest: hash("2") }]).authorize(
      permission,
    ),
  );
  await assert.rejects(
    policy(configuration, [
      { ...grant, baseUrlParameter: "otherEndpoint" },
    ]).authorize(permission),
  );
  for (const path of [
    "/view?filename=counter.png",
    "//foreign.test/api/comfy/view",
    "/api/comfy/view#fragment",
    "/api/comfy/proxy/history?prompt_id=other",
  ]) {
    await assert.rejects(
      policy().authorize({
        ...permission,
        resource: { ...permission.resource, path },
      }),
    );
  }
});
test("authority withdrawal while reading the configuration denies before network I/O", async () => {
  let checks = 0;
  await assert.rejects(
    policy(configuration, [grant], () => {
      if (++checks === 2) throw Error("authority_withdrawn");
    }).authorize(permission),
    /authority_withdrawn/,
  );
  assert.equal(checks, 2);
});
