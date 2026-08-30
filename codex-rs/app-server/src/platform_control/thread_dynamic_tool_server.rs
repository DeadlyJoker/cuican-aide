use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use crewon_app_server_protocol::DynamicToolCallOutputContentItem;
use crewon_app_server_protocol::DynamicToolCallResponse;
use crewon_app_server_protocol::WorkspaceRef;
use crewon_policy::AccessDecisionId;
use crewon_policy::ActionNonce;
use crewon_policy::ActionPurpose;
use crewon_state::ProviderResourceBindingRecord;
use crewon_state::StateRuntime;
use tokio::sync::RwLock;
use uuid::Uuid;

use super::RequestIdentity;
use super::dynamic_tool_router::credential_resolver::StateDynamicToolCredentialResolver;
use super::dynamic_tool_router::dispatch::DynamicToolDispatchConfig;
use super::dynamic_tool_router::dispatch::DynamicToolDispatchOutcome;
use super::dynamic_tool_router::dispatch::DynamicToolDispatcher;
use super::dynamic_tool_router::execution::DynamicToolAdmissionOutcome;
use super::dynamic_tool_router::execution::DynamicToolAdmissionRouter;
use super::dynamic_tool_router::execution::DynamicToolAuthorization;
use super::dynamic_tool_router::execution::DynamicToolConversationExecution;
use super::dynamic_tool_router::execution::DynamicToolPolicyContext;
use super::dynamic_tool_router::provider_artifact_importer::StateProviderDynamicArtifactImporter;
use super::dynamic_tool_router::provider_executor::AgentPlatformDynamicToolExecutor;
use super::dynamic_tool_router::registration::DynamicToolInvocation;
use super::dynamic_tool_router::registration::DynamicToolRegistration;
use super::dynamic_tool_router::registration::DynamicToolRegistry;
use super::dynamic_tool_router::registration::is_provider_dynamic_tool_namespace;
use super::dynamic_tool_router::registration::namespace_for_binding;
use super::dynamic_tool_router::state_binding_reader::StateDynamicToolBindingReader;
use super::dynamic_tool_router::state_journal::StateDynamicToolExecutionJournal;
use super::provider_connection_descriptor::ProviderConnectionClock;
use super::provider_connection_production::SystemProviderConnectionClock;
use super::provider_connection_startup::PreparedProviderConnectionRuntime;
use super::thread_dynamic_tool_projection::side_effect;
use super::thread_execution_context_adapter::authorize_thread_execution_context_record;

const MAX_THREAD_AUTHORITIES: usize = 4_096;
const ACTION_TTL_SECONDS: i64 = 60;
const DISPATCH_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
struct ThreadDynamicToolAuthority {
    identity: RequestIdentity,
    workspace: WorkspaceRef,
}

pub(crate) struct ThreadDynamicToolServer {
    provider: Option<Arc<PreparedProviderConnectionRuntime<SystemProviderConnectionClock>>>,
    authorities: RwLock<HashMap<String, ThreadDynamicToolAuthority>>,
}

impl ThreadDynamicToolServer {
    pub(crate) fn new(
        provider: Option<Arc<PreparedProviderConnectionRuntime<SystemProviderConnectionClock>>>,
    ) -> Self {
        Self {
            provider,
            authorities: RwLock::new(HashMap::new()),
        }
    }

    pub(crate) async fn bind_turn(
        &self,
        thread_id: &str,
        identity: RequestIdentity,
        workspace: WorkspaceRef,
    ) -> Result<(), ThreadDynamicToolServerError> {
        let mut authorities = self.authorities.write().await;
        if !authorities.contains_key(thread_id) && authorities.len() >= MAX_THREAD_AUTHORITIES {
            return Err(ThreadDynamicToolServerError::CapacityExceeded);
        }
        authorities.insert(
            thread_id.to_string(),
            ThreadDynamicToolAuthority {
                identity,
                workspace,
            },
        );
        Ok(())
    }

    pub(crate) async fn clear_thread(&self, thread_id: &str) {
        self.authorities.write().await.remove(thread_id);
    }

    pub(crate) async fn dispatch(
        &self,
        thread_id: &str,
        turn_id: &str,
        call_id: String,
        namespace: Option<String>,
        tool: String,
        arguments: serde_json::Value,
    ) -> Option<DynamicToolCallResponse> {
        if !is_provider_dynamic_tool_namespace(namespace.as_deref()) {
            return None;
        }
        let Some(namespace) = namespace else {
            return Some(failure("Provider tool request is invalid."));
        };
        let response = self
            .dispatch_provider(thread_id, turn_id, call_id, namespace, tool, arguments)
            .await
            .unwrap_or_else(|error| failure(error.user_message()));
        Some(response)
    }

