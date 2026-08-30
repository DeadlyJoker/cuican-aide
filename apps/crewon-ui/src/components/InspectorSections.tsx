import {
  Box,
  CheckCircle2,
  GitBranch,
  Github,
  GitPullRequestArrow,
  Globe2,
  HardDrive,
  Laptop,
  ListTodo,
  Settings2,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import type { ConversationSummary } from "@crewon/app-server-protocol/ConversationSummary";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ThreadGoalView } from "@crewon/contracts";

import { cn } from "@/lib/cn";
import type { inspectorPresentation } from "./InspectorPresentation";

type InspectorPresentationData = ReturnType<typeof inspectorPresentation>;

const sectionClass =
  "grid gap-1 border-t border-border/50 py-2 first:border-t-0 first:pt-0 last:pb-0";
const headerClass =
  "flex min-h-4 items-center justify-between text-[11px] font-medium text-muted-foreground";
const rowClass =
  "flex min-h-[17px] min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-foreground [&>svg]:shrink-0";
const rowValueClass = "ml-auto truncate font-medium text-foreground/80";
const monoValueClass = "truncate font-mono";

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
    <section className={sectionClass}>
      <div className={headerClass}>
        <strong>{copy.title}</strong>
        <Settings2 size={14} />
      </div>
      <div className={rowClass}>
        <Box size={14} />
        <span>{copy.changes}</span>
        <strong className={cn(rowValueClass, "flex gap-1")}>
          <span className="text-success">
            +{displayChanges.added || displayChanges.files}
          </span>
          <span className="text-destructive">-{displayChanges.removed}</span>
        </strong>
      </div>
      <div className={rowClass}>
        <GitPullRequestArrow size={14} />
        <span>{copy.remoteChanges}</span>
        <strong className={rowValueClass} title={remoteDiffLabel}>
          {remoteDiffLabel}
        </strong>
      </div>
      <div className={rowClass}>
        <Laptop size={14} />
        <span>{copy.local}</span>
        <strong className={rowValueClass}>{workspaceLabel}</strong>
      </div>
      <div className={rowClass}>
        <GitBranch size={14} />
        <span>{copy.branch}</span>
        <strong className={rowValueClass}>{branch}</strong>
      </div>
      <div className={rowClass}>
        <CheckCircle2 size={14} />
        <span>{copy.status}</span>
        <strong className={rowValueClass}>{statusLabel}</strong>
      </div>
      <div className={rowClass}>
        <HardDrive size={14} />
        <span>{copy.loadedThreads}</span>
        <strong className={rowValueClass}>{loadedThreadCount}</strong>
      </div>
      <div className={rowClass}>
        <ShieldCheck size={14} />
        <span>{copy.account}</span>
        <strong className={rowValueClass} title={accountLabel}>
          {accountLabel}
        </strong>
      </div>
      <div className={cn(rowClass, "opacity-70")}>
        <Github size={14} />
        <span>{copy.remote}</span>
        <strong className={rowValueClass} title={remote}>
          {remote}
        </strong>
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
  const progressRows: Array<{ complete: boolean; icon: React.ReactNode; label: string }> = [
    {
      complete: Boolean(thread),
      icon: <CheckCircle2 size={13} />,
      label: copy.current,
    },
    {
      complete: totalItems > 0,
      icon: <ListTodo size={13} />,
      label: thread ? `${totalItems} ${copy.task}` : copy.noThread,
    },
    {
      complete: commands > 0,
      icon: <Terminal size={13} />,
      label: `${commands} ${copy.commands}`,
    },
  ];

  return (
    <section className={sectionClass}>
      <div className={headerClass}>
        <strong>{copy.progress}</strong>
      </div>
      <div className="grid gap-1">
        {progressRows.map((row) => (
          <span
            className={cn(
              rowClass,
              row.complete ? "text-foreground/80" : "opacity-60",
            )}
            key={row.label}
          >
            {row.icon}
            {row.label}
          </span>
        ))}
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
    <section className={sectionClass}>
      <div className={headerClass}>
        <strong>{copy.goal}</strong>
      </div>
      <div className={rowClass}>
        <ListTodo size={14} />
        <span className="truncate" title={taskGoalLabel}>
          {taskGoalLabel}
        </span>
      </div>
      {threadGoal ? (
        <div className={cn(rowClass, "opacity-70")}>
          <CheckCircle2 size={14} />
          <span>{threadGoal.status}</span>
          <strong className={rowValueClass}>
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
    <section className={sectionClass}>
      <div className={headerClass}>
        <strong>{copy.task}</strong>
      </div>
      <div className={rowClass}>
        <Terminal size={14} />
        <span className={monoValueClass}>{command ?? copy.noTask}</span>
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
    <section className={sectionClass}>
      <div className={headerClass}>
        <strong>{copy.summary}</strong>
      </div>
      <div className={rowClass}>
        <ListTodo size={14} />
        <span className="truncate" title={summaryLabel}>
          {summaryLabel}
        </span>
      </div>
      {conversationSummary ? (
        <div className={cn(rowClass, "opacity-70")}>
          <HardDrive size={14} />
          <span>{conversationSummary.modelProvider}</span>
          <strong className={rowValueClass} title={conversationSummary.cliVersion}>
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
    <section className={sectionClass}>
      <div className={headerClass}>
        <strong>{copy.source}</strong>
      </div>
      <div aria-hidden="true" className="flex gap-2 text-muted-foreground/70">
        <Globe2 size={13} />
        <Github size={13} />
        <Terminal size={13} />
      </div>
    </section>
  );
}
