use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::ThreadExecutionContext;
use crewon_app_server_protocol::ThreadExecutionContextCreateParams;
use crewon_app_server_protocol::ThreadExecutionContextUpdateParams;
use crewon_app_server_protocol::WorkspaceBindParams;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_protocol::ThreadId;
use crewon_state::MAX_THREAD_EXECUTION_CONTEXT_BINDINGS;
use crewon_state::ProviderResourceBindingRecord;
use crewon_state::ProviderResourceBindingStatus;
use crewon_state::StateRuntime;
use crewon_state::ThreadExecutionContextBindingRef;
use crewon_state::ThreadExecutionContextBindingUpdate;
use crewon_state::ThreadExecutionContextCreateOutcome;
use crewon_state::ThreadExecutionContextRecord;
use crewon_state::ThreadExecutionContextUpdateOutcome;

use super::RequestIdentity;
use super::WorkspaceRegistry;
use super::WorkspaceRootCatalog;
use super::thread_execution_context_adapter::ThreadExecutionContextAdapterError;
use super::thread_execution_context_adapter::ThreadExecutionContextBindingSelection;
use super::thread_execution_context_adapter::authorize_thread_execution_context_record;
use super::thread_execution_context_adapter::project_thread_execution_context;
use super::thread_execution_context_adapter::protocol_workspace_scope;
use super::thread_execution_context_adapter::thread_execution_context_binding_update;
use super::thread_execution_context_adapter::thread_execution_context_record;
use super::thread_execution_context_adapter::validate_thread_execution_context_identity;
use crate::error_code::internal_error;
use crate::error_code::invalid_params;
use crate::error_code::invalid_request;

#[derive(Clone)]
pub(crate) struct ThreadExecutionContextRequestRuntime {
    identity: RequestIdentity,
    workspace_registry: Arc<WorkspaceRegistry>,
    workspace_catalog: WorkspaceRootCatalog,
    state: Arc<StateRuntime>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreparedThreadExecutionContextCreate {
    workspace_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ThreadExecutionContextWorkspaceScope {
    Conversation,
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "Office manager/member creation is wired in the next Office runtime stage"
        )
    )]
    Office {
        office_id: String,
    },
}

pub(crate) struct PreparedThreadExecutionContextUpdate {
    current: ThreadExecutionContextRecord,
    workspace: crewon_app_server_protocol::WorkspaceRef,
    bindings: Vec<ProviderResourceBindingRecord>,
    update: ThreadExecutionContextBindingUpdate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CloudAgentThreadOperation {
    Fork,
    Compact,
    InjectItems,
    Steer,
}

impl CloudAgentThreadOperation {
    fn method(self) -> &'static str {
        match self {
            Self::Fork => "thread/fork",
            Self::Compact => "thread/compact/start",
            Self::InjectItems => "thread/injectItems",
            Self::Steer => "turn/steer",
        }
    }
}

impl PreparedThreadExecutionContextUpdate {
    pub(crate) fn bindings(&self) -> &[ProviderResourceBindingRecord] {
        &self.bindings
    }

    pub(crate) fn uses_execution_binding(&self) -> bool {
        self.update.execution_binding.is_some()
    }
}

impl ThreadExecutionContextRequestRuntime {
    pub(crate) fn new(
        identity: RequestIdentity,
        workspace_registry: Arc<WorkspaceRegistry>,
        workspace_catalog: WorkspaceRootCatalog,
        state: Arc<StateRuntime>,
    ) -> Self {
        Self {
            identity,
            workspace_registry,
            workspace_catalog,
            state,
        }
    }

    pub(crate) async fn prepare_create(
        &self,
        params: ThreadExecutionContextCreateParams,
    ) -> Result<PreparedThreadExecutionContextCreate, JSONRPCErrorError> {
        validate_thread_execution_context_identity(&self.identity).map_err(map_adapter_error)?;
        self.workspace_registry
            .prepare_workspace_key_with_state(
                &self.identity,
                &self.workspace_catalog,
                Some(self.state.as_ref()),
                &params.workspace_key,
            )
            .await?;
        Ok(PreparedThreadExecutionContextCreate {
            workspace_key: params.workspace_key,
        })
    }

