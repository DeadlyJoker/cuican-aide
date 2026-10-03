import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  assertPluginUiHostServiceAvailability,
  assertUiOnlyServiceDeclarations,
  capturePluginUiHostServiceAvailability,
} from "./plugin-ui-host-service-availability.ts";
import { projectGenerationQueryBridgeFixture } from "./plugin-project-generation-query-action-bridge.test-support.ts";
import { PluginProjectGenerationReadActionBridge } from "./plugin-project-generation-read-action-bridge.ts";
import { parsePluginProfileScope } from "@crewon/domain";

test("required query availability exists only on the explicitly assembled owner and exact version/source mapping", async () => {
  const f = await projectGenerationQueryBridgeFixture();
  const candidate = {
    descriptor: f.context.lease.descriptor,
    packageDigest: f.app.sourcePin.packageDigest,
  };
  const scope = parsePluginProfileScope(f.context.scope);
  assert.throws(
    () => assertPluginUiHostServiceAvailability({ scope, candidate }),
    /services_unsupported/u,
  );
  assert.throws(
    () =>
      assertPluginUiHostServiceAvailability({
        scope,
        candidate,
        hostUiServices: { isAvailable: () => true },
      }),
    /services_unsupported/u,
  );
  const actual = f.bridge.hostUiServices();
  assertPluginUiHostServiceAvailability({
    scope,
    candidate,
    hostUiServices: actual,
  });
  f.state.available = false;
  assert.throws(
    () =>
      assertPluginUiHostServiceAvailability({
        scope,
        candidate,
        hostUiServices: actual,
      }),
    /dependency_unavailable/u,
  );
  f.state.available = true;
  f.bridge.close();
  assert.throws(
    () =>
      assertPluginUiHostServiceAvailability({
        scope,
        candidate,
        hostUiServices: actual,
      }),
    /dependency_unavailable/u,
  );
  assert.equal(f.state.calls, 0);
  assert.equal(f.state.currentCalls, 0);
});

test("known optional query declaration without owner permits metadata installation but grants no service", async () => {
  const f = await projectGenerationQueryBridgeFixture();
  const descriptor = parsePluginPackageDescriptor({
    ...f.context.lease.descriptor,
    requires: [
      {
        service: "crewon.project-generation-queries",
        apiVersion: "1",
        optional: true,
      },
    ],
  });
  assertUiOnlyServiceDeclarations(descriptor);
  assertPluginUiHostServiceAvailability({
    scope: f.context.scope,
    candidate: { descriptor, packageDigest: f.app.sourcePin.packageDigest },
  });
  for (const service of [
    "crewon.project-generation-queries",
    "crewon.project-generation-queries-unrecognized",
  ]) {
    const wrong = parsePluginPackageDescriptor({
      ...descriptor,
      requires: [{ service, apiVersion: "2", optional: true }],
    });
    assert.throws(
      () => assertUiOnlyServiceDeclarations(wrong),
      /services_unsupported/u,
    );
  }
  assert.equal(f.state.calls, 0);
  assert.equal(f.state.currentCalls, 0);
});

test("captured availability retains query branding through the saved-history read wrapper", async () => {
  const f = await projectGenerationQueryBridgeFixture();
  const reader = new PluginProjectGenerationReadActionBridge({
    publications: [
      {
        pluginId: f.app.sourcePin.pluginId,
        packageDigest: f.app.sourcePin.packageDigest,
        contributionId: f.app.sourcePin.contributionId,
      },
    ],
    reads: {
      async getConceptGeneration() {
        throw new Error("no-read-on-availability");
      },
      isAvailable: () => false,
    },
  });
  const combined = capturePluginUiHostServiceAvailability(
    reader.hostUiServices(f.bridge.hostUiServices()),
  );
  assertPluginUiHostServiceAvailability({
    scope: f.context.scope,
    candidate: {
      descriptor: f.context.lease.descriptor,
      packageDigest: f.app.sourcePin.packageDigest,
    },
    hostUiServices: combined,
  });
  assert.equal(f.state.calls, 0);
  await reader.close();
});
