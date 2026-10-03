import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
  parseInstalledPluginPeerRequest,
} from "@crewon/contracts/plugins";
import { expect, it } from "vitest";
import { automaticPreparationDirectories } from "./desktopInstalledPluginRuntime.automatic.process.test-support.ts";
import {
  assertIsolationTaskRoutesUnavailable,
  isolationActivePublication,
  runIsolationDefaultAgent,
} from "./desktopInstalledPluginRuntime.fault-isolation.test-support.ts";
import {
  assertCandidateDoesNotActivate,
  assertCandidateNoExecution,
  nativeCandidateProcessFixture,
  type CandidateFixture,
} from "./desktopInstalledPluginRuntime.candidate.process.test-support.ts";
import {
  closeNativeProcessFixture,
  nativeBootstrapFiles,
  nativeProcessHttp,
} from "./desktopInstalledPluginRuntime.process.test-support.ts";

const professionalDirectory =
  process.env.CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR;
const kreaDirectory = process.env.CREWON_TEST_KREA_PLUGIN_DIR;
const enabled =
  professionalDirectory !== undefined && kreaDirectory !== undefined;
const krea = "crewon.comfyui-krea2",
  professional = "example.professional";

async function fixture(network: "public" | "private" | "missing" = "public") {
  return nativeCandidateProcessFixture({
    professionalDirectory: professionalDirectory!,
    kreaDirectory: kreaDirectory!,
    network,
  });
}
async function assertDefaultAvailable(f: CandidateFixture) {
  const publication = await isolationActivePublication(f);
  await runIsolationDefaultAgent(
    f,
    f.runtime.session(),
    publication.active.bundle.defaultAgentVersionId,
  );
  await assertIsolationTaskRoutesUnavailable(f, f.runtime.session());
  await assertCandidateNoExecution(f, true);
}

it.runIf(enabled)(
  "actual disabled Native Krea candidate borrows its registered factory and preflights real IO public DNS while professional legacy factory remains compatible, without activating or dispatching",
  async () => {
    const f = await fixture();
    let failure: Readonly<{ error: unknown }> | undefined;
    try {
      await assertCandidateDoesNotActivate(f);
      expect(await f.installedImports()).toEqual([]);
      expect(await f.candidateObservations()).toEqual([]);
      const pro = f.candidate(professional);
      expect(await f.client.prepareCandidate(pro)).toEqual({
        outcome: "ready",
        target: pro.expectedTarget,
      });
      expect(
        f.authority.requests.filter(({ path }) => path === "/network"),
      ).toHaveLength(0);
      expect(
        (await f.candidateObservations()).some(
          ({ event, requiredServices }) =>
            event === "factoryBorrow" && requiredServices?.length === 0,
        ),
      ).toBe(true);
      const input = f.candidate(krea);
      const {
        manifestDigest: _manifest,
        implementationDigest: _implementation,
        ...packageIdentity
      } = input.identity;
      expect(await f.client.prepareCandidate(input)).toEqual({
        outcome: "ready",
        target: input.expectedTarget,
      });
      const network = f.authority.requests.filter(
        ({ path }) => path === "/network",
      );
      expect(network.length).toBeGreaterThan(0);
      for (const { body } of network) {
        expect(body.kind).toBe("readiness");
        expect(body.metadata).toEqual({
          identity: packageIdentity,
          scope: input.scope,
          configuration: input.configuration,
          target: input.expectedTarget,
          purpose: "submit",
        });
      }
      const events = (await f.candidateObservations()).filter(
        ({ pid }) => pid === f.workerPid,
      );
      expect(
        events.some(
          ({ event, requiredServices }) =>
            event === "factoryBorrow" &&
            JSON.stringify(requiredServices) ===
              JSON.stringify(["externalOperations", "jsonHttp"]),
        ),
      ).toBe(true);
      expect(events.some(({ event }) => event === "ioPreflight")).toBe(true);
      const imports = await f.installedImports();
      for (const source of f.sources)
        expect(
          imports.some(
            ({ pid, url }) =>
              pid === f.workerPid &&
              url.includes(
                `/packages/${source.packageDigest.slice(7)}/node.mjs`,
              ),
          ),
        ).toBe(true);
      expect(imports.every(({ pid }) => pid === f.workerPid)).toBe(true);
      await assertCandidateDoesNotActivate(f);
      await assertCandidateNoExecution(f);
      await assertDefaultAvailable(f);
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      await closeNativeProcessFixture(f, failure);
    }
  },
  90_000,
);