    async fn dispatch_provider(
        &self,
        thread_id: &str,
        turn_id: &str,
        call_id: String,
        namespace: String,
        tool: String,
        arguments: serde_json::Value,
    ) -> Result<DynamicToolCallResponse, ThreadDynamicToolServerError> {
        let provider = self
            .provider
            .as_ref()
            .ok_or(ThreadDynamicToolServerError::Unavailable)?;
        let authority = self
            .authorities
            .read()
            .await
            .get(thread_id)
            .cloned()
            .ok_or(ThreadDynamicToolServerError::AuthorityMissing)?;
        let state = provider.state();
        let context = state
            .get_thread_execution_context_record(thread_id)
            .await
            .map_err(|_| ThreadDynamicToolServerError::Unavailable)?
            .ok_or(ThreadDynamicToolServerError::AuthorityMissing)?;
        authorize_thread_execution_context_record(&authority.identity, &context)
            .map_err(|_| ThreadDynamicToolServerError::Unauthorized)?;
        if context.workspace_key != authority.workspace.workspace_key
            || context.workspace_scope_id != authority.workspace.scope_id
        {
            return Err(ThreadDynamicToolServerError::Unauthorized);
        }
        let binding = matching_binding(state, &context, &namespace, &tool).await?;
        let manifest = provider
            .read_dynamic_manifest(&authority.identity, &binding)
            .await
            .map_err(|_| ThreadDynamicToolServerError::AuthorityChanged)?;
        let registration =
            DynamicToolRegistration::from_binding(binding, side_effect(manifest.side_effect()))
                .map_err(|_| ThreadDynamicToolServerError::AuthorityChanged)?;
        let registry = DynamicToolRegistry::from_registrations([registration])
            .map_err(|_| ThreadDynamicToolServerError::AuthorityChanged)?;
        let invocation = DynamicToolInvocation::new(call_id.clone(), namespace, tool, arguments)
            .map_err(|_| ThreadDynamicToolServerError::InvalidRequest)?;
        let now = provider.clock().now();
        let expires_at = now
            .checked_add(ACTION_TTL_SECONDS)
            .ok_or(ThreadDynamicToolServerError::Unavailable)?;
        let binding_reader = StateDynamicToolBindingReader::new(state.as_ref());
        let credential_resolver = StateDynamicToolCredentialResolver::new(
            state.as_ref(),
            provider.readiness(),
            provider.clock(),
        );
        let journal = StateDynamicToolExecutionJournal::new(Arc::clone(state), *provider.clock());
        let admission = DynamicToolAdmissionRouter::new(
            &registry,
            &binding_reader,
            &credential_resolver,
            &journal,
        )
        .admit(
            &authority.identity,
            &authority.workspace,
            invocation,
            DynamicToolPolicyContext {
                purpose: ActionPurpose::new("providerDynamicTool.execute")
                    .map_err(|_| ThreadDynamicToolServerError::InvalidRequest)?,
                expires_at,
                nonce: ActionNonce::new(format!("dynamic-tool-{}", Uuid::now_v7()))
                    .map_err(|_| ThreadDynamicToolServerError::InvalidRequest)?,
                execution: DynamicToolConversationExecution::new(thread_id, turn_id)
                    .map_err(|_| ThreadDynamicToolServerError::InvalidRequest)?,
            },
            DynamicToolAuthorization::Evaluate(
                AccessDecisionId::new(format!("dynamic-tool-{}", Uuid::now_v7()))
                    .map_err(|_| ThreadDynamicToolServerError::InvalidRequest)?,
            ),
            now,
        )
        .await
        .map_err(|_| ThreadDynamicToolServerError::Unauthorized)?;
        let DynamicToolAdmissionOutcome::Authorized(authorized) = admission else {
            return Err(match admission {
                DynamicToolAdmissionOutcome::ApprovalRequired { .. } => {
                    ThreadDynamicToolServerError::ApprovalRequired
                }
                DynamicToolAdmissionOutcome::Denied(_) => ThreadDynamicToolServerError::Denied,
                DynamicToolAdmissionOutcome::Duplicate => ThreadDynamicToolServerError::Duplicate,
                DynamicToolAdmissionOutcome::Authorized(_) => unreachable!(),
            });
        };
        let importer =
            StateProviderDynamicArtifactImporter::new(Arc::clone(state), *provider.clock());
        let executor =
            AgentPlatformDynamicToolExecutor::new(provider.provider_factory(), &importer);
        let config = DynamicToolDispatchConfig::new(DISPATCH_TIMEOUT)
            .map_err(|_| ThreadDynamicToolServerError::Unavailable)?;
        let outcome = DynamicToolDispatcher::new(&executor, &journal, config)
            .dispatch(*authorized)
            .await
            .map_err(|_| ThreadDynamicToolServerError::UnknownOutcome)?;
        Ok(match outcome {
            DynamicToolDispatchOutcome::Succeeded(result) => {
                if let Some(response) = result.inline_response() {
                    response.clone()
                } else if let Some(artifact) = result.artifact_ref() {
                    DynamicToolCallResponse {
                        content_items: vec![DynamicToolCallOutputContentItem::InputText {
                            text: format!(
                                "Provider result saved as artifact {} revision {}.",
                                artifact.artifact_id().as_str(),
                                artifact.revision().get()
                            ),
                        }],
                        success: true,
                    }
                } else {
                    failure("Provider tool returned an invalid result.")
                }
            }
            DynamicToolDispatchOutcome::Failed(_) => failure("Provider tool execution failed."),
            DynamicToolDispatchOutcome::Unknown(_) => {
                failure("Provider tool outcome is unknown; it was not retried.")
            }
        })
    }
}

