import { createHash } from "node:crypto";
import { projectFoundationUiCodec } from "@crewon/plugin-sdk/project-foundation-ui";
import {
  metadataService,
  persistentProps,
} from "./persistent-ui.test-support.mjs";
const copy = (value) => structuredClone(value);
const digest = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const at = "2026-10-08T00:00:00.000Z";
export const creativeParameters = {
  genre: null,
  episodeMode: "single",
  episodeCount: 1,
  episodeDurationSeconds: null,
  aspectRatio: "16:9",
  visualStyle: null,
  needsCharacters: true,
  needsArt: true,
  adaptation: null,
};
export const novelParameters = {
  ...creativeParameters,
  episodeMode: "series",
  episodeCount: null,
  episodeDurationSeconds: { minimum: 120, maximum: 300 },
  visualStyle: "semi-realistic",
  adaptation: {
    strategy: "core",
    retainedCharacters: ["林雨"],
    retainedScenes: ["重逢"],
  },
};
export const foundationProps = (tokens, mode) => {
  const result = persistentProps(true, tokens, mode);
  result.data.projectFoundationConnected = true;
  return result;
};
/** Public DTO dispatcher for UI behavior/snapshots only. It is not SQL, identity, upload or supplier evidence. */
export function foundationService({ sourceForUpload } = {}) {
  const metadata = metadataService(),
    foundations = new Map(),
    proposals = new Map(),
    sources = new Map();
  const calls = [],
    receipts = new Map();
  let loseReply = false,
    listProposalsPage = null;
  function source(projectId, text) {
    const chars = Array.from(text);
    const value = {
      schemaVersion: "crewon.project-source.v1",
      projectId,
      revision: 1,
      digest: digest(text),
      fileDigest: digest(text),
      fileName: "雨夜.md",
      format: "md",
      byteLength: Buffer.byteLength(text),
      characterLength: chars.length,
      createdAt: at,
    };
    const middle = Math.floor(chars.length / 2);
    sources.set(projectId, {
      source: value,
      chars,
      chapters: [
        {
          projectId,
          sourceRevision: 1,
          chapterId: "first",
          title: "第一章 雨夜",
          startOffset: 0,
          endOffset: middle,
        },
        {
          projectId,
          sourceRevision: 1,
          chapterId: "second",
          title: "第二章 寻人",
          startOffset: middle,
          endOffset: chars.length,
        },
      ],
    });
    return value;
  }
  function seed(
    origin,
    {
      title = origin === "novel" ? "雨夜小说" : "雨夜创意",
      text = "雨夜来信，寻找失踪的人。",
      sourceText = "雨😀夜。".repeat(600),
    } = {},
  ) {
    const result = metadata.create(title, text),
      projectId = result.project.projectId;
    const s = origin === "novel" ? source(projectId, sourceText) : null;
    const f = {
      schemaVersion: "crewon.project-foundation.v1",
      projectId,
      origin,
      revision: 1,
      parametersRevision: 1,
      parameters: copy(
        origin === "novel" ? novelParameters : creativeParameters,
      ),
      source: s ? { revision: s.revision, digest: s.digest } : null,
      confirmedProposal: null,
      creativeStartMode: origin === "creative" ? "confirm-plan" : null,
      createdAt: at,
      updatedAt: at,
    };
    foundations.set(projectId, f);
    proposals.set(projectId, []);
    return copy({ ...result, foundation: f, source: s });
  }
  function record(projectId) {
    const foundation = foundations.get(projectId),
      project = metadata.records.get(projectId)?.project;
    if (!foundation || !project)
      throw Object.assign(new Error("project_foundation_not_found"), {
        code: "project_foundation_not_found",
      });
    return { foundation, project };
  }
  function outcome(kind, projectId, additions = {}) {
    const { foundation, project } = record(projectId);
    return copy({
      kind,
      disposition: "committed",
      project,
      foundation,
      brief: null,
      source: null,
      proposal: null,
      ...additions,
    });
  }
  function proposal(
    projectId,
    text,
    revision = (proposals.get(projectId)?.length ?? 0) + 1,
  ) {
    const { foundation: f } = record(projectId);
    const p = {
      schemaVersion: "crewon.project-proposal.v1",
      projectId,
      revision,
      kind: f.origin === "novel" ? "novel-adaptation" : "creative-plan",
      foundationRevision: f.revision,
      parametersRevision: f.parametersRevision,
      source: copy(f.source),
      text,
      contentDigest: digest(text + revision),
      createdAt: at,
    };
    proposals.get(projectId).push(p);
    return copy(p);
  }
  async function invoke(action, input, options) {
    if (!action.startsWith("crewon.project-foundation.v1."))
      return metadata.services.invoke(action, input, options);
    const request = projectFoundationUiCodec.parseRequest({ action, input });
    calls.push(copy(request));
    const method = action.split(".").at(-1),
      key = input.idempotencyKey ? `${method}:${input.idempotencyKey}` : null;
    if (key && receipts.has(key))
      return copy({ ...receipts.get(key), disposition: "replayed" });
    let result;
    if (method === "getFoundation")
      result = { foundation: copy(foundations.get(input.projectId) ?? null) };
    else if (method === "createProject") {
      const saved = seed(input.origin, {
        title: input.title,
        text: input.briefText,
        ...(input.sourceUpload && sourceForUpload
          ? { sourceText: sourceForUpload(input.sourceUpload.uploadId) }
          : {}),
      });
      const f = foundations.get(saved.project.projectId);
      f.parameters = copy(input.parameters);
      f.creativeStartMode = input.creativeStartMode;
      result = outcome("create-project", saved.project.projectId, {
        brief: saved.brief,
        source: saved.source,
      });
    } else {
      const { foundation: f } = record(input.projectId);
      if (
        input.expectedFoundationRevision !== undefined &&
        input.expectedFoundationRevision !== f.revision
      )
        throw Object.assign(new Error("project_foundation_revision_conflict"), {
          code: "project_foundation_revision_conflict",
        });
      if (method === "getSource")
        result = { source: copy(sources.get(input.projectId)?.source ?? null) };
      else if (method === "listSourceChapters") {
        const items = sources
          .get(input.projectId)
          .chapters.filter(
            (c) =>
              input.afterStartOffset === null ||
              c.startOffset > input.afterStartOffset,
          );
        const page = items.slice(0, input.limit);
        result = {
          chapters: copy(page),
          nextStartOffset:
            items.length > page.length ? page.at(-1).startOffset : null,
        };
      } else if (method === "readSourcePage") {
        const chars = sources.get(input.projectId).chars,
          end = Math.min(chars.length, input.startOffset + input.limit);
        result = {
          page: {
            sourceRevision: f.source.revision,
            startOffset: input.startOffset,
            endOffset: end,
            content: chars.slice(input.startOffset, end).join(""),
            nextOffset: end < chars.length ? end : null,
          },
        };
      } else if (method === "getProposal")
        result = {
          proposal: copy(
            proposals
              .get(input.projectId)
              .find((p) => p.revision === input.proposalRevision) ?? null,
          ),
        };
      else if (method === "listProposals") {
        const list = proposals
          .get(input.projectId)
          .filter((p) => p.revision > input.afterProposalRevision);
        const page = list.slice(0, listProposalsPage ?? input.limit);
        result = {
          proposals: copy(page),
          nextRevision: list.length > page.length ? page.at(-1).revision : null,
        };
      } else if (method === "saveProposal") {
        const latest = proposals.get(input.projectId).at(-1)?.revision ?? 0;
        if (input.expectedProposalRevision !== latest)
          throw Object.assign(new Error("project_proposal_revision_conflict"), {
            code: "project_proposal_revision_conflict",
          });
        result = outcome("save-proposal", input.projectId, {
          proposal: proposal(input.projectId, input.text),
        });
      } else if (method === "confirmProposal") {
        const p = proposals
          .get(input.projectId)
          .find((p) => p.revision === input.proposalRevision);
        f.revision += 1;
        f.confirmedProposal = { revision: p.revision, digest: p.contentDigest };
        result = outcome("confirm-proposal", input.projectId, { proposal: p });
      } else if (method === "updateParameters") {
        f.revision += 1;
        f.parametersRevision += 1;
        f.parameters = copy(input.parameters);
        f.confirmedProposal = null;
        result = outcome("update-parameters", input.projectId);
      } else if (method === "chooseDirectScript") {
        f.revision += 1;
        f.creativeStartMode = input.creativeStartMode;
        result = outcome("choose-direct-script", input.projectId);
      } else throw new Error(`fixture_unimplemented:${method}`);
    }
    const captured = projectFoundationUiCodec.parseResponse(result, request);
    if (key) {
      receipts.set(key, copy(captured));
      if (loseReply) {
        loseReply = false;
        throw new Error("lost_transport_reply");
      }
    }
    return copy(captured);
  }
  return {
    metadata,
    foundations,
    proposals,
    sources,
    calls,
    seed,
    proposal,
    services: { invoke },
    loseNextReply() {
      loseReply = true;
    },
    proposalPageSize(size) {
      listProposalsPage = size;
    },
    methodCalls(method) {
      return calls.filter((c) => c.action.endsWith("." + method));
    },
  };
}