    pub(crate) async fn prepare_create_for_registered_root(
        &self,
        root: &Path,
    ) -> Result<PreparedThreadExecutionContextCreate, JSONRPCErrorError> {
        let workspace_key = self.registered_workspace_key(root).await?;
        Ok(PreparedThreadExecutionContextCreate { workspace_key })
    }

    pub(crate) async fn authorize_registered_workspace_root(
        &self,
        root: &Path,
    ) -> Result<(), JSONRPCErrorError> {
        self.registered_workspace_key(root).await.map(|_| ())
    }

    async fn registered_workspace_key(&self, root: &Path) -> Result<String, JSONRPCErrorError> {
        validate_thread_execution_context_identity(&self.identity).map_err(map_adapter_error)?;
        self.workspace_registry
            .workspace_key_for_registered_root_with_state(
                &self.identity,
                &self.workspace_catalog,
                Some(self.state.as_ref()),
                root,
            )
            .await
    }

    pub(crate) async fn create(
        &self,
        prepared: PreparedThreadExecutionContextCreate,
        thread_id: &str,
        workspace_scope: ThreadExecutionContextWorkspaceScope,
        now: i64,
    ) -> Result<ThreadExecutionContext, JSONRPCErrorError> {
        let (scope, scope_id) = match workspace_scope {
            ThreadExecutionContextWorkspaceScope::Conversation => {
                (WorkspaceScope::Conversation, thread_id.to_string())
            }
            ThreadExecutionContextWorkspaceScope::Office { office_id } => {
                (WorkspaceScope::Office, office_id)
            }
        };
        let workspace = self
            .workspace_registry
            .bind_with_state(
                &self.identity,
                &self.workspace_catalog,
                Some(self.state.as_ref()),
                WorkspaceBindParams {
                    workspace_key: prepared.workspace_key,
                    scope,
                    scope_id,
                },
            )
            .await?
            .workspace;
        let record =
            thread_execution_context_record(&self.identity, &workspace, thread_id, &[], now)
                .map_err(map_adapter_error)?;
        match self
            .state
            .create_thread_execution_context_record(&record)
            .await
            .map_err(|_| internal_error("Thread execution context state is unavailable"))?
        {
            ThreadExecutionContextCreateOutcome::Created
            | ThreadExecutionContextCreateOutcome::ExistingSame => {
                project_thread_execution_context(&record, workspace).map_err(map_adapter_error)
            }
            ThreadExecutionContextCreateOutcome::Conflict => Err(invalid_request(
                "Thread execution context conflicts with current state",
            )),
            ThreadExecutionContextCreateOutcome::DependencyMissing => Err(invalid_request(
                "Thread execution context authority changed",
            )),
            ThreadExecutionContextCreateOutcome::CapacityExceeded => Err(invalid_request(
                "Thread execution context capacity was exceeded",
            )),
        }
    }

    pub(crate) async fn read_owned(
        &self,
        thread_id: &str,
    ) -> Result<Option<ThreadExecutionContext>, JSONRPCErrorError> {
        let Some(record) = self.record_owned(thread_id).await? else {
            return Ok(None);
        };
        let workspace = self
            .workspace_registry
            .bind_with_state(
                &self.identity,
                &self.workspace_catalog,
                Some(self.state.as_ref()),
                WorkspaceBindParams {
                    workspace_key: record.workspace_key.clone(),
                    scope: protocol_workspace_scope(record.workspace_scope)
                        .map_err(map_adapter_error)?,
                    scope_id: record.workspace_scope_id.clone(),
                },
            )
            .await?
            .workspace;
        project_thread_execution_context(&record, workspace)
            .map(Some)
            .map_err(map_adapter_error)
    }

    pub(crate) async fn authorize_existing(
        &self,
        thread_id: &str,
    ) -> Result<(), JSONRPCErrorError> {
        self.record_owned(thread_id).await.map(|_| ())
    }

    pub(crate) async fn authorize_office_thread(
        &self,
        thread_id: &str,
        office_id: &str,
        workspace_root: &Path,
    ) -> Result<(), JSONRPCErrorError> {
        let context = self
            .read_owned(thread_id)
            .await?
            .ok_or_else(|| invalid_request("Office execution context was not found"))?;
        if context.workspace.scope != WorkspaceScope::Office
            || context.workspace.scope_id != office_id
        {
            return Err(invalid_request(
                "Office execution context does not belong to this Office",
            ));
        }
        let expected_workspace_key = self
            .workspace_registry
            .workspace_key_for_registered_root_with_state(
                &self.identity,
                &self.workspace_catalog,
                Some(self.state.as_ref()),
                workspace_root,
            )
            .await?;
        if context.workspace.workspace_key != expected_workspace_key {
            return Err(invalid_request(
                "Office execution context does not belong to this workspace",
            ));
        }
        Ok(())
    }

