use std::sync::Arc;

use chrono::Utc;
use crewon_app_server_protocol::ClientResponsePayload;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::ResourceBindParams;
use crewon_app_server_protocol::ResourceBindResponse;
use crewon_app_server_protocol::ResourceBindingUpdatedNotification;
use crewon_app_server_protocol::ResourceUnbindParams;
use crewon_app_server_protocol::ResourceUnbindResponse;
use crewon_app_server_protocol::ServerNotification;
use crewon_app_server_protocol::SortDirection;
use crewon_app_server_protocol::ThreadExecutionContext;
use crewon_app_server_protocol::ThreadExecutionContextUpdateParams;
use crewon_app_server_protocol::ThreadExecutionContextUpdateResponse;
use crewon_app_server_protocol::ThreadReadParams;
use crewon_app_server_protocol::ThreadReadResponse;
use crewon_app_server_protocol::ThreadResumeParams;
use crewon_app_server_protocol::ThreadTurnsListParams;
use crewon_app_server_protocol::ThreadTurnsListResponse;
use crewon_app_server_protocol::Turn;
use crewon_app_server_protocol::TurnInterruptParams;
use crewon_app_server_protocol::TurnInterruptResponse;
use crewon_app_server_protocol::TurnItemsView;
use crewon_app_server_protocol::TurnStartParams;
use crewon_app_server_protocol::TurnStartResponse;

use super::MessageProcessor;
use super::message_processor_cloud_agent_validation::cloud_agent_text_input;
use super::message_processor_cloud_agent_validation::map_cloud_agent_thread_projection_error;
use super::message_processor_cloud_agent_validation::map_cloud_agent_turn_error;
use super::message_processor_cloud_agent_validation::map_cloud_agent_turn_interrupt_error;
use crate::error_code::internal_error;
use crate::error_code::invalid_params;
use crate::error_code::invalid_request;
use crate::outgoing_message::ConnectionId;
use crate::platform_control::RequestIdentity;
use crate::platform_control::WorkspaceRegistry;
use crate::platform_control::thread_execution_context_runtime::ThreadExecutionContextRequestRuntime;
use crate::request_processors::ensure_local_core_turn_route;
use crate::task_control::cloud_agent_thread_projection::CloudAgentThreadProjectionRuntime;
use crate::task_control::cloud_agent_thread_projection::CloudAgentThreadResumeProjection;

pub(super) struct CloudAgentTurnStartDispatch {
    pub(super) response: TurnStartResponse,
    pub(super) notification_turn: Option<Turn>,
    pub(super) thread_id: String,
}

impl MessageProcessor {
    pub(super) fn cloud_agent_thread_projection_runtime(
        &self,
        identity: &RequestIdentity,
    ) -> Option<CloudAgentThreadProjectionRuntime> {
        self.state_db.as_ref().map(|state| {
            CloudAgentThreadProjectionRuntime::new(Arc::clone(state), identity.clone())
        })
    }

    pub(super) fn thread_execution_context_runtime(
        &self,
        identity: &RequestIdentity,
        workspace_registry: &Arc<WorkspaceRegistry>,
    ) -> Option<ThreadExecutionContextRequestRuntime> {
        self.state_db.as_ref().map(|state| {
            ThreadExecutionContextRequestRuntime::new(
                identity.clone(),
                Arc::clone(workspace_registry),
                self.workspace_root_catalog.clone(),
                Arc::clone(state),
            )
        })
    }

    pub(super) fn thread_execution_context_runtime_if_authenticated(
        &self,
        identity: &RequestIdentity,
        workspace_registry: &Arc<WorkspaceRegistry>,
    ) -> Result<Option<ThreadExecutionContextRequestRuntime>, JSONRPCErrorError> {
        if identity.authenticated_principal().is_none() {
            return Ok(None);
        }
        self.thread_execution_context_runtime(identity, workspace_registry)
            .map(Some)
            .ok_or_else(|| internal_error("Thread execution context state is unavailable"))
    }

