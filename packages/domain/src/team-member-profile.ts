/** Prompt labels only. Runtime capability grants are checked by the host. */
export type TeamMemberRuntimeCapability = Readonly<{
  name: string;
  description: string;
}>;

export type TeamMemberRuntimeProfile = Readonly<{
  memberId: string;
  systemPrompt: string;
  skills: readonly TeamMemberRuntimeCapability[];
  mcp: readonly TeamMemberRuntimeCapability[];
  knowledge: readonly TeamMemberRuntimeCapability[];
  teamCoordination?: Readonly<{
    assignmentMode: "roleDirected";
    responsibility: string;
    source: "officeDefinition";
  }>;
}>;
