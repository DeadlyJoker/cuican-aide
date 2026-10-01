import { useEffect, useRef, useState } from "react";
import { Puzzle } from "lucide-react";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ExtensionCatalogEntry } from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";
import type { Locale } from "../../lib/i18n";
import { ModalDialog } from "../shared/ModalDialog";
import { BusinessExtensionPanel } from "./BusinessExtensionPanel";
import { supportedImageExtension } from "./businessExtensionPresentation";
import {
  useBusinessExtension,
  type BusinessExtensionClient,
  type BusinessExtensionThreadRuntime,
} from "./useBusinessExtension";

type ExtensionClient = BusinessExtensionClient &
  Pick<ControlApiClient, "listExtensions">;

/** The business entry appears only after the host advertises the supported plugin. */
export function BusinessExtensionController({
  client,
  runtime,
  thread,
  locale,
  onOpenThread,
}: {
  client: ExtensionClient;
  runtime: BusinessExtensionThreadRuntime;
  thread: Thread | null;
  locale: Locale;
  onOpenThread(threadId: string): void;
}) {
  const [entry, setEntry] = useState<ExtensionCatalogEntry | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setEntry(null);
    setOpen(false);
    void client
      .listExtensions({ signal: controller.signal })
      .then((catalog) => {
        if (!controller.signal.aborted)
          setEntry(catalog.extensions.find(supportedImageExtension) ?? null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setEntry(null);
      });
    return () => controller.abort();
  }, [client]);
  if (entry === null) return null;
  return (
    <BusinessExtensionEntry
      client={client}
      runtime={runtime}
      entry={entry}
      thread={thread}
      locale={locale}
      open={open}
      setOpen={setOpen}
      onOpenThread={onOpenThread}
    />
  );
}

function BusinessExtensionEntry({
  client,
  runtime,
  entry,
  thread,
  locale,
  open,
  setOpen,
  onOpenThread,
}: {
  client: BusinessExtensionClient;
  runtime: BusinessExtensionThreadRuntime;
  entry: ExtensionCatalogEntry;
  thread: Thread | null;
  locale: Locale;
  open: boolean;
  setOpen(open: boolean): void;
  onOpenThread(threadId: string): void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const openingTask = useRef(false);
  const panel = useBusinessExtension({
    client,
    runtime,
    entry,
    thread,
    locale,
    open,
    onCommitted: (threadId) => {
      openingTask.current = true;
      setOpen(false);
      onOpenThread(threadId);
    },
  });
  const zh = locale === "zh";
  return (
    <>
      <button
        ref={trigger}
        className="button compact"
        type="button"
        onClick={() => {
          openingTask.current = false;
          setOpen(true);
        }}
      >
        <Puzzle aria-hidden="true" />
        {zh ? "业务插件" : "Business plugins"}
      </button>
      {open ? (
        <ModalDialog
          title={entry.title}
          kicker={zh ? "业务插件" : "Business plugin"}
          closeLabel={zh ? "关闭业务插件" : "Close business plugin"}
          size="wide"
          busy={panel.busy !== null}
          onClose={() => setOpen(false)}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!openingTask.current && trigger.current?.isConnected)
              trigger.current.focus();
          }}
        >
          <BusinessExtensionPanel
            {...panel}
            title={entry.title}
            description={entry.description}
            onOpenRun={(runId) => {
              const task = panel.tasks.find((item) => item.runId === runId);
              if (task && thread) {
                openingTask.current = true;
                setOpen(false);
                onOpenThread(thread.id);
              }
            }}
          />
        </ModalDialog>
      ) : null}
    </>
  );
}