    pub(super) async fn authorize_thread_execution_context_access(
        &self,
        identity: &RequestIdentity,
        workspace_registry: &Arc<WorkspaceRegistry>,
        thread_id: &str,
    ) -> Result<(), JSONRPCErrorError> {
        if let Some(runtime) = self.thread_execution_context_runtime(identity, workspace_registry) {
            runtime.authorize_existing(thread_id).await?;
        }
        Ok(())
    }

    pub(super) async fn prepare_thread_dynamic_tools_for_turn(
        &self,
        identity: &RequestIdentity,
        workspace_registry: &Arc<WorkspaceRegistry>,
        thread_id: &str,
    ) -> Result<Option<ThreadExecutionContext>, JSONRPCErrorError> {
        let Some(runtime) = self.thread_execution_context_runtime(identity, workspace_registry)
        else {
            return Ok(None);
        };
        let Some(execution_context) = runtime.read_owned(thread_id).await? else {
            return Ok(None);
        };
        ensure_local_core_turn_route(&execution_context)?;
        let bindings = runtime.owned_binding_records(thread_id).await?;
        let provider_specs = if has_executable_provider_bindings(&bindings) {
            let provider_runtime = self
                .provider_connection_runtime
                .as_ref()
                .ok_or_else(|| invalid_request("Provider dynamic tool runtime is unavailable"))?;
            crate::platform_control::thread_dynamic_tool_projection::project_provider_dynamic_tools(
                provider_runtime,
                identity,
                &bindings,
            )
            .await
            .map_err(|_| invalid_request("Provider dynamic tool projection failed"))?
        } else {
            Vec::new()
        };
        let (_, thread) = self
            .thread_processor
            .ensure_thread_loaded(thread_id)
            .await?;
        if provider_specs.is_empty() {
            self.dynamic_tool_server.clear_thread(thread_id).await;
        } else {
            self.dynamic_tool_server
                .bind_turn(
                    thread_id,
                    identity.clone(),
                    execution_context.workspace.clone(),
                )
                .await
                .map_err(|_| {
                    invalid_request("Provider dynamic tool authority capacity was exceeded")
                })?;
        }
        crate::platform_control::thread_dynamic_tool_projection::replace_thread_provider_dynamic_tools(
            &thread,
            provider_specs,
        )
        .await;
        Ok(Some(execution_context))
    }

