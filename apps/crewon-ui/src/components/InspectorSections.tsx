import {
  Box,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Github,
  GitPullRequestArrow,
  Globe2,
  HardDrive,
  Laptop,
  ListTodo,
  ShieldCheck,
  Settings2,
  Terminal,
} from "lucide-react";
import type { ConversationSummary } from "@crewon-ui-model/ConversationSummary";
import type { Thread } from "@crewon-ui-model/v2/Thread";
import type { ThreadGoalView } from "@crewon/contracts";

import type { inspectorPresentation } from "./InspectorPresentation";

type InspectorPresentationData = ReturnType<typeof inspectorPresentation>;

export function InspectorWorkspaceSection({
  loadedThreadCount,
  presentation,
}: {
  loadedThreadCount: number;
  presentation: InspectorPresentationData;
}) {
  const {
    accountLabel,
    branch,
    copy,
    displayChanges,
    remote,
    remoteDiffLabel,
    statusLabel,
    workspaceLabel,
  } = presentation;

  return (
    <section className="inspector-section">
      <div className="inspector-card-header">
        <strong>{copy.title}</strong>
        <Settings2 size={14} />
      </div>
      <div className="inspector-row">
        <Box size={14} />
        <span>{copy.changes}</span>
        <strong className="inspector-diff-stat">
          <span data-tone="added">
            +{displayChanges.added || displayChanges.files}
          </span>
          <span data-tone="removed">-{displayChanges.removed}</span>
        </strong>
      </div>
      <div className="inspector-row">
        <GitPullRequestArrow size={14} />
        <span>{copy.remoteChanges}</span>
        <strong title={remoteDiffLabel}>{remoteDiffLabel}</strong>
      </div>
      <div className="inspector-row">
        <Laptop size={14} />
        <span>{copy.local}</span>
        <strong>
          {workspaceLabel}
          <ChevronDown size={11} />
        </strong>
      </div>
      <div className="inspector-row">
        <GitBranch size={14} />
        <span>{copy.branch}</span>
        <strong>
          {branch}
          <ChevronDown size={11} />
        </strong>
      </div>
      <div className="inspector-row">
        <GitPullRequestArrow size={14} />
        <span>{copy.submit}</span>
      </div>
      <div className="inspector-row">
        <CheckCircle2 size={14} />
        <span>{copy.status}</span>
        <strong>{statusLabel}</strong>
      </div>
      <div className="inspector-row">
        <HardDrive size={14} />
        <span>{copy.loadedThreads}</span>
        <strong>{loadedThreadCount}</strong>
      </div>
      <div className="inspector-row">
        <ShieldCheck size={14} />
        <span>{copy.account}</span>
        <strong title={accountLabel}>{accountLabel}</strong>
      </div>
      <div className="inspector-row is-muted">
        <Github size={14} />
        <span>{copy.remote}</span>
        <strong title={remote}>{remote}</strong>
      </div>
    </section>
  );
}

export function InspectorProgressSection({
  presentation,
  thread,
}: {
  presentation: InspectorPresentationData;
  thread: Thread | null;
}) {
  const { commands, copy, totalItems } = presentation;

  return (
    <section className="inspector-section">
      <div className="inspector-card-header">
        <strong>{copy.progress}</strong>
        <ChevronRight size={13} />
      </div>
      <div className="inspector-progress">
        <span data-complete={Boolean(thread)}>
          <CheckCircle2 size={13} />
          {copy.current}
        </span>
        <span data-complete={totalItems > 0}>
          <ListTodo size={13} />
          {thread ? `${totalItems} ${copy.task}` : copy.noThread}
        </span>
        <span data-complete={commands > 0}>
          <Terminal size={13} />
          {commands} {copy.commands}
        </span>
      </div>
    </section>
  );
}

export function InspectorGoalSection({
  presentation,
  threadGoal,
}: {
  presentation: InspectorPresentationData;
  threadGoal: ThreadGoalView | null;
}) {
  const { copy, taskGoalLabel } = presentation;

  return (
    <section className="inspector-section">
      <div className="inspector-card-header">
        <strong>{copy.goal}</strong>
      </div>
      <div className="inspector-row inspector-task">
        <ListTodo size={14} />
        <span title={taskGoalLabel}>{taskGoalLabel}</span>
      </div>
      {threadGoal ? (
        <div className="inspector-row is-muted">
          <CheckCircle2 size={14} />
          <span>{threadGoal.status}</span>
          <strong>
            {threadGoal.tokensUsed}
            {threadGoal.tokenBudget ? `/${threadGoal.tokenBudget}` : ""}{" "}
            {copy.tokens}
          </strong>
        </div>
      ) : null}
    </section>
  );
}

export function InspectorTaskSection({
  presentation,
}: {
  presentation: InspectorPresentationData;
}) {
  const { command, copy } = presentation;

  return (
    <section className="inspector-section">
      <div className="inspector-card-header">
        <strong>{copy.task}</strong>
      </div>
      <div className="inspector-row inspector-task">
        <Terminal size={14} />
        <span>{command ?? copy.noTask}</span>
      </div>
    </section>
  );
}

export function InspectorSummarySection({
  conversationSummary,
  presentation,
}: {
  conversationSummary: ConversationSummary | null;
  presentation: InspectorPresentationData;
}) {
  const { copy, summaryLabel } = presentation;

  return (
    <section className="inspector-section">
      <div className="inspector-card-header">
        <strong>{copy.summary}</strong>
      </div>
      <div className="inspector-row inspector-task">
        <ListTodo size={14} />
        <span title={summaryLabel}>{summaryLabel}</span>
      </div>
      {conversationSummary ? (
        <div className="inspector-row is-muted">
          <HardDrive size={14} />
          <span>{conversationSummary.modelProvider}</span>
          <strong title={conversationSummary.cliVersion}>
            {conversationSummary.cliVersion}
          </strong>
        </div>
      ) : null}
    </section>
  );
}

export function InspectorSourcesSection({
  presentation,
}: {
  presentation: InspectorPresentationData;
}) {
  const { copy } = presentation;

  return (
    <section className="inspector-section">
      <div className="inspector-card-header">
        <strong>{copy.source}</strong>
      </div>
      <div className="inspector-sources" aria-hidden="true">
        <Globe2 size={13} />
        <Github size={13} />
        <Terminal size={13} />
      </div>
    </section>
  );
}
