pub(super) const PROVIDER_DISCOVERY_SCOPE: &str = "provider.discovery";
pub(super) const PROVIDER_KNOWLEDGE_SEARCH_SCOPE: &str = "providerKnowledge:search";
pub(super) const PROVIDER_RUN_CANCEL_SCOPE: &str = "providerRun:cancel";
pub(super) const PROVIDER_RUN_EVENTS_SCOPE: &str = "providerRun:events";
pub(super) const PROVIDER_RUN_READ_SCOPE: &str = "providerRun:read";
pub(super) const PROVIDER_RUN_START_SCOPE: &str = "providerRun:start";
pub(super) const PROVIDER_TOOL_CALL_SCOPE: &str = "providerTool:call";

const AGENT_PLATFORM_SCOPES: [&str; 7] = [
    PROVIDER_DISCOVERY_SCOPE,
    PROVIDER_KNOWLEDGE_SEARCH_SCOPE,
    PROVIDER_RUN_CANCEL_SCOPE,
    PROVIDER_RUN_EVENTS_SCOPE,
    PROVIDER_RUN_READ_SCOPE,
    PROVIDER_RUN_START_SCOPE,
    PROVIDER_TOOL_CALL_SCOPE,
];

pub(crate) fn agent_platform_scopes() -> Vec<String> {
    AGENT_PLATFORM_SCOPES.map(str::to_string).to_vec()
}

pub(crate) fn has_exact_agent_platform_scopes(scopes: &[String]) -> bool {
    scopes.iter().map(String::as_str).eq(AGENT_PLATFORM_SCOPES)
}