for (const unavailable of ["missing", "private"] as const)
  it.runIf(enabled)(
    `actual disabled Native Krea candidate refuses ${unavailable} IO without damaging the default Agent or enabling the selection`,
    async () => {
      const f = await fixture(unavailable);
      let failure: Readonly<{ error: unknown }> | undefined;
      try {
        const result = await f.client.prepareCandidate(f.candidate(krea));
        expect(result).toEqual({
          outcome: "unavailable",
          reasonCode: "extension_runtime_unavailable",
        });
        expect(
          (await f.installedImports()).some(
            ({ pid, url }) =>
              pid === f.workerPid &&
              url.includes(
                `/packages/${f.sources[1]!.packageDigest.slice(7)}/node.mjs`,
              ),
          ),
        ).toBe(true);
        const networkRequests = f.authority.requests.filter(
          ({ path }) => path === "/network",
        ).length;
        if (unavailable === "missing") expect(networkRequests).toBe(0);
        else expect(networkRequests).toBeGreaterThan(0);
        await assertCandidateDoesNotActivate(f);
        await assertDefaultAvailable(f);
      } catch (error) {
        failure = { error };
        throw error;
      } finally {
        await closeNativeProcessFixture(f, failure);
      }
    },
    90_000,
  );

for (const withdrawn of ["network", "package"] as const)
  it.runIf(enabled)(
    `actual current ${withdrawn} withdrawal invalidates a previously ready disabled Native candidate while default streaming remains available`,
    async () => {
      const f = await fixture();
      let failure: Readonly<{ error: unknown }> | undefined;
      try {
        const input = f.candidate(krea);
        expect(await f.client.prepareCandidate(input)).toEqual({
          outcome: "ready",
          target: input.expectedTarget,
        });
        if (withdrawn === "network") f.authority.denyNetwork();
        else f.authority.denyPackage();
        expect(await f.client.prepareCandidate(input)).toEqual({
          outcome: "unavailable",
          reasonCode: "extension_runtime_unavailable",
        });
        await assertCandidateDoesNotActivate(f);
        await assertDefaultAvailable(f);
      } catch (error) {
        failure = { error };
        throw error;
      } finally {
        await closeNativeProcessFixture(f, failure);
      }
    },
    90_000,
  );

for (const changed of ["configuration", "selection"] as const)
  it.runIf(enabled)(
    `actual HTTP ${changed} CAS during a real pending candidate IO body rejects the old disabled candidate without activation or default regression`,
    async () => {
      const f = await fixture();
      const gate = f.authority.holdNextNetwork();
      let pending: Promise<unknown> | null = null;
      let failure: Readonly<{ error: unknown }> | undefined;
      try {
        const input = f.candidate(krea);
        pending = f.client.prepareCandidate(input).then(
          (result) => result,
          (error: unknown) => error,
        );
        await Promise.race([
          gate.entered,
          pending.then((result) => {
            throw result ?? new Error("candidate_finished_before_real_io_gate");
          }),
        ]);
        const response = await nativeProcessHttp(
          f.runtime.session(),
          "PUT",
          changed === "configuration"
            ? `/api/v1/extensions/${krea}/configuration`
            : `/api/v1/plugins/selections/${krea}`,
          changed === "configuration"
            ? {
                pluginVersion: "1.0.0",
                expectedRevision: 1,
                parameters: { baseUrl: "https://8.8.4.4/" },
                credentialBindings: [],
              }
            : {
                expectedSelectionRevision: 1,
                selectedPackageDigest: f.sources[1]!.packageDigest,
                state: "disabled",
              },
          `candidate-race-${changed}`,
        );
        expect(response.status, await response.clone().text()).toBe(200);
        gate.release();
        const result = await pending;
        if (result instanceof Error)
          expect((result as Error & { code: string }).code).toBe(
            "installed_plugin_peer_unavailable",
          );
        else
          expect(result).toEqual({
            outcome: "unavailable",
            reasonCode: "extension_runtime_unavailable",
          });
        if (changed === "selection")
          expect(
            await f.client.prepareCandidate({
              ...input,
              expectedSelectionRevision: 2,
            }),
          ).toEqual({ outcome: "ready", target: input.expectedTarget });
        const activation = await nativeProcessHttp(
          f.runtime.session(),
          "GET",
          `/api/v1/extensions/${krea}/activation`,
        );
        expect(activation.status).toBe(200);
        expect((await activation.json()).activation).toBe(null);
        await assertDefaultAvailable(f);
      } catch (error) {
        failure = { error };
        throw error;
      } finally {
        gate.release();
        await pending?.catch(() => {});
        await closeNativeProcessFixture(f, failure);
      }
    },
    90_000,
  );