    pub(super) async fn start_cloud_agent_turn_if_bound(
        &self,
        request_id: &crate::outgoing_message::ConnectionRequestId,
        identity: &RequestIdentity,
        workspace_registry: &Arc<WorkspaceRegistry>,
        params: &TurnStartParams,
    ) -> Result<Option<CloudAgentTurnStartDispatch>, JSONRPCErrorError> {
        let Some(runtime) = self.thread_execution_context_runtime(identity, workspace_registry)
        else {
            return Ok(None);
        };
        let Some(context) = runtime.read_owned(&params.thread_id).await? else {
            return Ok(None);
        };
        if context.execution_binding.is_none() {
            return Ok(None);
        }
        if !self.durable_cloud_agent_enabled {
            return Err(invalid_request("Durable Cloud Agent execution is disabled"));
        }
        let client_user_message_id = params
            .client_user_message_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| invalid_params("Cloud Agent turn/start requires clientUserMessageId"))?;
        let prompt = cloud_agent_text_input(params)?;
        let state = self
            .state_db
            .as_ref()
            .ok_or_else(|| internal_error("Cloud Agent Turn state is unavailable"))?;
        let result = crate::task_control::cloud_agent_turn_coordinator::start_cloud_agent_turn(
            crate::task_control::cloud_agent_turn_coordinator::CloudAgentTurnStartRequest {
                state: state.as_ref(),
                identity,
                workspace: &context.workspace,
                thread_id: &params.thread_id,
                client_user_message_id,
                prompt,
                context_fragments: Vec::new(),
                now: Utc::now().timestamp(),
            },
        )
        .await
        .map_err(map_cloud_agent_turn_error)?;
        self.outgoing
            .record_request_turn_id(request_id, &result.turn.turn_id)
            .await;
        let mut projection =
            CloudAgentThreadProjectionRuntime::new(Arc::clone(state), identity.clone())
                .project_exact_turn(
                    &result.turn.thread_id,
                    &result.turn.turn_id,
                    Some(result.turn.revision),
                    TurnItemsView::Full,
                )
                .await
                .map_err(map_cloud_agent_thread_projection_error)?
                .ok_or_else(|| internal_error("Cloud Agent Turn projection is unavailable"))?;
        let notification_turn = result.created.then(|| projection.clone());
        if result.created {
            projection.items.clear();
            projection.items_view = TurnItemsView::NotLoaded;
        }
        Ok(Some(CloudAgentTurnStartDispatch {
            response: TurnStartResponse { turn: projection },
            notification_turn,
            thread_id: result.turn.thread_id,
        }))
    }

    pub(super) async fn interrupt_cloud_agent_turn_if_bound(
        &self,
        identity: &RequestIdentity,
        params: &TurnInterruptParams,
    ) -> Result<Option<TurnInterruptResponse>, JSONRPCErrorError> {
        let Some(state) = self.state_db.as_ref() else {
            return Ok(None);
        };
        crate::task_control::cloud_agent_turn_cancellation::interrupt_cloud_agent_turn(
            crate::task_control::cloud_agent_turn_cancellation::CloudAgentTurnInterruptRequest {
                state: Arc::clone(state),
                identity,
                thread_id: &params.thread_id,
                turn_id: &params.turn_id,
                now: Utc::now().timestamp(),
            },
        )
        .await
        .map(|result| result.map(|_| TurnInterruptResponse {}))
        .map_err(map_cloud_agent_turn_interrupt_error)
    }

    pub(super) async fn read_cloud_agent_thread_if_bound(
        &self,
        identity: &RequestIdentity,
        params: &ThreadReadParams,
    ) -> Result<Option<ThreadReadResponse>, JSONRPCErrorError> {
        let Some(runtime) = self.cloud_agent_thread_projection_runtime(identity) else {
            return Ok(None);
        };
        let Some(status) = runtime
            .read_status(&params.thread_id)
            .await
            .map_err(map_cloud_agent_thread_projection_error)?
        else {
            return Ok(None);
        };
        let mut response = self
            .thread_processor
            .thread_read_response(ThreadReadParams {
                thread_id: params.thread_id.clone(),
                include_turns: false,
            })
            .await?;
        response.thread.status = status;
        if params.include_turns {
            let projection = runtime
                .read_all(&params.thread_id, TurnItemsView::Full)
                .await
                .map_err(map_cloud_agent_thread_projection_error)?
                .ok_or_else(|| internal_error("Cloud Agent Thread projection disappeared"))?;
            response.thread.turns = projection.turns;
            response.thread.status = projection.status;
        }
        Ok(Some(response))
    }

    pub(super) async fn list_cloud_agent_turns_if_bound(
        &self,
        identity: &RequestIdentity,
        params: &ThreadTurnsListParams,
    ) -> Result<Option<ThreadTurnsListResponse>, JSONRPCErrorError> {
        let Some(runtime) = self.cloud_agent_thread_projection_runtime(identity) else {
            return Ok(None);
        };
        runtime
            .list_page(
                &params.thread_id,
                params.cursor.as_deref(),
                params.limit,
                params.sort_direction.unwrap_or(SortDirection::Desc),
                params.items_view.unwrap_or(TurnItemsView::Summary),
            )
            .await
            .map_err(map_cloud_agent_thread_projection_error)
    }

    pub(super) async fn prepare_cloud_agent_resume_if_bound(
        &self,
        identity: &RequestIdentity,
        params: &ThreadResumeParams,
    ) -> Result<Option<CloudAgentThreadResumeProjection>, JSONRPCErrorError> {
        let Some(runtime) = self.cloud_agent_thread_projection_runtime(identity) else {
            return Ok(None);
        };
        let projection = runtime
            .resume_projection(
                &params.thread_id,
                !params.exclude_turns,
                params.initial_turns_page.as_ref(),
            )
            .await
            .map_err(map_cloud_agent_thread_projection_error)?;
        if projection.is_some() && (params.history.is_some() || params.path.is_some()) {
            return Err(invalid_request(
                "Cloud Agent thread/resume does not support history or path overrides",
            ));
        }
        Ok(projection)
    }

    pub(super) async fn update_thread_execution_context(
        &self,
        identity: &RequestIdentity,
        workspace_registry: &Arc<WorkspaceRegistry>,
        params: ThreadExecutionContextUpdateParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        let thread_id = params.thread_id.clone();
        let (_, thread) = self
            .thread_processor
            .ensure_thread_loaded(&thread_id)
            .await?;
        crate::request_processors::cloud_agent_thread_source_fence::ensure_loaded_thread_mutation_allowed(
            thread.as_ref(),
            "thread/executionContext/update",
        )
        .await?;
        let runtime = self
            .thread_execution_context_runtime(identity, workspace_registry)
            .ok_or_else(|| internal_error("Thread execution context state is unavailable"))?;
        let prepared = runtime
            .prepare_update(params, Utc::now().timestamp())
            .await?;
        if prepared.uses_execution_binding() {
            self.thread_processor
                .ensure_execution_binding_can_attach(&thread_id)
                .await?;
        }
        let provider_specs = if has_executable_provider_bindings(prepared.bindings()) {
            let provider_runtime = self
                .provider_connection_runtime
                .as_ref()
                .ok_or_else(|| invalid_request("Provider dynamic tool runtime is unavailable"))?;
            crate::platform_control::thread_dynamic_tool_projection::project_provider_dynamic_tools(
                provider_runtime,
                identity,
                prepared.bindings(),
            )
            .await
            .map_err(|_| invalid_request("Provider dynamic tool projection failed"))?
        } else {
            Vec::new()
        };
        let execution_context = runtime.commit_update(prepared).await?;
        if provider_specs.is_empty() {
            self.dynamic_tool_server.clear_thread(&thread_id).await;
        }
        crate::platform_control::thread_dynamic_tool_projection::replace_thread_provider_dynamic_tools(
            &thread,
            provider_specs,
        )
        .await;
        Ok(Some(
            ThreadExecutionContextUpdateResponse { execution_context }.into(),
        ))
    }

    pub(super) async fn bind_provider_resource(
        &self,
        connection_id: ConnectionId,
        identity: &RequestIdentity,
        workspace_registry: &Arc<WorkspaceRegistry>,
        params: ResourceBindParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        let workspace = workspace_registry
            .resolve_binding_ref_with_state(
                identity,
                &self.workspace_root_catalog,
                self.state_db.as_deref(),
                &params.workspace_binding_id,
            )
            .await?;
        let binding = self
            .provider_resource_processor
            .bind(identity, &workspace, params)
            .await?;
        self.outgoing
            .send_server_notification_to_connections(
                &[connection_id],
                ServerNotification::ResourceBindingUpdated(ResourceBindingUpdatedNotification {
                    binding: binding.clone(),
                }),
            )
            .await;
        Ok(Some(ResourceBindResponse { binding }.into()))
    }

    pub(super) async fn unbind_provider_resource(
        &self,
        connection_id: ConnectionId,
        identity: &RequestIdentity,
        params: ResourceUnbindParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError> {
        let binding = self
            .provider_resource_processor
            .unbind(identity, params)
            .await?;
        self.outgoing
            .send_server_notification_to_connections(
                &[connection_id],
                ServerNotification::ResourceBindingUpdated(ResourceBindingUpdatedNotification {
                    binding: binding.clone(),
                }),
            )
            .await;
        Ok(Some(
            ResourceUnbindResponse {
                binding_id: binding.binding.binding_id,
                status: binding.status,
                revision: binding.revision,
                updated_at: binding.updated_at,
            }
            .into(),
        ))
    }
}

fn has_executable_provider_bindings(
    bindings: &[crewon_state::ProviderResourceBindingRecord],
) -> bool {
    bindings.iter().any(|binding| {
        matches!(
            binding.resource_kind,
            crewon_state::ProviderResourceKind::McpTool
                | crewon_state::ProviderResourceKind::KnowledgeBase
        )
    })
}
