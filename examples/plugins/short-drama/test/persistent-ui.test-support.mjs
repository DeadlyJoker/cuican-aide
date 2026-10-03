import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
export const persistentProps = (
  ready = false,
  tokens = { "--text": "#202020" },
  mode = "light",
) => ({
  schemaVersion: "crewon.plugin-ui-props.v1",
  contributionId: "workbench",
  theme: { mode, tokens },
  data: { locale: "zh", pluginUiReady: ready },
});
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const copy = (value) => structuredClone(value);
const digest = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const conceptReadMethods = new Set([
  "getConceptAsset",
  "listConceptAssets",
  "getConceptRevision",
  "listConceptRevisions",
]);
const compareIds = (left, right) => {
  const a = [...left],
    b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
};

/** Deterministic public-metadata dispatcher fixture; no database, identity or supplier claim. */
export function metadataService({ pageSize = 20 } = {}) {
  const records = new Map();
  const receipts = new Map();
  const calls = [];
  let ticks = 0;
  let serial = 0;
  let assetSerial = 0;
  let refuse = false;
  let loseNextWrite = false;
  let listGate = null;
  const conceptReadGates = new Map();
  const now = () =>
    new Date(Date.UTC(2026, 9, 3, 0, 0, 0, ++ticks)).toISOString();
  function append(record, text, at = now()) {
    const brief = {
      projectId: record.project.projectId,
      briefRevision: record.project.latestBriefRevision + 1,
      text,
      contentDigest: digest(text),
      createdAt: at,
    };
    record.project = {
      ...record.project,
      revision: record.project.revision + 1,
      latestBriefRevision: brief.briefRevision,
      updatedAt: at,
    };
    record.briefs.push(brief);
    return { project: copy(record.project), brief: copy(brief) };
  }
  function create(title, briefText) {
    const at = now();
    const projectId = `project/中文 %2F ${++serial}`;
    const record = {
      project: {
        projectId,
        kind: "short-drama",
        title,
        revision: 1,
        latestBriefRevision: 0,
        state: "active",
        createdAt: at,
        updatedAt: at,
      },
      briefs: [],
      assets: new Map(),
    };
    records.set(projectId, record);
    return append(record, briefText, at);
  }
  function failure(code) {
    return Object.assign(new Error(code), { code });
  }
  function conflict() {
    return failure("creative_project_revision_conflict");
  }
  function projectRecord(projectId) {
    const record = records.get(projectId);
    if (!record) throw failure("creative_project_not_found");
    return record;
  }
  function savedBrief(record, briefRevision) {
    const brief = record.briefs.find(
      (item) => item.briefRevision === briefRevision,
    );
    if (!brief) throw failure("creative_project_brief_not_found");
    return brief;
  }
  function conceptRecord(record, assetId) {
    const concept = record.assets.get(assetId);
    if (!concept) throw failure("creative_project_asset_not_found");
    return concept;
  }
  function assertActive(record) {
    if (record.project.state !== "active")
      throw failure("creative_project_archived");
  }
  function assertProjectRevision(record, expectedProjectRevision) {
    if (record.project.revision !== expectedProjectRevision) throw conflict();
  }
  function saveConceptRevision(record, concept, briefRevision, prompt, at) {
    const brief = savedBrief(record, briefRevision);
    const revision = {
      projectId: record.project.projectId,
      assetId: concept.asset.assetId,
      assetRevision: concept.asset.latestAssetRevision,
      briefRevision: brief.briefRevision,
      briefContentDigest: brief.contentDigest,
      prompt,
      createdAt: at,
    };
    const assetRevision = Object.freeze({
      ...revision,
      contentDigest: digest(JSON.stringify(revision)),
    });
    concept.revisions = Object.freeze([...concept.revisions, assetRevision]);
    record.project = {
      ...record.project,
      revision: record.project.revision + 1,
      updatedAt: at,
    };
    return copy({
      project: record.project,
      asset: concept.asset,
      assetRevision,
    });
  }
  function createConcept(projectId, name, briefRevision, prompt) {
    const record = projectRecord(projectId);
    assertActive(record);
    savedBrief(record, briefRevision);
    const at = now();
    const assetId = `concept/概念🎬\\中文 %2F ${++assetSerial}`;
    const concept = {
      asset: {
        projectId,
        assetId,
        name,
        revision: 1,
        latestAssetRevision: 1,
        createdAt: at,
        updatedAt: at,
      },
      revisions: Object.freeze([]),
    };
    record.assets.set(assetId, concept);
    return saveConceptRevision(record, concept, briefRevision, prompt, at);
  }
  function externalConceptRevision(projectId, assetId, briefRevision, prompt) {
    const record = projectRecord(projectId);
    assertActive(record);
    savedBrief(record, briefRevision);
    const concept = conceptRecord(record, assetId);
    const at = now();
    concept.asset = {
      ...concept.asset,
      revision: concept.asset.revision + 1,
      latestAssetRevision: concept.asset.latestAssetRevision + 1,
      updatedAt: at,
    };
    return saveConceptRevision(record, concept, briefRevision, prompt, at);
  }
  const services = {
    async invoke(action, input, options) {
      calls.push({ action, input: copy(input), signal: options?.signal });
      assert.ok(action.startsWith("crewon.creative-projects.v1."));
      if (refuse) throw new Error("plugin_ui_action_not_permitted");
      const method = action.split(".").at(-1);
      if (conceptReadGates.has(method)) {
        const gate = conceptReadGates.get(method);
        conceptReadGates.delete(method);
        return gate.promise;
      }
      if (method === "listProjects") {
        if (listGate) {
          const gate = listGate;
          listGate = null;
          return gate.promise;
        }
        const { query } = input;
        const after = query.cursor
          ? JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"))
          : null;
        const all = [...records.values()]
          .map((record) => record.project)
          .filter(
            (project) =>
              project.state === query.state &&
              (!after ||
                project.updatedAt < after[2] ||
                (project.updatedAt === after[2] &&
                  project.projectId < after[3])),
          )
          .sort((a, b) =>
            a.updatedAt === b.updatedAt
              ? a.projectId < b.projectId
                ? 1
                : -1
              : a.updatedAt < b.updatedAt
                ? 1
                : -1,
          );
        const projects = all.slice(0, Math.min(query.limit, pageSize));
        const last = projects.at(-1);
        const nextCursor =
          all.length > projects.length
            ? Buffer.from(
                JSON.stringify([
                  "crewon.creative-project-cursor.v1",
                  query.state,
                  last.updatedAt,
                  last.projectId,
                ]),
                "utf8",
              ).toString("base64url")
            : null;
        return copy({ projects, nextCursor });
      }
      const record = records.get(input.projectId);
      if (method === "getProject") return { project: copy(record.project) };
      if (method === "getBrief")
        return {
          brief: copy(
            record.briefs.find(
              (brief) => brief.briefRevision === input.briefRevision,
            ),
          ),
        };
      if (method === "listBriefs") {
        const all = record.briefs.filter(
          (brief) => brief.briefRevision > input.query.afterBriefRevision,
        );
        const briefs = all.slice(0, Math.min(input.query.limit, pageSize));
        return copy({
          briefs,
          nextAfterBriefRevision:
            all.length > briefs.length ? briefs.at(-1).briefRevision : null,
        });
      }
      if (conceptReadMethods.has(method)) {
        const project = projectRecord(input.projectId);
        if (method === "listConceptAssets") {
          const { afterAssetId = null, limit = 20 } = input.query;
          const all = [...project.assets.values()]
            .map((concept) => concept.asset)
            .filter(
              (asset) =>
                afterAssetId === null ||
                compareIds(asset.assetId, afterAssetId) > 0,
            )
            .sort((left, right) => compareIds(left.assetId, right.assetId));
          const assets = all.slice(0, Math.min(limit, pageSize));
          return copy({
            assets,
            nextAfterAssetId:
              all.length > assets.length ? assets.at(-1).assetId : null,
          });
        }
        const concept = conceptRecord(project, input.assetId);
        if (method === "getConceptAsset") return { asset: copy(concept.asset) };
        if (method === "getConceptRevision") {
          const assetRevision = concept.revisions.find(
            (revision) => revision.assetRevision === input.assetRevision,
          );
          if (!assetRevision)
            throw failure("creative_project_asset_revision_not_found");
          return { assetRevision: copy(assetRevision) };
        }
        const { afterAssetRevision = 0, limit = 20 } = input.query;
        const all = concept.revisions.filter(
          (revision) => revision.assetRevision > afterAssetRevision,
        );
        const revisions = all.slice(0, Math.min(limit, pageSize));
        return copy({
          revisions,
          nextAfterAssetRevision:
            all.length > revisions.length
              ? revisions.at(-1).assetRevision
              : null,
        });
      }
      const receiptKey = `${action}\0${input.idempotencyKey}`;
      const receipt = receipts.get(receiptKey);
      if (receipt) {
        if (!isDeepStrictEqual(input, receipt.input))
          throw failure("creative_project_idempotency_conflict");
        return copy({ ...receipt.output, disposition: "replayed" });
      }
      let output;
      if (method === "createProject")
        output = {
          disposition: "committed",
          ...create(input.request.title, input.request.briefText),
        };
      else if (method === "appendBrief") {
        assertProjectRevision(record, input.request.expectedProjectRevision);
        assertActive(record);
        output = {
          disposition: "committed",
          ...append(record, input.request.text),
        };
      } else if (method === "createConcept") {
        const project = projectRecord(input.projectId);
        assertProjectRevision(project, input.request.expectedProjectRevision);
        output = {
          disposition: "committed",
          ...createConcept(
            input.projectId,
            input.request.name,
            input.request.briefRevision,
            input.request.prompt,
          ),
        };
      } else if (method === "appendConceptRevision") {
        const project = projectRecord(input.projectId);
        assertProjectRevision(project, input.request.expectedProjectRevision);
        assertActive(project);
        const concept = conceptRecord(project, input.assetId);
        if (
          concept.asset.revision !== input.request.expectedAssetMetadataRevision
        )
          throw failure("creative_project_asset_revision_conflict");
        output = {
          disposition: "committed",
          ...externalConceptRevision(
            input.projectId,
            input.assetId,
            input.request.briefRevision,
            input.request.prompt,
          ),
        };
      } else if (method === "setProjectState") {
        if (record.project.revision !== input.request.expectedProjectRevision)
          throw conflict();
        record.project = {
          ...record.project,
          revision: record.project.revision + 1,
          state: input.request.state,
          updatedAt: now(),
        };
        output = { disposition: "committed", project: copy(record.project) };
      } else throw new Error("Unexpected UI action: " + action);
      receipts.set(receiptKey, {
        action,
        input: copy(input),
        output: copy(output),
      });
      if (loseNextWrite) {
        loseNextWrite = false;
        throw new Error("response lost after commit");
      }
      return copy(output);
    },
  };
  return {
    services,
    calls,
    records,
    create,
    createConcept,
    externalConceptRevision,
    externalBrief(projectId, text) {
      const record = projectRecord(projectId);
      assertActive(record);
      return append(record, text);
    },
    refuse(value) {
      refuse = value;
    },
    loseNextWrite() {
      loseNextWrite = true;
    },
    gateList(gate) {
      listGate = gate;
    },
    gateConceptRead(method, gate) {
      assert.ok(conceptReadMethods.has(method));
      conceptReadGates.set(method, gate);
    },
    methodCalls(method) {
      return calls.filter((call) => call.action.endsWith("." + method));
    },
  };
}
