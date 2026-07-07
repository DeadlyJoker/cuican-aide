import type { Thread } from "@crewon-protocol/v2/Thread";

import { threadTitle } from "../thread/threadModel";

export function appDocumentTitle(params: {
  composerValue: string;
  productName?: string;
  thread: Thread | null;
  untitledThreadLabel: string;
}): string {
  const productName = params.productName ?? "Crewon";
  const title = params.thread
    ? `${threadTitle(params.thread, params.untitledThreadLabel)} - ${productName}`
    : productName;
  return params.composerValue.trim() ? `* ${title}` : title;
}
