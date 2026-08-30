use std::sync::Arc;

use crewon_protocol::dynamic_tools::DynamicToolSpec;
use crewon_provider_agent_platform::AgentPlatformDynamicResourceManifest;
use crewon_provider_agent_platform::ProviderDynamicSideEffect;
use crewon_state::ProviderResourceBindingRecord;

use super::RequestIdentity;
use super::dynamic_tool_router::registration::DynamicToolRegistration;
use super::dynamic_tool_router::registration::DynamicToolRouteError;
use super::dynamic_tool_router::registration::NAMESPACE_PREFIX;
use super::provider_connection_descriptor::ProviderConnectionClock;
use super::provider_connection_startup::PreparedProviderConnectionRuntime;
use super::provider_connection_startup::ProviderResourceRuntimeError;

#[derive(Debug, thiserror::Error)]
pub(crate) enum ThreadDynamicToolProjectionError {
    #[error("Provider dynamic tool authority is unavailable")]
    Provider(#[from] ProviderResourceRuntimeError),
    #[error("Provider dynamic tool binding is invalid")]
    InvalidBinding(#[from] DynamicToolRouteError),
    #[error("Provider dynamic tool schema is unsupported")]
    UnsupportedSchema,
}

pub(crate) async fn project_provider_dynamic_tools<Clock>(
    runtime: &PreparedProviderConnectionRuntime<Clock>,
    identity: &RequestIdentity,
    bindings: &[ProviderResourceBindingRecord],
) -> Result<Vec<DynamicToolSpec>, ThreadDynamicToolProjectionError>
where
    Clock: ProviderConnectionClock,
{
    let mut specs = Vec::new();
    for binding in bindings {
        if !matches!(
            binding.resource_kind,
            crewon_state::ProviderResourceKind::McpTool
                | crewon_state::ProviderResourceKind::KnowledgeBase
        ) {
            continue;
        }
        let manifest = runtime.read_dynamic_manifest(identity, binding).await?;
        specs.push(spec_from_manifest(binding.clone(), &manifest)?);
    }
    Ok(specs)
}

fn spec_from_manifest(
    binding: ProviderResourceBindingRecord,
    manifest: &AgentPlatformDynamicResourceManifest,
) -> Result<DynamicToolSpec, ThreadDynamicToolProjectionError> {
    crewon_tools::parse_tool_input_schema(manifest.input_schema())
        .map_err(|_| ThreadDynamicToolProjectionError::UnsupportedSchema)?;
    let registration =
        DynamicToolRegistration::from_binding(binding, side_effect(manifest.side_effect()))
            .map_err(ThreadDynamicToolProjectionError::InvalidBinding)?;
    Ok(DynamicToolSpec {
        namespace: Some(registration.namespace().to_string()),
        name: registration.tool_name().to_string(),
        description: manifest.description().to_string(),
        input_schema: manifest.input_schema().clone(),
        defer_loading: false,
    })
}

pub(crate) fn merge_provider_dynamic_tools(
    current: Vec<DynamicToolSpec>,
    provider: Vec<DynamicToolSpec>,
) -> Vec<DynamicToolSpec> {
    let mut merged: Vec<_> = current
        .into_iter()
        .filter(|tool| {
            !tool
                .namespace
                .as_deref()
                .is_some_and(|namespace| namespace.starts_with(NAMESPACE_PREFIX))
        })
        .collect();
    merged.extend(provider);
    merged
}

pub(crate) async fn replace_thread_provider_dynamic_tools(
    thread: &Arc<crewon_core::CrewonThread>,
    provider: Vec<DynamicToolSpec>,
) {
    let current = thread.dynamic_tools().await;
    thread
        .replace_dynamic_tools(merge_provider_dynamic_tools(current, provider))
        .await;
}

pub(crate) fn side_effect(value: ProviderDynamicSideEffect) -> crewon_policy::SideEffect {
    match value {
        ProviderDynamicSideEffect::ReadOnly => crewon_policy::SideEffect::ReadOnly,
        ProviderDynamicSideEffect::LocalMutation => crewon_policy::SideEffect::LocalMutation,
        ProviderDynamicSideEffect::ExternalWrite => crewon_policy::SideEffect::ExternalWrite,
        ProviderDynamicSideEffect::Send => crewon_policy::SideEffect::Send,
        ProviderDynamicSideEffect::Publish => crewon_policy::SideEffect::Publish,
        ProviderDynamicSideEffect::Delete => crewon_policy::SideEffect::Delete,
        ProviderDynamicSideEffect::Destructive => crewon_policy::SideEffect::Destructive,
    }
}
