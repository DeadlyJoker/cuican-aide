import { createHash } from "node:crypto";
import { metadataService } from "./persistent-ui.test-support.mjs";
const copy = (value) => structuredClone(value);
const canonical = (value) =>
  value && typeof value === "object"
    ? Array.isArray(value)
      ? value.map(canonical)
      : Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
    : value;
const digest = (value) =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
const error = (code) => Object.assign(new Error(code), { code });

/** Public DTO fixture only. Actual mount/HTTP/SQL qualification is verified in host integration tests. */
export function textService() {
  const metadata = metadataService();
  const artifacts = new Map(),
    receipts = new Map(),
    calls = [];
  let serial = 0,
    tick = 0,
    lost = false,
    gate = null;
  const now = () => new Date(Date.UTC(2026, 9, 5, 0, 0, ++tick)).toISOString();
  const record = (id) => {
    const project = metadata.records.get(id);
    if (!project) throw error("creative_project_not_found");
    return project;
  };
  const outline = (id) =>
    [...artifacts.values()].find(
      (item) =>
        item.artifact.projectId === id && item.artifact.kind === "outline",
    );
  const script = (id, episodeId) =>
    [...artifacts.values()].find(
      (item) =>
        item.artifact.projectId === id &&
        item.artifact.kind === "script" &&
        item.artifact.episodeId === episodeId,
    );
  const byId = (input) => {
    const item = artifacts.get(input.artifactId);
    if (!item || item.artifact.projectId !== input.projectId)
      throw error("project_text_not_found");
    return item;
  };
  function view(item) {
    if (!item) return null;
    const selectedRevision =
      item.revisions.find(
        (revision) =>
          revision.contentRevision === item.artifact.selectedContentRevision,
      ) ?? null;
    const staleReasons = [];
    if (selectedRevision) {
      const project = record(item.artifact.projectId);
      if (
        selectedRevision.brief.briefRevision !==
        project.project.latestBriefRevision
      )
        staleReasons.push("brief-changed");
      if (
        selectedRevision.outline &&
        outline(item.artifact.projectId)?.artifact.selectedContentRevision !==
          selectedRevision.outline.contentRevision
      )
        staleReasons.push("outline-selection-changed");
    }
    return copy({
      artifact: item.artifact,
      selectedRevision,
      dependencyState: !selectedRevision
        ? "unselected"
        : staleReasons.length
          ? "stale"
          : "current",
      staleReasons,
    });
  }
  async function invoke(action, input, options) {
    // Empty-journal public fixture for the original manual text regression cases.
    // Cold recovery itself is exercised by text-recovery.test-support and real host SQL tests.
    if (action === "crewon.project-text-recovery.v1.getPending") return { intent: null };
    if (!action.startsWith("crewon.project-texts.v1."))
      return metadata.services.invoke(action, input, options);
    const method = action.split(".").at(-1);
    calls.push({ method, input: copy(input) });
    const project = record(input.projectId);
    if (gate) {
      const held = gate;
      gate = null;
      await held;
    }
    if (method === "getOutline")
      return { view: view(outline(input.projectId)) };
    if (method === "getScript")
      return { view: view(script(input.projectId, input.episodeId)) };
    if (method === "getArtifact") return { view: view(byId(input)) };
    if (method === "getRevision")
      return {
        contentRevision: copy(
          byId(input).revisions.find(
            (revision) => revision.contentRevision === input.contentRevision,
          ),
        ),
      };
    if (method === "listArtifacts") {
      const entries = [...artifacts.values()]
        .map((item) => item.artifact)
        .filter(
          (item) =>
            item.projectId === input.projectId &&
            (input.afterArtifactId === null ||
              item.artifactId > input.afterArtifactId),
        )
        .sort((a, b) => (a.artifactId < b.artifactId ? -1 : 1));
      const page = entries.slice(0, input.limit);
      return copy({
        artifacts: page,
        nextArtifactId:
          entries.length > page.length ? page.at(-1).artifactId : null,
      });
    }
    if (method === "listRevisions") {
      const entries = byId(input).revisions.filter(
        (item) => item.contentRevision > input.afterContentRevision,
      );
      const page = entries.slice(0, input.limit);
      return copy({
        revisions: page,
        nextContentRevision:
          entries.length > page.length ? page.at(-1).contentRevision : null,
      });
    }
    const previous = receipts.get(input.idempotencyKey);
    if (previous) {
      if (previous.digest !== digest({ action, input }))
        throw error("project_text_idempotency_conflict");
      return copy({ ...previous.result, disposition: "replayed" });
    }
    if (project.project.state === "archived")
      throw error("creative_project_archived");
    const save =
      method === "saveOutlineCandidate" || method === "saveScriptCandidate";
    let item = save
      ? method === "saveOutlineCandidate"
        ? outline(input.projectId)
        : script(input.projectId, input.episodeId)
      : byId(input);
    if (
      input.request.expectedArtifactRevision !== (item?.artifact.revision ?? 0)
    )
      throw error("project_text_revision_conflict");
    let contentRevision = null;
    if (save) {
      if (!item) {
        const createdAt = now();
        item = {
          artifact: {
            projectId: input.projectId,
            artifactId: `text-${++serial}`,
            kind: method === "saveOutlineCandidate" ? "outline" : "script",
            episodeId:
              method === "saveOutlineCandidate" ? null : input.episodeId,
            revision: 0,
            latestContentRevision: 0,
            selectedContentRevision: null,
            locked: false,
            createdAt,
            updatedAt: createdAt,
          },
          revisions: [],
        };
        artifacts.set(item.artifact.artifactId, item);
      }
      const brief = project.briefs.find(
        (entry) => entry.briefRevision === input.request.briefRevision,
      );
      let sourceOutline = null;
      if (input.request.outline) {
        const source = byId({
          projectId: input.projectId,
          artifactId: input.request.outline.artifactId,
        });
        const revision = source.revisions.find(
          (entry) =>
            entry.contentRevision === input.request.outline.contentRevision,
        );
        sourceOutline = {
          ...input.request.outline,
          contentDigest: revision.contentDigest,
        };
      }
      contentRevision = {
        projectId: input.projectId,
        artifactId: item.artifact.artifactId,
        kind: item.artifact.kind,
        episodeId: item.artifact.episodeId,
        contentRevision: item.artifact.latestContentRevision + 1,
        brief: {
          briefRevision: brief.briefRevision,
          contentDigest: brief.contentDigest,
        },
        outline: sourceOutline,
        content: copy(input.request.content),
        contentDigest: digest(input.request.content),
        createdAt: now(),
      };
      item.revisions.push(contentRevision);
      item.artifact = {
        ...item.artifact,
        latestContentRevision: contentRevision.contentRevision,
      };
    } else if (method === "selectRevision") {
      if (item.artifact.locked) throw error("project_text_locked");
      contentRevision = item.revisions.find(
        (entry) => entry.contentRevision === input.request.contentRevision,
      );
      item.artifact = {
        ...item.artifact,
        selectedContentRevision: contentRevision.contentRevision,
      };
    } else if (method === "setLocked") {
      item.artifact = { ...item.artifact, locked: input.request.locked };
    } else throw error("unsupported_action");
    item.artifact = {
      ...item.artifact,
      revision: item.artifact.revision + 1,
      updatedAt: now(),
    };
    const kind =
      method === "saveOutlineCandidate"
        ? "save-outline"
        : method === "saveScriptCandidate"
          ? "save-script"
          : method === "selectRevision"
            ? "select-revision"
            : "set-lock";
    const result = copy({
      kind,
      disposition: "committed",
      artifact: item.artifact,
      contentRevision,
    });
    receipts.set(input.idempotencyKey, {
      digest: digest({ action, input }),
      result,
    });
    if (lost) {
      lost = false;
      throw error("lost_ack");
    }
    return result;
  }
  return {
    metadata,
    artifacts,
    receipts,
    calls,
    services: { invoke },
    loseNextWrite: () => {
      lost = true;
    },
    gateNextRead: (promise) => {
      gate = promise;
    },
    view,
  };
}
