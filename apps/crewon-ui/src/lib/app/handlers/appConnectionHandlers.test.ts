import type { Thread } from "@crewon-protocol/v2/Thread";
import { describe, expect, it, vi } from "vitest";

import { AppServerClient } from "../../app-server/appServer";
import { createAppConnectionHandlers } from "./appConnectionHandlers";
import type { ConnectionState, NoticeState } from "../appRuntimeState";
import { getDemoThreads } from "../../demo/demoData";
import type { Locale } from "../../i18n";

describe("app connection handlers", () => {
  it("reads the current client when retrying a connection", () => {
    let connectionAttempt = 1;
    let connectionState: ConnectionState = "demo";
    let notice: NoticeState | null = { text: "offline", tone: "warning" };
    let streamingTextByThread: Record<string, string> = { thread: "partial" };
    let currentClient: AppServerClient | null = null;
    const client = new AppServerClient("ws://localhost:0", () => {});
    const close = vi.spyOn(client, "close");

    const handlers = createAppConnectionHandlers({
      getClient: () => currentClient,
      localeRef: { current: "en" },
      setConnectionAttempt: (updater) => {
        connectionAttempt = updater(connectionAttempt);
      },
      setConnectionState: (state) => {
        connectionState = state;
      },
      setNotice: (nextNotice) => {
        notice = nextNotice;
      },
      setSelectedThreadId: () => {},
      setStreamingTextByThread: (nextStreamingText) => {
        streamingTextByThread = nextStreamingText;
      },
      setThreads: () => {},
    });

    currentClient = client;
    handlers.retryConnection();

    expect(close).toHaveBeenCalledOnce();
    expect(connectionAttempt).toBe(2);
    expect(connectionState).toBe("connecting");
    expect(notice).toBeNull();
    expect(streamingTextByThread).toEqual({});
  });

  it("uses current locale refs for demo connection fallback", () => {
    const localeRef = { current: "en" as Locale };
    let connectionState: ConnectionState = "connected";
    let notice: NoticeState | null = null;
    let selectedThreadId: string | null = null;
    let streamingTextByThread: Record<string, string> = { old: "text" };
    let threads: Thread[] = [];

    const handlers = createAppConnectionHandlers({
      getClient: () => null,
      localeRef,
      setConnectionAttempt: () => {},
      setConnectionState: (state) => {
        connectionState = state;
      },
      setNotice: (nextNotice) => {
        notice = nextNotice;
      },
      setSelectedThreadId: (threadId) => {
        selectedThreadId = threadId;
      },
      setStreamingTextByThread: (nextStreamingText) => {
        streamingTextByThread = nextStreamingText;
      },
      setThreads: (nextThreads) => {
        threads = nextThreads;
      },
    });

    localeRef.current = "zh";
    handlers.switchToDemoThreads(false);

    expect(connectionState).toBe("demo");
    expect(notice).toBeNull();
    expect(streamingTextByThread).toEqual({});
    expect(selectedThreadId).toBe(threads[0]?.id ?? null);
    expect(threads[0]?.name).toBe(getDemoThreads("zh")[0]?.name);
    expect(threads[0]?.name).not.toBe(getDemoThreads("en")[0]?.name);
  });
});