async fn matching_binding(
    state: &StateRuntime,
    context: &crewon_state::ThreadExecutionContextRecord,
    namespace: &str,
    tool: &str,
) -> Result<ProviderResourceBindingRecord, ThreadDynamicToolServerError> {
    for reference in &context.resource_bindings {
        let binding = state
            .get_provider_resource_binding_record(&reference.binding_id)
            .await
            .map_err(|_| ThreadDynamicToolServerError::Unavailable)?
            .ok_or(ThreadDynamicToolServerError::AuthorityChanged)?;
        let expected_tool = match binding.resource_kind {
            crewon_state::ProviderResourceKind::McpTool => "call",
            crewon_state::ProviderResourceKind::KnowledgeBase => "search",
            crewon_state::ProviderResourceKind::Agent
            | crewon_state::ProviderResourceKind::Skill
            | crewon_state::ProviderResourceKind::McpServer
            | crewon_state::ProviderResourceKind::Workflow => continue,
        };
        if namespace_for_binding(&binding.binding_id)
            .map_err(|_| ThreadDynamicToolServerError::AuthorityChanged)?
            == namespace
            && expected_tool == tool
        {
            if binding.revision != reference.revision {
                return Err(ThreadDynamicToolServerError::AuthorityChanged);
            }
            return Ok(binding);
        }
    }
    Err(ThreadDynamicToolServerError::UnknownTool)
}

fn failure(message: &str) -> DynamicToolCallResponse {
    DynamicToolCallResponse {
        content_items: vec![DynamicToolCallOutputContentItem::InputText {
            text: message.to_string(),
        }],
        success: false,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum ThreadDynamicToolServerError {
    #[error("Provider dynamic tool runtime is unavailable")]
    Unavailable,
    #[error("Provider dynamic tool thread authority is missing")]
    AuthorityMissing,
    #[error("Provider dynamic tool request is not authorized")]
    Unauthorized,
    #[error("Provider dynamic tool authority changed")]
    AuthorityChanged,
    #[error("Provider dynamic tool request is invalid")]
    InvalidRequest,
    #[error("Provider dynamic tool is not bound to this thread")]
    UnknownTool,
    #[error("Provider dynamic tool requires approval")]
    ApprovalRequired,
    #[error("Provider dynamic tool was denied")]
    Denied,
    #[error("Provider dynamic tool call was already processed")]
    Duplicate,
    #[error("Provider dynamic tool outcome is unknown")]
    UnknownOutcome,
    #[error("Provider dynamic tool authority capacity was exceeded")]
    CapacityExceeded,
}

impl ThreadDynamicToolServerError {
    fn user_message(self) -> &'static str {
        match self {
            Self::ApprovalRequired => {
                "This Provider tool requires approval, which is not available in this runtime."
            }
            Self::Duplicate => "This Provider tool call was already processed and was not retried.",
            Self::UnknownOutcome => "Provider tool outcome is unknown; it was not retried.",
            Self::Unavailable => "Provider tool runtime is unavailable.",
            Self::AuthorityMissing
            | Self::Unauthorized
            | Self::AuthorityChanged
            | Self::InvalidRequest
            | Self::UnknownTool
            | Self::Denied
            | Self::CapacityExceeded => {
                "Provider tool access is no longer authorized for this conversation."
            }
        }
    }
}

impl std::fmt::Debug for ThreadDynamicToolServer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ThreadDynamicToolServer([REDACTED])")
    }
}