    pub(crate) async fn authorize_or_create_office_thread(
        &self,
        thread_id: &str,
        office_id: &str,
        workspace_root: &Path,
        now: i64,
    ) -> Result<(), JSONRPCErrorError> {
        if self.read_owned(thread_id).await?.is_none() {
            let prepared = self
                .prepare_create_for_registered_root(workspace_root)
                .await?;
            self.create(
                prepared,
                thread_id,
                ThreadExecutionContextWorkspaceScope::Office {
                    office_id: office_id.to_string(),
                },
                now,
            )
            .await?;
        }
        self.authorize_office_thread(thread_id, office_id, workspace_root)
            .await
    }

    pub(crate) async fn ensure_operation_supported(
        &self,
        thread_id: &str,
        operation: CloudAgentThreadOperation,
    ) -> Result<(), JSONRPCErrorError> {
        if self
            .record_owned(thread_id)
            .await?
            .is_some_and(|record| record.execution_binding.is_some())
        {
            return Err(invalid_request(format!(
                "Cloud Agent Thread does not support {}",
                operation.method()
            )));
        }
        Ok(())
    }

    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "production composes prepare and commit around projection"
        )
    )]
    pub(crate) async fn update(
        &self,
        params: ThreadExecutionContextUpdateParams,
        now: i64,
    ) -> Result<ThreadExecutionContext, JSONRPCErrorError> {
        let prepared = self.prepare_update(params, now).await?;
        self.commit_update(prepared).await
    }

    pub(crate) async fn prepare_update(
        &self,
        params: ThreadExecutionContextUpdateParams,
        now: i64,
    ) -> Result<PreparedThreadExecutionContextUpdate, JSONRPCErrorError> {
        if params.expected_revision == 0
            || params.resource_binding_ids.len() > MAX_THREAD_EXECUTION_CONTEXT_BINDINGS
        {
            return Err(invalid_params("Thread execution context update is invalid"));
        }
        let current = self
            .record_owned(&params.thread_id)
            .await?
            .ok_or_else(|| invalid_request("Thread execution context was not found"))?;
        let workspace = self
            .workspace_registry
            .resolve_binding_ref_with_state(
                &self.identity,
                &self.workspace_catalog,
                Some(self.state.as_ref()),
                &params.workspace_binding_id,
            )
            .await?;
        if workspace.scope
            != protocol_workspace_scope(current.workspace_scope).map_err(map_adapter_error)?
            || workspace.scope_id != current.workspace_scope_id
        {
            return Err(invalid_request(
                "Thread execution context workspace is not authorized",
            ));
        }
        if current.revision != params.expected_revision {
            return Err(invalid_request(
                "Thread execution context revision conflicts with current state",
            ));
        }
        let bindings = self.resource_bindings(&params.resource_binding_ids).await?;
        let update = thread_execution_context_binding_update(
            &self.identity,
            &workspace,
            &current,
            ThreadExecutionContextBindingSelection {
                bindings: &bindings,
                execution_binding_id: params.execution_binding_id.as_deref(),
            },
            now,
        )
        .map_err(map_adapter_error)?;
        Ok(PreparedThreadExecutionContextUpdate {
            current,
            workspace,
            bindings,
            update,
        })
    }

    pub(crate) async fn commit_update(
        &self,
        prepared: PreparedThreadExecutionContextUpdate,
    ) -> Result<ThreadExecutionContext, JSONRPCErrorError> {
        let PreparedThreadExecutionContextUpdate {
            current,
            workspace,
            bindings: _,
            update,
        } = prepared;
        if update.resource_bindings == current.resource_bindings
            && update.execution_binding == current.execution_binding
        {
            return project_thread_execution_context(&current, workspace)
                .map_err(map_adapter_error);
        }
        match self
            .state
            .update_thread_execution_context_bindings(&update)
            .await
            .map_err(|_| internal_error("Thread execution context state is unavailable"))?
        {
            ThreadExecutionContextUpdateOutcome::Updated
            | ThreadExecutionContextUpdateOutcome::ExistingSame => {}
            ThreadExecutionContextUpdateOutcome::NotFound => {
                return Err(invalid_request("Thread execution context was not found"));
            }
            ThreadExecutionContextUpdateOutcome::Conflict => {
                return Err(invalid_request(
                    "Thread execution context conflicts with current state",
                ));
            }
            ThreadExecutionContextUpdateOutcome::DependencyMissing => {
                return Err(invalid_request(
                    "Thread execution context authority changed",
                ));
            }
        }
        let persisted = self
            .record_owned(&current.thread_id)
            .await?
            .ok_or_else(|| internal_error("Thread execution context state is unavailable"))?;
        project_thread_execution_context(&persisted, workspace).map_err(map_adapter_error)
    }

    pub(crate) async fn owned_binding_records(
        &self,
        thread_id: &str,
    ) -> Result<Vec<ProviderResourceBindingRecord>, JSONRPCErrorError> {
        let Some(record) = self.record_owned(thread_id).await? else {
            return Ok(Vec::new());
        };
        let mut bindings = Vec::with_capacity(record.resource_bindings.len());
        for reference in &record.resource_bindings {
            let binding = self
                .state
                .get_provider_resource_binding_record(&reference.binding_id)
                .await
                .map_err(|_| internal_error("Thread execution context state is unavailable"))?
                .ok_or_else(|| invalid_request("Provider resource binding was not found"))?;
            if !binding_matches_thread_execution_context(&binding, reference, &record) {
                return Err(invalid_request(
                    "Thread execution context resource authority changed",
                ));
            }
            bindings.push(binding);
        }
        Ok(bindings)
    }

    async fn record_owned(
        &self,
        thread_id: &str,
    ) -> Result<Option<ThreadExecutionContextRecord>, JSONRPCErrorError> {
        ThreadId::from_string(thread_id)
            .map_err(|_| invalid_params("Thread execution context threadId is invalid"))?;
        let record = self
            .state
            .get_thread_execution_context_record(thread_id)
            .await
            .map_err(|_| internal_error("Thread execution context state is unavailable"))?;
        if let Some(record) = record.as_ref() {
            authorize_thread_execution_context_record(&self.identity, record)
                .map_err(map_adapter_error)?;
        }
        Ok(record)
    }

    async fn resource_bindings(
        &self,
        binding_ids: &[String],
    ) -> Result<Vec<ProviderResourceBindingRecord>, JSONRPCErrorError> {
        let mut seen = HashSet::with_capacity(binding_ids.len());
        let mut bindings = Vec::with_capacity(binding_ids.len());
        for binding_id in binding_ids {
            if !seen.insert(binding_id) {
                return Err(invalid_params(
                    "Thread execution context contains duplicate resource bindings",
                ));
            }
            let binding = self
                .state
                .get_provider_resource_binding_record(binding_id)
                .await
                .map_err(|_| invalid_params("Invalid Provider resource binding id"))?
                .ok_or_else(|| invalid_request("Provider resource binding was not found"))?;
            bindings.push(binding);
        }
        Ok(bindings)
    }
}

pub(super) fn binding_matches_thread_execution_context(
    binding: &ProviderResourceBindingRecord,
    reference: &ThreadExecutionContextBindingRef,
    context: &ThreadExecutionContextRecord,
) -> bool {
    binding.status == ProviderResourceBindingStatus::Active
        && binding.revision == reference.revision
        && binding.local_actor_id == context.local_actor_id
        && binding.local_tenant_id == context.local_tenant_id
        && binding.local_space_id == context.local_space_id
        && binding.workspace_key == context.workspace_key
        && binding.workspace_scope == context.workspace_scope
        && binding.workspace_scope_id == context.workspace_scope_id
}

fn map_adapter_error(error: ThreadExecutionContextAdapterError) -> JSONRPCErrorError {
    match error {
        ThreadExecutionContextAdapterError::InvalidRequest => {
            invalid_params("Thread execution context request is invalid")
        }
        ThreadExecutionContextAdapterError::Unauthorized => {
            invalid_request("Thread execution context request is not authorized")
        }
    }
}
