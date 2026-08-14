import type { Locale } from "../../lib/i18n";

export const WORKSPACE_COPY = {
  zh: {
    panelTitle: "工作空间操作",
    safeEntriesOnly: "仅显示顶层安全条目",
    processing: "处理中…",
    readTopLevel: "读取顶层目录",
    selectWorkspace: "选择工作空间",
    replaceWorkspace: "更换",
    clearWorkspace: "清除",
    nativeWorkspaceLabel: "本机工作空间",
    nativeActiveAuthority:
      "请先结束活动任务或工作空间操作，再更换本机工作空间。",
    nativeConflict: "本机工作空间状态已变化，请检查当前选择后再继续。",
    nativeUnavailable: "本机工作空间 authority 暂不可用。",
    nativeUnknown: "本机工作空间操作结果尚未确认，请勿重复提交。",
    rehydrationFailed:
      "本机工作空间已更新，但 Control 运行态恢复失败；当前操作已安全停用。",
    operationsLabel: "工作空间操作记录",
    entriesLabel: "顶层条目",
    reconcile: "重新确认",
    cancel: "取消",
    directory: "文件夹",
    file: "文件",
    deviceResultTruncated: "设备返回的顶层结果已截断。",
    authorityReadOnly:
      "团队环境当前只读；可以查看结果，但不能发起、重新确认或取消工作空间操作。",
    authorityUnavailable:
      "工作空间 Control 服务暂不可用；不会回退到旧文件接口。",
    authoritySelectThread: "选择一个线程后才能读取工作空间顶层目录。",
    authorityInactiveThread: "当前线程不是活动状态，不能发起新的工作空间操作。",
    authorityNoWorkspace: "当前线程没有已选择的工作空间。",
    selectionNone: "未选择线程",
    selectionWorkspace: "当前线程 · 已选择工作空间",
    selectionNoWorkspace: "当前线程 · 未选择工作空间",
    emptyLoading: "正在读取工作空间操作。",
    emptyUnavailable: "工作空间操作当前不可用。",
    empty: "当前线程还没有工作空间操作。",
    liveAvailable: "工作空间 Control 已可用，等待选择线程。",
    liveUnavailable: "工作空间 Control 不可用。",
    liveLoading: "正在同步工作空间操作。",
    live: "工作空间操作已同步。",
    liveMutating: "正在提交工作空间操作。",
    liveConflict: "工作空间状态已变化，请检查刷新后的操作再继续。",
    liveError: "工作空间操作同步失败。",
    stateAvailable: "可用",
    stateUnavailable: "不可用",
    stateLoading: "载入中",
    stateLive: "实时",
    stateMutating: "处理中",
    stateConflict: "状态冲突",
    stateError: "同步失败",
    operationTitle: "顶层目录读取",
    summaryPending: "设备正在读取已授权工作空间的顶层条目。",
    summaryUnknown: "发送结果尚未确认，可以使用相同操作记录重新确认。",
    summaryFailedRetryable: "操作失败，可以重新发起。",
    summaryFailed: "操作失败，当前结果不可重试。",
    summaryCanceled: "操作已取消，没有继续读取工作空间。",
    statusPending: "执行中",
    statusUnknown: "结果待确认",
    statusCompleted: "已完成",
    statusFailed: "失败",
    statusCanceled: "已取消",
  },
  en: {
    panelTitle: "Workspace operations",
    safeEntriesOnly: "Safe top-level entries only",
    processing: "Working…",
    readTopLevel: "Read top level",
    selectWorkspace: "Select Workspace",
    replaceWorkspace: "Replace",
    clearWorkspace: "Clear",
    nativeWorkspaceLabel: "Native Workspace",
    nativeActiveAuthority:
      "End the active task or Workspace operation before changing the native Workspace.",
    nativeConflict:
      "The native Workspace changed. Review the current selection before continuing.",
    nativeUnavailable: "Native Workspace authority is unavailable.",
    nativeUnknown:
      "The native Workspace outcome is unknown. Do not submit it again.",
    rehydrationFailed:
      "The native Workspace changed, but Control runtime recovery failed. Operations are safely disabled.",
    operationsLabel: "Workspace operation records",
    entriesLabel: "Top-level entries",
    reconcile: "Check again",
    cancel: "Cancel",
    directory: "Folder",
    file: "File",
    deviceResultTruncated:
      "The desktop runtime truncated the top-level result.",
    authorityReadOnly:
      "Team environments are currently read-only. Results remain visible, but Workspace operations cannot be started, checked again, or canceled.",
    authorityUnavailable:
      "Workspace Control is unavailable. CrewON will not fall back to the legacy file API.",
    authoritySelectThread:
      "Select a thread before reading the Workspace top level.",
    authorityInactiveThread:
      "The selected thread is not active, so a new Workspace operation cannot start.",
    authorityNoWorkspace: "The selected thread has no selected Workspace.",
    selectionNone: "No thread selected",
    selectionWorkspace: "Current thread · Workspace selected",
    selectionNoWorkspace: "Current thread · No Workspace selected",
    emptyLoading: "Loading Workspace operations.",
    emptyUnavailable: "Workspace operations are unavailable.",
    empty: "This thread has no Workspace operations yet.",
    liveAvailable: "Workspace Control is available and waiting for a thread.",
    liveUnavailable: "Workspace Control is unavailable.",
    liveLoading: "Syncing Workspace operations.",
    live: "Workspace operations are synchronized.",
    liveMutating: "Submitting a Workspace operation.",
    liveConflict:
      "Workspace state changed. Review the refreshed operation before continuing.",
    liveError: "Workspace operation synchronization failed.",
    stateAvailable: "Available",
    stateUnavailable: "Unavailable",
    stateLoading: "Loading",
    stateLive: "Live",
    stateMutating: "Working",
    stateConflict: "Conflict",
    stateError: "Sync failed",
    operationTitle: "Top-level read",
    summaryPending:
      "The desktop runtime is reading safe top-level entries from the authorized Workspace.",
    summaryUnknown:
      "The delivery outcome is not confirmed. Check the same operation record again.",
    summaryFailedRetryable: "The operation failed and can be started again.",
    summaryFailed: "The operation failed and cannot be retried.",
    summaryCanceled: "The operation was canceled without reading further.",
    statusPending: "Running",
    statusUnknown: "Outcome unknown",
    statusCompleted: "Completed",
    statusFailed: "Failed",
    statusCanceled: "Canceled",
  },
} as const;

export type WorkspaceCopyKey = keyof (typeof WORKSPACE_COPY)["zh"];

export function workspaceCopy(locale: Locale, key: WorkspaceCopyKey): string {
  return WORKSPACE_COPY[locale][key];
}
