import type { TestContext } from "node:test";
import {
  ProjectAssetMediaAdoptionApplicationService,
  ProjectAssetV2ApplicationService,
  type ProjectAssetMediaAdoptionPermission,
} from "@crewon/application";
import { assetMediaAdoptionFixture } from "./project-asset-media-adoption.test-support.ts";

export async function mediaAdoptionServiceFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await assetMediaAdoptionFixture(t, backend),
    policy = {
      denied: null as ProjectAssetMediaAdoptionPermission["action"] | null,
      active: true,
      checks: [] as ProjectAssetMediaAdoptionPermission[],
      transactionChecks: [] as ProjectAssetMediaAdoptionPermission[],
    };
  const authorization = {
    authorize: async (p: ProjectAssetMediaAdoptionPermission) => {
      policy.checks.push(p);
      return f.decision(policy.denied !== p.action);
    },
    authorizeTransaction: async (p: ProjectAssetMediaAdoptionPermission) => {
      policy.transactionChecks.push(p);
      return f.decision(policy.denied !== p.action);
    },
    assertActive: () => {
      if (!policy.active) throw new Error("named_adoption_policy_retired");
    },
  };
  const openService = (store = f.store) => {
    const adoptions = new ProjectAssetMediaAdoptionApplicationService({
      store,
      authorization,
      clock: { now: () => f.at },
    });
    return {
      adoptions,
      publicService: new ProjectAssetV2ApplicationService({
        assets: f.assets,
        adoptions,
      }),
    };
  };
  const current = openService(),
    options = () => ({
      signal: new AbortController().signal,
      authority: f.adoptionAuthority(),
    });
  return {
    ...f,
    ...current,
    policy,
    openService,
    options,
    adoptPublic: () =>
      current.publicService.adoptReference(
        f.actor,
        f.write.request.query,
        options(),
      ),
  };
}
