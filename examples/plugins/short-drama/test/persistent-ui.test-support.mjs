import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

/** Deterministic public-metadata dispatcher fixture; no database, identity or supplier claim. */
export function metadataService({ pageSize = 20 } = {}) {
  const records = new Map();
  const receipts = new Map();
  const calls = [];
  let ticks = 0;
  let serial = 0;
  let refuse = false;
  let loseNextWrite = false;
  let listGate = null;
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
    };
    records.set(projectId, record);
    return append(record, briefText, at);
  }
  function conflict() {
    return Object.assign(new Error("revision conflict"), {
      code: "creative_project_revision_conflict",
    });
  }
  const services = {
    async invoke(action, input, options) {
      calls.push({ action, input: copy(input), signal: options.signal });
      assert.ok(action.startsWith("crewon.creative-projects.v1."));
      if (refuse) throw new Error("plugin_ui_action_not_permitted");
      const method = action.split(".").at(-1);
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
      const receipt = receipts.get(input.idempotencyKey);
      if (receipt) {
        assert.equal(action, receipt.action);
        assert.deepEqual(input, receipt.input);
        return copy({ ...receipt.output, disposition: "replayed" });
      }
      let output;
      if (method === "createProject")
        output = {
          disposition: "committed",
          ...create(input.request.title, input.request.briefText),
        };
      else if (method === "appendBrief") {
        if (record.project.revision !== input.request.expectedProjectRevision)
          throw conflict();
        assert.equal(record.project.state, "active");
        output = {
          disposition: "committed",
          ...append(record, input.request.text),
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
      receipts.set(input.idempotencyKey, {
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
    externalBrief(projectId, text) {
      return append(records.get(projectId), text);
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
    methodCalls(method) {
      return calls.filter((call) => call.action.endsWith("." + method));
    },
  };
}