it.runIf(enabled)(
  "actual private Worker refuses a valid-shaped corrupted Native candidate identity before importing installed Node and retains the default Agent",
  async () => {
    const f = await fixture();
    let failure: Readonly<{ error: unknown }> | undefined;
    try {
      const input = f.candidate(krea);
      const request = parseInstalledPluginPeerRequest({
        protocol: INSTALLED_PLUGIN_PEER_REQUEST_PROTOCOL,
        requestId: randomUUID(),
        operation: "prepareCandidate",
        ...input,
        identity: {
          ...input.identity,
          implementationDigest: "sha256:" + "f".repeat(64),
        },
      });
      await expect(f.transport.post(request)).rejects.toMatchObject({
        code: "installed_plugin_peer_authentication_failed",
      });
      expect(await f.installedImports()).toEqual([]);
      await assertCandidateDoesNotActivate(f);
      await assertDefaultAvailable(f);
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      await closeNativeProcessFixture(f, failure);
    }
  },
  90_000,
);

it.runIf(enabled)(
  "actual Native stop closes a candidate waiting on its real HTTPS IO body and joins the Worker before retiring private preparation, then restart prepares the same disabled candidate",
  async () => {
    const f = await fixture();
    const gate = f.authority.holdNextNetwork();
    let pending: Promise<unknown> | null = null;
    let failure: Readonly<{ error: unknown }> | undefined;
    try {
      const input = f.candidate(krea);
      pending = f.client.prepareCandidate(input).then(
        (result) => result,
        (error: unknown) => error,
      );
      await Promise.race([
        gate.entered,
        pending.then((result) => {
          throw result ?? new Error("candidate_finished_before_real_io_gate");
        }),
      ]);
      expect(await f.preparationSnapshot()).toEqual(f.preparation);
      expect(await nativeBootstrapFiles(f.dataDirectory)).toHaveLength(1);
      expect(() => process.kill(f.workerPid, 0)).not.toThrow();
      await f.runtime.stop();
      assert.throws(() => process.kill(f.workerPid, 0), { code: "ESRCH" });
      expect(gate.socketClosed()).toBe(true);
      expect(await pending).toBeInstanceOf(Error);
      const events = (await f.candidateObservations()).filter(
        ({ pid }) => pid === f.workerPid,
      );
      expect(events.some(({ event }) => event === "ioClosing")).toBe(true);
      expect(events.some(({ event }) => event === "ioClosed")).toBe(true);
      expect(await automaticPreparationDirectories(f.dataDirectory)).toEqual(
        [],
      );
      expect(await nativeBootstrapFiles(f.dataDirectory)).toEqual([]);
      gate.release();
      const replacement = await f.start();
      expect(replacement.preparation.directory).not.toBe(
        f.preparation.directory,
      );
      expect(replacement.preparation.document).toEqual(f.preparation.document);
      expect(await replacement.client.prepareCandidate(input)).toEqual({
        outcome: "ready",
        target: input.expectedTarget,
      });
      await assertDefaultAvailable(f);
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      gate.release();
      await pending?.catch(() => {});
      await closeNativeProcessFixture(f, failure);
    }
  },
  120_000,
);
