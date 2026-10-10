import { useState } from "react";
import { ChevronUp, FileDiff, ArrowUpRight } from "lucide-react";
import { HoverCard } from "radix-ui";
import type { Locale } from "../../lib/i18n";
import type { RecordedTaskChanges } from "../../lib/task-detail/recordedTaskChanges";
import type { ComposerTaskChangeSummary } from "./ComposerProgressPill";

export function ComposerTaskChangesPreview({
  details,
  locale,
  onOpen,
}: {
  details: RecordedTaskChanges;
  locale: Locale;
  onOpen?: () => void;
}) {
  return (
    <>
      <header>
        <strong>{locale === "zh" ? "任务改动" : "Task changes"}</strong>
        <button type="button" onClick={onOpen}>
          {locale === "zh" ? "查看全部改动" : "View all changes"}
          <ArrowUpRight aria-hidden="true" />
        </button>
      </header>
      <div className="composer-changes-preview-files">
        {details.files.slice(0, 8).map((file) => (
          <section key={file.path}>
            <div className="composer-changes-preview-file">
              <FileDiff aria-hidden="true" />
              <span title={file.path}>{file.path}</span>
              {file.diff ? (
                <>
                  <em className="composer-progress-additions">
                    +{file.additions}
                  </em>
                  <em className="composer-progress-deletions">
                    -{file.deletions}
                  </em>
                </>
              ) : null}
            </div>
            {file.diff ? (
              <pre aria-label={file.path}>
                {file.diff
                  .split("\n")
                  .slice(0, 5)
                  .map((line, index) => (
                    <code
                      data-kind={
                        line.startsWith("+")
                          ? "added"
                          : line.startsWith("-")
                            ? "removed"
                            : "context"
                      }
                      key={index}
                    >
                      {line || " "}
                      {"\n"}
                    </code>
                  ))}
              </pre>
            ) : (
              <p>
                {locale === "zh"
                  ? "未提供差异内容"
                  : "Diff content unavailable"}
              </p>
            )}
          </section>
        ))}
        {details.files.length > 8 ? (
          <p>
            {locale === "zh"
              ? `另有 ${details.files.length - 8} 个文件，点击查看`
              : `${details.files.length - 8} more files — click to view`}
          </p>
        ) : null}
      </div>
      {!details.complete ? (
        <p className="composer-changes-note">
          {locale === "zh"
            ? "部分差异内容未载入；以上为已记录的片段。"
            : "Some diff content is missing; showing recorded fragments."}
        </p>
      ) : null}
    </>
  );
}

export function ComposerTaskChanges({
  details,
  locale,
  summary,
  onOpen,
}: {
  details: RecordedTaskChanges;
  locale: Locale;
  summary: ComposerTaskChangeSummary;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <HoverCard.Root
      open={open}
      onOpenChange={setOpen}
      openDelay={180}
      closeDelay={160}
    >
      <HoverCard.Trigger asChild>
        <button
          aria-label={locale === "zh" ? "查看任务改动" : "View task changes"}
          className="composer-progress-pill composer-changes-trigger"
          type="button"
          onClick={() => {
            setOpen(false);
            onOpen();
          }}
        >
          <span>
            {locale === "zh"
              ? `${summary.files} 个文件已更改`
              : `${summary.files} files changed`}
          </span>
          <span className="composer-progress-additions">
            +{summary.additions}
          </span>
          <span className="composer-progress-deletions">
            -{summary.deletions}
          </span>
          <ChevronUp
            aria-hidden="true"
            className="composer-progress-disclosure"
          />
        </button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          className="composer-changes-preview"
          side="top"
          align="center"
          sideOffset={10}
          collisionPadding={12}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }}
        >
          <ComposerTaskChangesPreview
            details={details}
            locale={locale}
            onOpen={() => {
              setOpen(false);
              onOpen();
            }}
          />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
