export type BrowserSkillRef = { skillId: string; versionId: string; contentDigest: string };
export type BrowserGrantRule = {
  action: "navigate" | "click" | "fill" | "select" | "download";
  target?: { role: string; name: string };
  value?: { literal: string } | { parameter: string };
  urlTemplate?: string;
};
export type BrowserGrantScope = { skillVersionRef: BrowserSkillRef; origins: string[]; rules: BrowserGrantRule[] };
export type BrowserExecutionAuthorizationRequest = { threadId: string; scope?: BrowserGrantScope };
export type BrowserExecutionAuthorizationState = { threadId: string; sessionId: string; revision: number; mode: "perAction" | "scoped" };
export interface BrowserExecutionBridge {
  authorize(input: BrowserExecutionAuthorizationRequest): Promise<BrowserExecutionAuthorizationState>;
  revoke(threadId: string): Promise<void>;
  status(threadId: string): Promise<BrowserExecutionAuthorizationState | null>;
}
