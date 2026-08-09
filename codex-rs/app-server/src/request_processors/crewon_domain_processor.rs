use std::io;
use std::path::Path;
use std::path::PathBuf;

use chrono::SecondsFormat;
use chrono::Utc;
use crewon_app_server_protocol::AgentCreateParams;
use crewon_app_server_protocol::AgentCreateResponse;
use crewon_app_server_protocol::AgentDeleteParams;
use crewon_app_server_protocol::AgentDeleteResponse;
use crewon_app_server_protocol::AgentListParams;
use crewon_app_server_protocol::AgentListResponse;
use crewon_app_server_protocol::AgentReadParams;
use crewon_app_server_protocol::AgentReadResponse;
use crewon_app_server_protocol::AgentRecruitableListParams;
use crewon_app_server_protocol::AgentRecruitableListResponse;
use crewon_app_server_protocol::AgentSaveParams;
use crewon_app_server_protocol::AgentSaveResponse;
use crewon_app_server_protocol::AgentUpdateParams;
use crewon_app_server_protocol::AgentUpdateResponse;
use crewon_app_server_protocol::AutomationCreateParams;
use crewon_app_server_protocol::AutomationCreateResponse;
use crewon_app_server_protocol::AutomationDeleteParams;
use crewon_app_server_protocol::AutomationDeleteResponse;
use crewon_app_server_protocol::AutomationListParams;
use crewon_app_server_protocol::AutomationListResponse;
use crewon_app_server_protocol::AutomationReadParams;
use crewon_app_server_protocol::AutomationReadResponse;
use crewon_app_server_protocol::AutomationRunParams;
use crewon_app_server_protocol::AutomationRunRecord;
use crewon_app_server_protocol::AutomationRunResponse;
use crewon_app_server_protocol::AutomationRunStartParams;
use crewon_app_server_protocol::AutomationRunUpdateParams;
use crewon_app_server_protocol::AutomationRunUpdateResponse;
use crewon_app_server_protocol::AutomationRunsListParams;
use crewon_app_server_protocol::AutomationRunsListResponse;
use crewon_app_server_protocol::AutomationSaveParams;
use crewon_app_server_protocol::AutomationSaveResponse;
use crewon_app_server_protocol::AutomationUpdateParams;
use crewon_app_server_protocol::AutomationUpdateResponse;
use crewon_app_server_protocol::CrewonAutomationRunConfigRecord;
use crewon_app_server_protocol::CrewonDomainConfigRecord;
use crewon_app_server_protocol::CrewonToolConfigRecord;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::OfficeApprovalDecideParams;
use crewon_app_server_protocol::OfficeApprovalDecideResponse;
use crewon_app_server_protocol::OfficeApprovalDecision;
use crewon_app_server_protocol::OfficeArtifactUpsertParams;
use crewon_app_server_protocol::OfficeArtifactUpsertResponse;
use crewon_app_server_protocol::OfficeCreateParams;
use crewon_app_server_protocol::OfficeCreateResponse;
use crewon_app_server_protocol::OfficeDelegationCancelParams;
use crewon_app_server_protocol::OfficeDelegationDispatchNextParams;
use crewon_app_server_protocol::OfficeDelegationDispatchParams;
use crewon_app_server_protocol::OfficeDelegationRetryParams;
use crewon_app_server_protocol::OfficeDeleteParams;
use crewon_app_server_protocol::OfficeDeleteResponse;
use crewon_app_server_protocol::OfficeListParams;
use crewon_app_server_protocol::OfficeListResponse;
use crewon_app_server_protocol::OfficeManagerEnsureParams;
use crewon_app_server_protocol::OfficeManagerEnsureResponse;
use crewon_app_server_protocol::OfficeManagerEnsureStatus;
use crewon_app_server_protocol::OfficeMemberAddParams;
use crewon_app_server_protocol::OfficeMemberAddResponse;
use crewon_app_server_protocol::OfficeMemberContextPreviewParams;
use crewon_app_server_protocol::OfficeMemberContextPreviewResponse;
use crewon_app_server_protocol::OfficeMemoryDecideParams;
use crewon_app_server_protocol::OfficeMemoryDecideResponse;
use crewon_app_server_protocol::OfficeMemoryListParams;
use crewon_app_server_protocol::OfficeMemoryListResponse;
use crewon_app_server_protocol::OfficeMessageSendParams;
use crewon_app_server_protocol::OfficeMessageSendResponse;
use crewon_app_server_protocol::OfficeMessageSubmitParams;
use crewon_app_server_protocol::OfficeReadParams;
use crewon_app_server_protocol::OfficeReadResponse;
use crewon_app_server_protocol::OfficeRunCancelParams;
use crewon_app_server_protocol::OfficeRunParams;
use crewon_app_server_protocol::OfficeRunRetryParams;
use crewon_app_server_protocol::OfficeRunSyncParams;
use crewon_app_server_protocol::OfficeRunUpdatedNotification;
use crewon_app_server_protocol::OfficeSaveParams;
use crewon_app_server_protocol::OfficeSaveResponse;
use crewon_app_server_protocol::OfficeVerificationCancelParams;
use crewon_app_server_protocol::OfficeVerificationDispatchNextParams;
use crewon_app_server_protocol::OfficeVerificationRetryParams;
use crewon_app_server_protocol::ServerNotification;
use crewon_app_server_protocol::ToolConfigKind;
use crewon_app_server_protocol::ToolDeleteParams;
use crewon_app_server_protocol::ToolDeleteResponse;
use crewon_app_server_protocol::ToolListParams;
use crewon_app_server_protocol::ToolListResponse;
use crewon_app_server_protocol::ToolReadParams;
use crewon_app_server_protocol::ToolReadResponse;
use crewon_app_server_protocol::ToolSaveParams;
use crewon_app_server_protocol::ToolSaveResponse;
use crewon_app_server_protocol::ToolUpdateParams;
use crewon_app_server_protocol::ToolUpdateResponse;
use crewon_app_server_protocol::Turn;
use crewon_app_server_protocol::TurnStatus;
use crewon_app_server_protocol::WorkflowRunUpdatedNotification;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;
use sha2::Digest as _;
use sha2::Sha256;
use std::cmp::Reverse;
use std::collections::HashSet;
use tokio::fs;
use tokio::io::AsyncReadExt;
use uuid::Uuid;

use crate::error_code::internal_error;
use crate::error_code::invalid_params;

const MAX_CONFIG_RECORDS: usize = 24;
const MAX_LIST_LIMIT: usize = 100;
const MAX_OFFICE_ARTIFACT_FINGERPRINTS: usize = 64;
const MAX_OFFICE_ARTIFACT_FINGERPRINT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_OFFICE_ARTIFACT_CONTENT_ERROR_CHARS: usize = 240;
const OFFICE_ARTIFACT_FINGERPRINT_CHUNK_BYTES: usize = 64 * 1024;
const OFFICE_ARTIFACT_CONTENT_SOURCE_FILE: &str = "file";
const OFFICE_ARTIFACT_CONTENT_SOURCE_INLINE: &str = "inline";
const OFFICE_ARTIFACT_CONTENT_STATUS_FINGERPRINTED: &str = "fingerprinted";
const OFFICE_ARTIFACT_CONTENT_STATUS_MISSING: &str = "missing";
const OFFICE_ARTIFACT_CONTENT_STATUS_NOT_FILE: &str = "notFile";
const OFFICE_ARTIFACT_CONTENT_STATUS_OUTSIDE_WORKSPACE: &str = "outsideWorkspace";
const OFFICE_ARTIFACT_CONTENT_STATUS_TOO_LARGE: &str = "tooLarge";
const OFFICE_ARTIFACT_CONTENT_STATUS_UNREADABLE: &str = "unreadable";
const AUTOMATION_RUNS_DIRECTORY: &str = "automation-runs";

#[path = "crewon_domain_office_agent_profile.rs"]
mod office_agent_profile;
#[path = "crewon_domain_office_authority_lock.rs"]
mod office_authority_lock;
#[allow(
    dead_code,
    reason = "preserves the server-owned field boundary used by the full Office storage path"
)]
mod office_automation_binding {
    use crewon_app_server_protocol::JSONRPCErrorError;
    use serde_json::Value as JsonValue;

    use crate::error_code::invalid_params;

    pub(super) fn preserve_canonical_bindings(
        latest: Option<&JsonValue>,
        proposed: &mut JsonValue,
    ) -> Result<bool, JSONRPCErrorError> {
        let latest_bindings = latest
            .and_then(|config| config.get("workspace"))
            .and_then(|workspace| workspace.get("automationBindings"))
            .cloned();
        let proposed_bindings = proposed
            .get("workspace")
            .and_then(|workspace| workspace.get("automationBindings"))
            .cloned();
        if proposed_bindings.is_some() && proposed_bindings != latest_bindings {
            return Err(invalid_params(
                "workspace.automationBindings is server-owned",
            ));
        }
        let Some(latest_bindings) = latest_bindings else {
            return Ok(false);
        };
        if proposed_bindings.is_some() {
            return Ok(false);
        }
        let workspace = proposed
            .get_mut("workspace")
            .and_then(JsonValue::as_object_mut)
            .ok_or_else(|| invalid_params("office config is missing workspace"))?;
        workspace.insert("automationBindings".to_string(), latest_bindings);
        Ok(true)
    }
}
#[path = "crewon_domain_office_legacy_record_mutation.rs"]
mod office_legacy_record_mutation;
#[path = "crewon_domain_office_manager.rs"]
mod office_manager;
#[path = "crewon_domain_office_message.rs"]
#[allow(
    dead_code,
    reason = "message receipt recovery helpers land incrementally around the active submit path"
)]
mod office_message;
#[path = "crewon_domain_office_message_intent.rs"]
mod office_message_intent;
#[path = "crewon_domain_office_message_receipt.rs"]
#[allow(
    dead_code,
    reason = "the receipt mirror is non-authoritative and includes recovery helpers for the next stage"
)]
mod office_message_receipt;
#[cfg(test)]
#[path = "crewon_domain_office_migration_importer.rs"]
mod office_migration_importer;
#[cfg(test)]
#[path = "crewon_domain_office_migration_snapshot.rs"]
mod office_migration_snapshot;
#[path = "crewon_domain_office_migration_targets.rs"]
mod office_migration_targets;
#[path = "crewon_domain_office_record_identity.rs"]
mod office_record_identity;
#[path = "crewon_domain_office_record_lock.rs"]
mod office_record_lock;
#[path = "crewon_domain_office_run.rs"]
mod office_run;
#[path = "crewon_domain_office_runtime_authority.rs"]
#[allow(
    dead_code,
    reason = "member runtime authority is compiled with storage before member creation is switched over"
)]
mod office_runtime_authority;
#[path = "crewon_domain_office_runtime_owner_reconciliation.rs"]
mod office_runtime_owner_reconciliation;
#[path = "crewon_domain_office_runtime_owner_registry.rs"]
#[allow(
    dead_code,
    reason = "the owner registry supports message storage now and member runtime lifecycle next"
)]
mod office_runtime_owner_registry;
#[path = "crewon_domain_office_runtime_owner_registry_config.rs"]
mod office_runtime_owner_registry_config;
#[path = "crewon_domain_office_runtime_owner_registry_store.rs"]
mod office_runtime_owner_registry_store;
#[path = "crewon_domain_office_storage.rs"]
#[allow(
    dead_code,
    unused_imports,
    reason = "the canonical storage module contains bounded recovery APIs not all used by the minimum submit path"
)]
mod office_storage;
#[path = "crewon_domain_office_workspace_identity.rs"]
#[allow(
    dead_code,
    reason = "workspace identity supports canonical receipt storage and staged runtime migration"
)]
mod office_workspace_identity;

#[allow(
    dead_code,
    reason = "used by canonical storage branches staged with member runtime authority"
)]
fn office_runtime_authority_error(
    error: office_runtime_authority::RepairedRuntimeAuthorityError,
) -> JSONRPCErrorError {
    match error {
        office_runtime_authority::RepairedRuntimeAuthorityError::ConflictingBinding {
            agent_id,
        } => invalid_params(format!(
            "Office runtime binding conflicts for agent {agent_id}"
        )),
        office_runtime_authority::RepairedRuntimeAuthorityError::ForgedAuthority { agent_id } => {
            invalid_params(format!(
                "Office runtime authority is invalid for agent {agent_id}"
            ))
        }
        office_runtime_authority::RepairedRuntimeAuthorityError::TooManyBindings { limit } => {
            invalid_params(format!(
                "Office runtime bindings exceed the limit of {limit}"
            ))
        }
    }
}

pub(crate) struct OfficeAutoDispatchIntentDispatched<'a> {
    pub(crate) run_id: &'a str,
    pub(crate) dispatch_kind: &'a str,
    pub(crate) delegation_id: Option<&'a str>,
    pub(crate) verification_check_id: Option<&'a str>,
    pub(crate) file_path: &'a str,
    pub(crate) dispatched_thread_id: &'a str,
    pub(crate) dispatched_turn_id: &'a str,
}

pub(crate) use office_message::OfficeMessageDispatchMode;
pub(crate) use office_message::OfficeMessageSubmitAction;
pub(crate) use office_message::PreparedOfficeMessageSubmit;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OfficeAutoDispatchIntentRef {
    pub(crate) intent_id: String,
    pub(crate) source_thread_id: String,
    pub(crate) source_turn_id: String,
}

pub(crate) struct OfficeVerificationDispatchStarted<'a> {
    pub(crate) run_id: &'a str,
    pub(crate) verification_check_id: &'a str,
    pub(crate) automation_run_file_path: &'a str,
    pub(crate) automation_run_id: &'a str,
    pub(crate) automation_thread_id: &'a str,
    pub(crate) automation_turn_id: &'a str,
    pub(crate) runtime_repair_source_thread_id: Option<&'a str>,
    pub(crate) runtime_repaired_at: Option<&'a str>,
}

#[derive(Clone, Debug)]
pub(crate) struct OfficeRunSyncUpdate {
    pub(crate) file_path: String,
    pub(crate) config: JsonValue,
}

#[derive(Clone, Copy)]
enum DomainKind {
    Agent,
    Workflow,
    Office,
    Automation,
    Tool,
}

impl DomainKind {
    fn record_kind(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Workflow => "workflow",
            Self::Office => "office",
            Self::Automation => "automation",
            Self::Tool => "tool",
        }
    }

    fn directory_name(self) -> &'static str {
        match self {
            Self::Agent => "agents",
            Self::Workflow => "workflows",
            Self::Office => "offices",
            Self::Automation => "automations",
            Self::Tool => "tools",
        }
    }

    fn title_field(self) -> &'static str {
        match self {
            Self::Agent | Self::Workflow => "name",
            Self::Office | Self::Automation | Self::Tool => "title",
        }
    }

    fn title(self, config: &JsonValue) -> Option<&str> {
        config.get(self.title_field()).and_then(JsonValue::as_str)
    }

    fn thread_id(self, config: &JsonValue) -> Option<&str> {
        match self {
            Self::Agent | Self::Automation => config.get("threadId").and_then(JsonValue::as_str),
            Self::Workflow => config.get("workflowId").and_then(JsonValue::as_str),
            Self::Office => config
                .get("workspace")
                .and_then(|workspace| workspace.get("threadId"))
                .and_then(JsonValue::as_str),
            Self::Tool => tool_identity(config),
        }
    }

    fn config_matches(self, config: &JsonValue) -> bool {
        let Some(config) = config.as_object() else {
            return false;
        };
        match self {
            Self::Agent => config.contains_key("name"),
            Self::Workflow => {
                config.contains_key("workflowId")
                    && config.contains_key("name")
                    && config.get("nodes").is_some_and(JsonValue::is_array)
            }
            Self::Office => config
                .get("workspace")
                .is_some_and(serde_json::Value::is_object),
            Self::Automation => config.contains_key("title"),
            Self::Tool => {
                matches!(
                    config.get("kind").and_then(JsonValue::as_str),
                    Some("mcp" | "skill")
                ) && config.contains_key("title")
            }
        }
    }
}

#[path = "crewon_domain_workflow.rs"]
mod workflow;
pub(crate) use workflow::PreparedWorkflowNodeDispatch;
pub(crate) use workflow::WorkflowRunUpdate;

#[derive(Clone)]
pub(crate) struct CrewonDomainRequestProcessor {
    office_records: office_legacy_record_mutation::OfficeLegacyRecordMutator,
}

#[must_use = "a permitted Office dispatch must be committed as started or failed"]
pub(crate) struct PermittedOfficeDispatch<T> {
    prepared: T,
    permit: office_legacy_record_mutation::OfficeDispatchPermit,
}

pub(crate) type PermittedOfficeDelegationDispatch =
    PermittedOfficeDispatch<office_run::PreparedOfficeDelegationDispatch>;

impl<T> PermittedOfficeDispatch<T> {
    pub(crate) fn prepared(&self) -> &T {
        &self.prepared
    }

    pub(crate) fn record_id(&self) -> &str {
        self.permit.record_id()
    }

    fn into_parts(self) -> (T, office_legacy_record_mutation::OfficeDispatchPermit) {
        (self.prepared, self.permit)
    }

    #[cfg(test)]
    fn into_prepared_for_test(self) -> T {
        self.prepared
    }
}

impl PermittedOfficeDispatch<office_run::PreparedOfficeVerificationDispatch> {
    pub(crate) fn prepared_mut(&mut self) -> &mut office_run::PreparedOfficeVerificationDispatch {
        &mut self.prepared
    }
}

impl PermittedOfficeDispatch<office_run::PreparedOfficeDelegationDispatch> {
    pub(crate) fn prepared_mut(&mut self) -> &mut office_run::PreparedOfficeDelegationDispatch {
        &mut self.prepared
    }
}

impl CrewonDomainRequestProcessor {
    #[cfg(test)]
    pub(crate) fn new() -> Self {
        Self {
            office_records:
                office_legacy_record_mutation::OfficeLegacyRecordMutator::legacy_unfenced(),
        }
    }

    pub(crate) fn migration_unavailable() -> Self {
        Self {
            office_records:
                office_legacy_record_mutation::OfficeLegacyRecordMutator::migration_unavailable(),
        }
    }

    pub(crate) fn with_migration_state(
        migration_state: crewon_rollout::state_db::StateDbHandle,
    ) -> Self {
        Self {
            office_records:
                office_legacy_record_mutation::OfficeLegacyRecordMutator::with_migration_state(
                    migration_state,
                ),
        }
    }

    async fn lock_auto_dispatch_mutation(
        &self,
        cwd: &str,
        source_thread_id: &str,
        source_turn_id: &str,
    ) -> Result<office_legacy_record_mutation::OfficeLegacyMutationGuard, JSONRPCErrorError> {
        let authority = self.office_records.lock_authority(cwd).await?;
        let configs = office_migration_targets::configs_referencing_turn(
            cwd,
            source_thread_id,
            source_turn_id,
        )
        .await?;
        for config in configs {
            authority
                .ensure_config_writable(&self.office_records, cwd, &config)
                .await?;
        }
        Ok(authority)
    }

    async fn lock_auto_dispatch_drain(
        &self,
        cwd: &str,
        source_thread_id: &str,
        source_turn_id: &str,
    ) -> Result<office_legacy_record_mutation::OfficeLegacyMutationGuard, JSONRPCErrorError> {
        let authority = self.office_records.lock_authority(cwd).await?;
        let configs = office_migration_targets::configs_referencing_turn(
            cwd,
            source_thread_id,
            source_turn_id,
        )
        .await?;
        for config in configs {
            authority
                .ensure_config_drainable(&self.office_records, cwd, &config)
                .await?;
        }
        Ok(authority)
    }

    async fn permit_delegation_dispatch(
        &self,
        authority: office_legacy_record_mutation::OfficeLegacyMutationGuard,
        prepared: office_run::PreparedOfficeDelegationDispatch,
    ) -> Result<
        PermittedOfficeDispatch<office_run::PreparedOfficeDelegationDispatch>,
        JSONRPCErrorError,
    > {
        let permit = authority
            .into_dispatch_permit(
                &self.office_records,
                &prepared.cwd,
                &prepared.config,
                office_legacy_record_mutation::OfficeDispatchAction::Delegation {
                    run_id: prepared.run_id.clone(),
                    delegation_id: prepared.delegation_id.clone(),
                },
            )
            .await?;
        Ok(PermittedOfficeDispatch { prepared, permit })
    }

    async fn permit_run_dispatch(
        &self,
        authority: office_legacy_record_mutation::OfficeLegacyMutationGuard,
        prepared: office_run::PreparedOfficeRun,
    ) -> Result<PermittedOfficeDispatch<office_run::PreparedOfficeRun>, JSONRPCErrorError> {
        let permit = authority
            .into_dispatch_permit(
                &self.office_records,
                &prepared.cwd,
                &prepared.config,
                office_legacy_record_mutation::OfficeDispatchAction::Run {
                    run_id: prepared.run_id.clone(),
                },
            )
            .await?;
        Ok(PermittedOfficeDispatch { prepared, permit })
    }

    async fn permit_verification_dispatch(
        &self,
        authority: office_legacy_record_mutation::OfficeLegacyMutationGuard,
        prepared: office_run::PreparedOfficeVerificationDispatch,
    ) -> Result<
        PermittedOfficeDispatch<office_run::PreparedOfficeVerificationDispatch>,
        JSONRPCErrorError,
    > {
        let permit = authority
            .into_dispatch_permit(
                &self.office_records,
                &prepared.cwd,
                &prepared.config,
                office_legacy_record_mutation::OfficeDispatchAction::Verification {
                    run_id: prepared.run_id.clone(),
                    verification_check_id: prepared.verification_check_id.clone(),
                },
            )
            .await?;
        Ok(PermittedOfficeDispatch { prepared, permit })
    }

    pub(crate) async fn sync_office_run_updates_for_thread_turn(
        &self,
        cwd: &str,
        thread_id: &str,
        turn: &Turn,
    ) -> Result<Vec<OfficeRunSyncUpdate>, JSONRPCErrorError> {
        let _authority = self
            .lock_auto_dispatch_drain(cwd, thread_id, &turn.id)
            .await?;
        office_run::drain_thread_turn_updates(cwd, thread_id, turn).await
    }

    pub(crate) async fn agent_list(
        &self,
        params: AgentListParams,
    ) -> Result<AgentListResponse, JSONRPCErrorError> {
        list_records(DomainKind::Agent, &params.cwd, params.cursor, params.limit)
            .await
            .map(|(data, next_cursor)| AgentListResponse { data, next_cursor })
    }

    pub(crate) async fn agent_save(
        &self,
        params: AgentSaveParams,
    ) -> Result<AgentSaveResponse, JSONRPCErrorError> {
        let (config, agent_id) = ensure_agent_id(params.config)?;
        save_record(DomainKind::Agent, &params.cwd, config)
            .await
            .map(|file_path| AgentSaveResponse {
                file_path,
                agent_id,
            })
    }

    pub(crate) async fn agent_create(
        &self,
        params: AgentCreateParams,
    ) -> Result<AgentCreateResponse, JSONRPCErrorError> {
        let (config, agent_id) = ensure_agent_id(params.config)?;
        create_record(DomainKind::Agent, &params.cwd, config)
            .await
            .map(|file_path| AgentCreateResponse {
                file_path,
                agent_id,
            })
    }

    pub(crate) async fn agent_update(
        &self,
        params: AgentUpdateParams,
    ) -> Result<AgentUpdateResponse, JSONRPCErrorError> {
        let (config, agent_id) = ensure_agent_id(params.config)?;
        update_record(DomainKind::Agent, &params.cwd, &params.file_path, config)
            .await
            .map(|file_path| AgentUpdateResponse {
                file_path,
                agent_id,
            })
    }

    pub(crate) async fn agent_read(
        &self,
        params: AgentReadParams,
    ) -> Result<AgentReadResponse, JSONRPCErrorError> {
        read_agent_record(
            &params.cwd,
            params.agent_id.as_deref(),
            params.thread_id.as_deref(),
            params.name.as_deref(),
        )
        .await
        .map(|record| AgentReadResponse { record })
    }

    pub(crate) async fn agent_recruitable_list(
        &self,
        params: AgentRecruitableListParams,
    ) -> Result<AgentRecruitableListResponse, JSONRPCErrorError> {
        list_recruitable_agents(
            &params.cwd,
            params.cursor,
            params.existing_agent_ids.unwrap_or_default(),
            params.existing_names.unwrap_or_default(),
            params.limit,
        )
        .await
        .map(|(data, next_cursor)| AgentRecruitableListResponse { data, next_cursor })
    }

    pub(crate) async fn agent_delete(
        &self,
        params: AgentDeleteParams,
    ) -> Result<AgentDeleteResponse, JSONRPCErrorError> {
        delete_record(DomainKind::Agent, &params.cwd, &params.file_path)
            .await
            .map(|deleted| AgentDeleteResponse { deleted })
    }

    pub(crate) async fn office_list(
        &self,
        params: OfficeListParams,
    ) -> Result<OfficeListResponse, JSONRPCErrorError> {
        list_records(DomainKind::Office, &params.cwd, params.cursor, params.limit)
            .await
            .map(|(data, next_cursor)| OfficeListResponse { data, next_cursor })
    }

    pub(crate) async fn office_save(
        &self,
        params: OfficeSaveParams,
    ) -> Result<OfficeSaveResponse, JSONRPCErrorError> {
        self.office_records
            .save(&params.cwd, params.config)
            .await
            .map(|file_path| OfficeSaveResponse { file_path })
    }

    pub(crate) async fn office_create(
        &self,
        params: OfficeCreateParams,
    ) -> Result<OfficeCreateResponse, JSONRPCErrorError> {
        let cwd = params.cwd.clone();
        let mut config = create_office_config(params)?;
        office_record_identity::assign_new(&mut config)?;
        self.office_records
            .create(&cwd, config.clone())
            .await
            .map(|file_path| OfficeCreateResponse { file_path, config })
    }

    pub(crate) async fn office_read(
        &self,
        params: OfficeReadParams,
    ) -> Result<OfficeReadResponse, JSONRPCErrorError> {
        read_office_record(
            &params.cwd,
            params.thread_id.as_deref(),
            params.title.as_deref(),
        )
        .await
        .map(|record| OfficeReadResponse { record })
    }

    pub(crate) async fn office_manager_ensure_prepare(
        &self,
        params: OfficeManagerEnsureParams,
    ) -> Result<office_manager::PreparedOfficeManagerEnsure, JSONRPCErrorError> {
        office_manager::prepare(&self.office_records, params).await
    }

    pub(crate) async fn office_manager_ensure_reused(
        &self,
        prepared: office_manager::PreparedOfficeManagerEnsure,
        status: OfficeManagerEnsureStatus,
    ) -> Result<OfficeManagerEnsureResponse, JSONRPCErrorError> {
        office_manager::reused(&self.office_records, prepared, status).await
    }

    pub(crate) async fn office_manager_ensure_commit(
        &self,
        prepared: office_manager::PreparedOfficeManagerEnsure,
        replacement_thread_id: &str,
    ) -> Result<OfficeManagerEnsureResponse, JSONRPCErrorError> {
        office_manager::commit(&self.office_records, prepared, replacement_thread_id).await
    }

    pub(crate) async fn office_message_send(
        &self,
        params: OfficeMessageSendParams,
    ) -> Result<OfficeMessageSendResponse, JSONRPCErrorError> {
        let config = apply_office_message_update(
            params.config,
            params.message,
            params.text.as_deref(),
            params.locale.as_deref(),
            params.workspace,
        )?;
        self.office_records
            .save(&params.cwd, config.clone())
            .await
            .map(|file_path| OfficeMessageSendResponse { file_path, config })
    }

    pub(crate) async fn office_message_submit_resolve(
        &self,
        params: OfficeMessageSubmitParams,
    ) -> Result<office_message::ResolvedOfficeMessageSubmit, JSONRPCErrorError> {
        let (authority, latest) = self
            .office_records
            .lock_resolved_config_mutation(&params.cwd, &params.config)
            .await?;
        let office_record_id = office_storage::office_record_id(&latest)
            .ok_or_else(|| invalid_params("Office workspace has no canonical recordId"))?
            .to_string();
        let manager_thread_id = office_thread_id(&latest)
            .map(str::trim)
            .filter(|thread_id| !thread_id.is_empty())
            .ok_or_else(|| invalid_params("Office workspace has no canonical manager threadId"))?
            .to_string();
        drop(authority);
        Ok(office_message::ResolvedOfficeMessageSubmit {
            params: OfficeMessageSubmitParams {
                config: latest,
                ..params
            },
            expected_office_record_id: office_record_id,
            manager_thread_id,
        })
    }

    pub(crate) async fn office_message_submit_prepare_resolved(
        &self,
        resolved: office_message::ResolvedOfficeMessageSubmit,
    ) -> Result<office_message::PreparedOfficeMessageSubmit, JSONRPCErrorError> {
        office_message::prepare(resolved).await
    }

    pub(crate) async fn office_message_latest_exact(
        &self,
        cwd: &str,
        config: &JsonValue,
    ) -> Result<OfficeRunSyncUpdate, JSONRPCErrorError> {
        let (authority, latest) = self
            .office_records
            .lock_resolved_config_mutation(cwd, config)
            .await?;
        drop(authority);
        let file_path = self.office_records.save(cwd, latest.clone()).await?;
        Ok(OfficeRunSyncUpdate {
            file_path,
            config: latest,
        })
    }

    pub(crate) async fn office_message_mark_run_started(
        &self,
        prepared: &office_message::PreparedOfficeMessageSubmit,
        run_id: &str,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<OfficeRunSyncUpdate, JSONRPCErrorError> {
        office_message::mark_run_started(prepared, run_id, thread_id, turn_id).await
    }

    pub(crate) fn office_message_run_id_for_client(
        &self,
        config: &JsonValue,
        client_user_message_id: &str,
    ) -> Result<String, JSONRPCErrorError> {
        office_message::run_id_for_client_message(config, client_user_message_id)
    }

    pub(crate) fn office_message_run_has_turn_for_client(
        &self,
        config: &JsonValue,
        client_user_message_id: &str,
    ) -> bool {
        office_message::run_has_turn_for_client_message(config, client_user_message_id)
    }

    pub(crate) async fn office_message_mark_queued(
        &self,
        prepared: &office_message::PreparedOfficeMessageSubmit,
        after_run_id: &str,
    ) -> Result<(OfficeRunSyncUpdate, u32), JSONRPCErrorError> {
        office_message::mark_queued(prepared, after_run_id).await
    }

    pub(crate) async fn office_message_mark_failed(
        &self,
        prepared: &office_message::PreparedOfficeMessageSubmit,
        message: &str,
    ) -> Result<OfficeRunSyncUpdate, JSONRPCErrorError> {
        office_message::mark_failed(prepared, message).await
    }

    pub(crate) async fn office_submitted_message_run_prepare(
        &self,
        mut params: OfficeRunParams,
        dispatch_receipt_id: String,
    ) -> Result<PermittedOfficeDispatch<office_run::PreparedOfficeRun>, JSONRPCErrorError> {
        let (authority, config) = self
            .office_records
            .lock_resolved_config_mutation(&params.cwd, &params.config)
            .await?;
        params.config = config;
        let prepared = office_run::prepare_submitted_message(params, dispatch_receipt_id).await?;
        self.permit_run_dispatch(authority, prepared).await
    }

    #[cfg(test)]
    pub(crate) async fn office_run_prepare(
        &self,
        params: OfficeRunParams,
    ) -> Result<office_run::PreparedOfficeRun, JSONRPCErrorError> {
        Ok(self
            .office_run_prepare_permitted(params)
            .await?
            .into_prepared_for_test())
    }

    pub(crate) async fn office_run_prepare_permitted(
        &self,
        mut params: OfficeRunParams,
    ) -> Result<PermittedOfficeDispatch<office_run::PreparedOfficeRun>, JSONRPCErrorError> {
        let (authority, config) = self
            .office_records
            .lock_resolved_config_mutation(&params.cwd, &params.config)
            .await?;
        params.config = config;
        let prepared = office_run::prepare(params).await?;
        self.permit_run_dispatch(authority, prepared).await
    }

    #[cfg(test)]
    pub(crate) async fn office_run_retry_prepare(
        &self,
        params: OfficeRunRetryParams,
    ) -> Result<office_run::PreparedOfficeRun, JSONRPCErrorError> {
        Ok(self
            .office_run_retry_prepare_permitted(params)
            .await?
            .into_prepared_for_test())
    }

    pub(crate) async fn office_run_retry_prepare_permitted(
        &self,
        mut params: OfficeRunRetryParams,
    ) -> Result<PermittedOfficeDispatch<office_run::PreparedOfficeRun>, JSONRPCErrorError> {
        let (authority, config) = self
            .office_records
            .lock_resolved_config_mutation(&params.cwd, &params.config)
            .await?;
        params.config = config;
        let prepared = office_run::prepare_retry(params).await?;
        self.permit_run_dispatch(authority, prepared).await
    }

    pub(crate) async fn office_run_cancel_prepare(
        &self,
        mut params: OfficeRunCancelParams,
    ) -> Result<office_run::PreparedOfficeRunCancel, JSONRPCErrorError> {
        let (_authority, config) = self
            .office_records
            .lock_resolved_config_drain(&params.cwd, &params.config)
            .await?;
        params.config = config;
        office_run::prepare_cancel(params).await
    }

    pub(crate) async fn office_run_mark_cancel_requested(
        &self,
        cwd: &str,
        config: JsonValue,
        run_id: &str,
        turn_id: &str,
    ) -> Result<(String, JsonValue), JSONRPCErrorError> {
        let (_authority, config) = self
            .office_records
            .lock_resolved_config_drain(cwd, &config)
            .await?;
        office_run::mark_cancel_requested(cwd, config, run_id, turn_id).await
    }

    pub(crate) async fn office_delegation_cancel_prepare(
        &self,
        mut params: OfficeDelegationCancelParams,
    ) -> Result<office_run::PreparedOfficeChildCancel, JSONRPCErrorError> {
        let (_authority, config) = self
            .office_records
            .lock_resolved_config_drain(&params.cwd, &params.config)
            .await?;
        params.config = config;
        office_run::prepare_delegation_cancel(params).await
    }

    pub(crate) async fn office_delegation_mark_cancel_requested(
        &self,
        cwd: &str,
        config: JsonValue,
        run_id: &str,
        delegation_id: &str,
        turn_id: &str,
    ) -> Result<(String, JsonValue), JSONRPCErrorError> {
        let (_authority, config) = self
            .office_records
            .lock_resolved_config_drain(cwd, &config)
            .await?;
        office_run::mark_delegation_cancel_requested(cwd, config, run_id, delegation_id, turn_id)
            .await
    }

    pub(crate) async fn office_verification_cancel_prepare(
        &self,
        mut params: OfficeVerificationCancelParams,
    ) -> Result<office_run::PreparedOfficeChildCancel, JSONRPCErrorError> {
        let (_authority, config) = self
            .office_records
            .lock_resolved_config_drain(&params.cwd, &params.config)
            .await?;
        params.config = config;
        office_run::prepare_verification_cancel(params).await
    }

    pub(crate) async fn office_verification_mark_cancel_requested(
        &self,
        cwd: &str,
        config: JsonValue,
        run_id: &str,
        verification_check_id: &str,
        turn_id: &str,
    ) -> Result<(String, JsonValue), JSONRPCErrorError> {
        let (_authority, config) = self
            .office_records
            .lock_resolved_config_drain(cwd, &config)
            .await?;
        office_run::mark_verification_cancel_requested(
            cwd,
            config,
            run_id,
            verification_check_id,
            turn_id,
        )
        .await
    }

    #[cfg(test)]
    pub(crate) async fn office_run_mark_started(
        &self,
        cwd: &str,
        config: JsonValue,
        run_id: &str,
        turn_id: &str,
    ) -> Result<(String, JsonValue), JSONRPCErrorError> {
        let (_authority, config) = self
            .office_records
            .lock_resolved_config_mutation(cwd, &config)
            .await?;
        office_run::mark_started(cwd, config, run_id, turn_id).await
    }

    pub(crate) async fn office_run_mark_started_permitted(
        &self,
        permitted: PermittedOfficeDispatch<office_run::PreparedOfficeRun>,
        turn_id: &str,
    ) -> Result<(String, JsonValue), JSONRPCErrorError> {
        let (prepared, permit) = permitted.into_parts();
        permit
            .ensure_config_identity(&prepared.cwd, &prepared.config)
            .await?;
        office_run::mark_started(&prepared.cwd, prepared.config, &prepared.run_id, turn_id).await
    }

    pub(crate) async fn office_run_recover_started(
        &self,
        cwd: &str,
        config: JsonValue,
        run_id: &str,
        turn_id: &str,
    ) -> Result<(String, JsonValue), JSONRPCErrorError> {
        let (_authority, config) = self
            .office_records
            .lock_resolved_config_drain(cwd, &config)
            .await?;
        office_run::mark_started(cwd, config, run_id, turn_id).await
    }

    pub(crate) async fn office_run_recovery_mark_failed(
        &self,
        cwd: &str,
        config: JsonValue,
        run_id: &str,
        message: &str,
    ) -> Result<(), JSONRPCErrorError> {
        let (_authority, config) = self
            .office_records
            .lock_resolved_config_drain(cwd, &config)
            .await?;
        office_run::mark_failed(cwd, config, run_id, message).await
    }

    #[cfg(test)]
    pub(crate) async fn office_run_mark_failed(
        &self,
        cwd: &str,
        config: JsonValue,
        run_id: &str,
        message: &str,
    ) -> Result<(), JSONRPCErrorError> {
        let (_authority, config) = self
            .office_records
            .lock_resolved_config_drain(cwd, &config)
            .await?;
        office_run::mark_failed(cwd, config, run_id, message).await
    }

    pub(crate) async fn office_run_mark_failed_permitted(
        &self,
        permitted: PermittedOfficeDispatch<office_run::PreparedOfficeRun>,
        message: &str,
    ) -> Result<(), JSONRPCErrorError> {
        let (prepared, permit) = permitted.into_parts();
        permit
            .ensure_config_identity(&prepared.cwd, &prepared.config)
            .await?;
        office_run::mark_failed(&prepared.cwd, prepared.config, &prepared.run_id, message).await
    }

    pub(crate) async fn office_run_sync(
        &self,
        mut params: OfficeRunSyncParams,
    ) -> Result<office_run::SyncedOfficeRun, JSONRPCErrorError> {
        let (_authority, config) = self
            .office_records
            .lock_resolved_config_mutation(&params.cwd, &params.config)
            .await?;
        params.config = config;
        office_run::sync(params).await
    }

    pub(crate) async fn office_memory_list(
        &self,
        params: OfficeMemoryListParams,
    ) -> Result<OfficeMemoryListResponse, JSONRPCErrorError> {
        office_run::list_memories(params).await
    }

    pub(crate) async fn office_memory_decide(
        &self,
        mut params: OfficeMemoryDecideParams,
    ) -> Result<OfficeMemoryDecideResponse, JSONRPCErrorError> {
        let (_authority, config) = self
            .office_records
            .lock_resolved_config_mutation(&params.cwd, &params.config)
            .await?;
        params.config = config;
        office_run::decide_memory(params).await
    }

    pub(crate) async fn office_member_context_preview(
        &self,
        params: OfficeMemberContextPreviewParams,
    ) -> Result<OfficeMemberContextPreviewResponse, JSONRPCErrorError> {
        office_run::preview_member_context(params).await
    }

    #[cfg(test)]
    pub(crate) async fn office_delegation_dispatch_prepare(
        &self,
        mut params: OfficeDelegationDispatchParams,
    ) -> Result<office_run::PreparedOfficeDelegationDispatch, JSONRPCErrorError> {
        let (_authority, config) = self
            .office_records
            .lock_resolved_config_mutation(&params.cwd, &params.config)
            .await?;
        params.config = config;
        office_run::prepare_delegation_dispatch(params).await
    }

    pub(crate) async fn office_delegation_dispatch_prepare_permitted(
        &self,
        mut params: OfficeDelegationDispatchParams,
    ) -> Result<
        PermittedOfficeDispatch<office_run::PreparedOfficeDelegationDispatch>,
        JSONRPCErrorError,
    > {
        let (authority, config) = self
            .office_records
            .lock_resolved_config_mutation(&params.cwd, &params.config)
            .await?;
        params.config = config;
        let prepared = office_run::prepare_delegation_dispatch(params).await?;
        self.permit_delegation_dispatch(authority, prepared).await
    }

    #[cfg(test)]
    pub(crate) async fn office_delegation_dispatch_next_prepare(
        &self,
        mut params: OfficeDelegationDispatchNextParams,
    ) -> Result<office_run::PreparedOfficeDelegationDispatch, JSONRPCErrorError> {
        let (_authority, config) = self
            .office_records
            .lock_resolved_config_mutation(&params.cwd, &params.config)
            .await?;
        params.config = config;
        office_run::prepare_next_delegation_dispatch(params).await
    }

    pub(crate) async fn office_delegation_dispatch_next_prepare_permitted(
        &self,
        mut params: OfficeDelegationDispatchNextParams,
    ) -> Result<
        PermittedOfficeDispatch<office_run::PreparedOfficeDelegationDispatch>,
        JSONRPCErrorError,
    > {
        let (authority, config) = self
            .office_records
            .lock_resolved_config_mutation(&params.cwd, &params.config)
            .await?;
        params.config = config;
        let prepared = office_run::prepare_next_delegation_dispatch(params).await?;
        self.permit_delegation_dispatch(authority, prepared).await
    }

    #[cfg(test)]
    pub(crate) async fn office_delegation_retry_prepare(
        &self,
        mut params: OfficeDelegationRetryParams,
    ) -> Result<office_run::PreparedOfficeDelegationDispatch, JSONRPCErrorError> {
        let (_authority, config) = self
            .office_records
            .lock_resolved_config_mutation(&params.cwd, &params.config)
            .await?;
        params.config = config;
        office_run::prepare_delegation_retry(params).await
    }

    pub(crate) async fn office_delegation_retry_prepare_permitted(
        &self,
        mut params: OfficeDelegationRetryParams,
    ) -> Result<
        PermittedOfficeDispatch<office_run::PreparedOfficeDelegationDispatch>,
        JSONRPCErrorError,
    > {
        let (authority, config) = self
            .office_records
            .lock_resolved_config_mutation(&params.cwd, &params.config)
            .await?;
        params.config = config;
        let prepared = office_run::prepare_delegation_retry(params).await?;
        self.permit_delegation_dispatch(authority, prepared).await
    }

    #[cfg(test)]
    pub(crate) async fn office_verification_dispatch_next_prepare(
        &self,
        mut params: OfficeVerificationDispatchNextParams,
    ) -> Result<office_run::PreparedOfficeVerificationDispatch, JSONRPCErrorError> {
        let (_authority, config) = self
            .office_records
            .lock_resolved_config_mutation(&params.cwd, &params.config)
            .await?;
        params.config = config;
        office_run::prepare_next_verification_dispatch(params).await
    }

    pub(crate) async fn office_verification_dispatch_next_prepare_permitted(
        &self,
        mut params: OfficeVerificationDispatchNextParams,
    ) -> Result<
        PermittedOfficeDispatch<office_run::PreparedOfficeVerificationDispatch>,
        JSONRPCErrorError,
    > {
        let (authority, config) = self
            .office_records
            .lock_resolved_config_mutation(&params.cwd, &params.config)
            .await?;
        params.config = config;
        let prepared = office_run::prepare_next_verification_dispatch(params).await?;
        self.permit_verification_dispatch(authority, prepared).await
    }

    #[cfg(test)]
    pub(crate) async fn office_verification_retry_prepare(
        &self,
        mut params: OfficeVerificationRetryParams,
    ) -> Result<office_run::PreparedOfficeVerificationDispatch, JSONRPCErrorError> {
        let (_authority, config) = self
            .office_records
            .lock_resolved_config_mutation(&params.cwd, &params.config)
            .await?;
        params.config = config;
        office_run::prepare_verification_retry(params).await
    }

    pub(crate) async fn office_verification_retry_prepare_permitted(
        &self,
        mut params: OfficeVerificationRetryParams,
    ) -> Result<
        PermittedOfficeDispatch<office_run::PreparedOfficeVerificationDispatch>,
        JSONRPCErrorError,
    > {
        let (authority, config) = self
            .office_records
            .lock_resolved_config_mutation(&params.cwd, &params.config)
            .await?;
        params.config = config;
        let prepared = office_run::prepare_verification_retry(params).await?;
        self.permit_verification_dispatch(authority, prepared).await
    }

    pub(crate) async fn office_auto_delegation_dispatch_prepare_after_thread_turn_permitted(
        &self,
        cwd: &str,
        thread_id: &str,
        turn: &Turn,
    ) -> Result<
        Option<PermittedOfficeDispatch<office_run::PreparedOfficeDelegationDispatch>>,
        JSONRPCErrorError,
    > {
        let authority = self
            .lock_auto_dispatch_mutation(cwd, thread_id, &turn.id)
            .await?;
        let Some(prepared) =
            office_run::prepare_auto_delegation_dispatch_after_thread_turn(cwd, thread_id, turn)
                .await?
        else {
            return Ok(None);
        };
        self.permit_delegation_dispatch(authority, prepared)
            .await
            .map(Some)
    }

    pub(crate) async fn office_auto_delegation_dispatch_recovery_scan(
        &self,
        cwd: &str,
        intent_id: &str,
        source_thread_id: &str,
        source_turn_id: &str,
    ) -> Result<Option<office_run::ScannedOfficeDispatchRecovery>, JSONRPCErrorError> {
        office_run::scan_exact_office_dispatch_recovery(
            cwd,
            intent_id,
            source_thread_id,
            source_turn_id,
        )
        .await
    }

    pub(crate) async fn office_auto_delegation_dispatch_recovery_prepare_permitted(
        &self,
        cwd: &str,
        file_path: &str,
        recovery: &super::crewon_domain_office_dispatch_recovery::LocatedOfficeDispatchRecovery,
    ) -> Result<PermittedOfficeDelegationDispatch, JSONRPCErrorError> {
        let authority = self.office_records.lock_authority(cwd).await?;
        let reloaded: office_run::ReloadedOfficeDispatchRecovery =
            office_run::reload_exact_office_dispatch_recovery(cwd, file_path, recovery).await?;
        authority
            .ensure_config_writable(&self.office_records, cwd, &reloaded.config)
            .await?;
        let prepared = office_run::prepare_recovered_delegation_dispatch(
            cwd,
            &reloaded.file_path,
            &reloaded.recovery,
        )
        .await?;
        self.permit_delegation_dispatch(authority, prepared).await
    }

    #[cfg(test)]
    pub(crate) async fn office_auto_verification_dispatch_prepare_after_thread_turn(
        &self,
        cwd: &str,
        thread_id: &str,
        turn: &Turn,
    ) -> Result<Option<office_run::PreparedOfficeVerificationDispatch>, JSONRPCErrorError> {
        let _authority = self
            .lock_auto_dispatch_mutation(cwd, thread_id, &turn.id)
            .await?;
        office_run::prepare_auto_verification_dispatch_after_thread_turn(cwd, thread_id, turn).await
    }

    pub(crate) async fn office_auto_verification_dispatch_prepare_after_thread_turn_permitted(
        &self,
        cwd: &str,
        thread_id: &str,
        turn: &Turn,
    ) -> Result<
        Option<PermittedOfficeDispatch<office_run::PreparedOfficeVerificationDispatch>>,
        JSONRPCErrorError,
    > {
        let authority = self
            .lock_auto_dispatch_mutation(cwd, thread_id, &turn.id)
            .await?;
        let Some(prepared) =
            office_run::prepare_auto_verification_dispatch_after_thread_turn(cwd, thread_id, turn)
                .await?
        else {
            return Ok(None);
        };
        self.permit_verification_dispatch(authority, prepared)
            .await
            .map(Some)
    }

    #[cfg(test)]
    pub(crate) async fn office_auto_retry_prepare_after_thread_turn(
        &self,
        cwd: &str,
        thread_id: &str,
        turn: &Turn,
    ) -> Result<Option<office_run::PreparedOfficeRun>, JSONRPCErrorError> {
        let _authority = self
            .lock_auto_dispatch_mutation(cwd, thread_id, &turn.id)
            .await?;
        office_run::prepare_auto_retry_after_thread_turn(cwd, thread_id, turn).await
    }

    pub(crate) async fn office_auto_retry_prepare_after_thread_turn_permitted(
        &self,
        cwd: &str,
        thread_id: &str,
        turn: &Turn,
    ) -> Result<Option<PermittedOfficeDispatch<office_run::PreparedOfficeRun>>, JSONRPCErrorError>
    {
        let authority = self
            .lock_auto_dispatch_mutation(cwd, thread_id, &turn.id)
            .await?;
        let Some(prepared) =
            office_run::prepare_auto_retry_after_thread_turn(cwd, thread_id, turn).await?
        else {
            return Ok(None);
        };
        self.permit_run_dispatch(authority, prepared)
            .await
            .map(Some)
    }

    pub(crate) async fn office_auto_verification_automation_records_after_thread_turn(
        &self,
        cwd: &str,
        thread_id: &str,
        turn: &Turn,
    ) -> Result<Vec<CrewonDomainConfigRecord>, JSONRPCErrorError> {
        let _authority = self
            .lock_auto_dispatch_mutation(cwd, thread_id, &turn.id)
            .await?;
        office_run::auto_verification_automation_records_after_thread_turn(cwd, thread_id, turn)
            .await
    }

    pub(crate) async fn office_auto_dispatch_intent_queue(
        &self,
        cwd: &str,
        source_thread_id: &str,
        source_turn_id: &str,
        reason: &str,
    ) -> Result<OfficeAutoDispatchIntentRef, JSONRPCErrorError> {
        let _authority = self
            .lock_auto_dispatch_mutation(cwd, source_thread_id, source_turn_id)
            .await?;
        let intent_id =
            office_run::queue_auto_dispatch_intent(cwd, source_thread_id, source_turn_id, reason)
                .await?;
        Ok(OfficeAutoDispatchIntentRef {
            intent_id,
            source_thread_id: source_thread_id.to_string(),
            source_turn_id: source_turn_id.to_string(),
        })
    }

    pub(crate) async fn office_auto_dispatch_pending_intents(
        &self,
        cwd: &str,
    ) -> Result<Vec<OfficeAutoDispatchIntentRef>, JSONRPCErrorError> {
        Ok(office_run::pending_auto_dispatch_intents(cwd)
            .await?
            .into_iter()
            .map(|intent| OfficeAutoDispatchIntentRef {
                intent_id: intent.intent_id,
                source_thread_id: intent.source_thread_id,
                source_turn_id: intent.source_turn_id,
            })
            .collect())
    }

    pub(crate) async fn office_auto_dispatch_intent_claim(
        &self,
        cwd: &str,
        intent_id: &str,
        source_thread_id: &str,
        source_turn_id: &str,
        lease_id: &str,
    ) -> Result<bool, JSONRPCErrorError> {
        let _authority = self
            .lock_auto_dispatch_mutation(cwd, source_thread_id, source_turn_id)
            .await?;
        office_run::claim_auto_dispatch_intent(
            cwd,
            intent_id,
            source_thread_id,
            source_turn_id,
            lease_id,
        )
        .await
    }

    pub(crate) async fn office_auto_dispatch_intent_dispatched(
        &self,
        cwd: &str,
        intent_id: &str,
        source_thread_id: &str,
        source_turn_id: &str,
        lease_id: &str,
        dispatched: OfficeAutoDispatchIntentDispatched<'_>,
    ) -> Result<(), JSONRPCErrorError> {
        let _authority = self
            .lock_auto_dispatch_drain(cwd, source_thread_id, source_turn_id)
            .await?;
        office_run::mark_auto_dispatch_intent_dispatched(
            cwd,
            intent_id,
            source_thread_id,
            source_turn_id,
            lease_id,
            office_run::AutoDispatchIntentDispatched {
                run_id: dispatched.run_id,
                dispatch_kind: dispatched.dispatch_kind,
                delegation_id: dispatched.delegation_id,
                verification_check_id: dispatched.verification_check_id,
                file_path: dispatched.file_path,
                dispatched_thread_id: dispatched.dispatched_thread_id,
                dispatched_turn_id: dispatched.dispatched_turn_id,
            },
        )
        .await
    }

    pub(crate) async fn office_auto_dispatch_recovery_admitted(
        &self,
        cwd: &str,
        file_path: &str,
        expected: &super::crewon_domain_office_dispatch_recovery::LocatedOfficeDispatchRecovery,
        lease_id: &str,
    ) -> Result<office_run::ReloadedOfficeDispatchRecovery, JSONRPCErrorError> {
        let authority = self.office_records.lock_authority(cwd).await?;
        let reloaded =
            office_run::reload_exact_office_dispatch_recovery(cwd, file_path, expected).await?;
        authority
            .ensure_config_drainable(&self.office_records, cwd, &reloaded.config)
            .await?;
        let turn_id = reloaded.recovery.turn_id.as_deref().ok_or_else(|| {
            invalid_params("Office admitted dispatch recovery is missing its turn")
        })?;
        office_run::mark_auto_dispatch_intent_dispatched(
            cwd,
            &reloaded.recovery.intent_id,
            &reloaded.recovery.source_thread_id,
            &reloaded.recovery.source_turn_id,
            lease_id,
            office_run::AutoDispatchIntentDispatched {
                run_id: &reloaded.recovery.run_id,
                dispatch_kind: "delegation",
                delegation_id: Some(&reloaded.recovery.delegation_id),
                verification_check_id: None,
                file_path: &reloaded.file_path,
                dispatched_thread_id: &reloaded.recovery.target_thread_id,
                dispatched_turn_id: turn_id,
            },
        )
        .await?;
        Ok(reloaded)
    }

    pub(crate) async fn office_auto_dispatch_quarantine_execution_unknown(
        &self,
        cwd: &str,
        file_path: &str,
        expected: &super::crewon_domain_office_dispatch_recovery::LocatedOfficeDispatchRecovery,
        lease_id: &str,
        turn_id: &str,
        state: crewon_core::UserInputOnceState,
    ) -> Result<office_run::ReloadedOfficeDispatchRecovery, JSONRPCErrorError> {
        let authority = self.office_records.lock_authority(cwd).await?;
        let reloaded =
            office_run::reload_exact_office_dispatch_recovery(cwd, file_path, expected).await?;
        authority
            .ensure_config_drainable(&self.office_records, cwd, &reloaded.config)
            .await?;
        let (config, changed, recovery) = office_run::quarantine_dispatch_execution_unknown(
            reloaded.config,
            &reloaded.recovery,
            turn_id,
            state,
        )?;
        if changed {
            update_record(DomainKind::Office, cwd, &reloaded.file_path, config.clone()).await?;
        }
        office_run::mark_auto_dispatch_intent_execution_unknown(
            cwd,
            lease_id,
            &recovery,
            &reloaded.file_path,
            turn_id,
        )
        .await?;
        Ok(office_run::ReloadedOfficeDispatchRecovery {
            config,
            file_path: reloaded.file_path,
            recovery,
        })
    }

    pub(crate) async fn office_auto_delegation_quarantine_execution_unknown(
        &self,
        permitted: PermittedOfficeDispatch<office_run::PreparedOfficeDelegationDispatch>,
        token: super::crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptToken<'_>,
        turn_id: &str,
        state: crewon_core::UserInputOnceState,
        lease_id: &str,
    ) -> Result<office_run::ReloadedOfficeDispatchRecovery, JSONRPCErrorError> {
        let (prepared, permit) = permitted.into_parts();
        validate_delegation_receipt_token(&prepared, permit.record_id(), token)?;
        permit
            .ensure_config_identity(&prepared.cwd, &prepared.config)
            .await?;
        let cwd = prepared.cwd.clone();
        let run_id = prepared.run_id.clone();
        let delegation_id = prepared.delegation_id.clone();
        let (file_path, config, _) = office_run::quarantine_delegation_execution_unknown(
            &cwd,
            prepared.config,
            &run_id,
            &delegation_id,
            token,
            turn_id,
            state,
            office_run::EXECUTION_UNKNOWN_MESSAGE,
        )
        .await?;
        let recovery =
            super::crewon_domain_office_dispatch_recovery::locate_office_dispatch_recovery(
                &config,
                token.intent_id,
                token.source_thread_id,
                token.source_turn_id,
            )
            .map_err(|_| invalid_params("Office dispatch reconciliation receipt is corrupt"))?
            .ok_or_else(|| invalid_params("Office dispatch reconciliation receipt is missing"))?;
        office_run::mark_auto_dispatch_intent_execution_unknown(
            &cwd, lease_id, &recovery, &file_path, turn_id,
        )
        .await?;
        drop(permit);
        Ok(office_run::ReloadedOfficeDispatchRecovery {
            config,
            file_path,
            recovery,
        })
    }

    pub(crate) async fn office_auto_dispatch_intent_failed(
        &self,
        cwd: &str,
        intent_id: &str,
        source_thread_id: &str,
        source_turn_id: &str,
        lease_id: &str,
        message: &str,
    ) -> Result<(), JSONRPCErrorError> {
        let _authority = self
            .lock_auto_dispatch_drain(cwd, source_thread_id, source_turn_id)
            .await?;
        office_run::mark_auto_dispatch_intent_failed(
            cwd,
            intent_id,
            source_thread_id,
            source_turn_id,
            lease_id,
            message,
        )
        .await
    }

    pub(crate) async fn office_auto_dispatch_recovery_failed(
        &self,
        cwd: &str,
        file_path: &str,
        expected: &super::crewon_domain_office_dispatch_recovery::LocatedOfficeDispatchRecovery,
        lease_id: &str,
    ) -> Result<office_run::ReloadedOfficeDispatchRecovery, JSONRPCErrorError> {
        let authority = self.office_records.lock_authority(cwd).await?;
        let reloaded =
            office_run::reload_exact_office_dispatch_recovery(cwd, file_path, expected).await?;
        authority
            .ensure_config_drainable(&self.office_records, cwd, &reloaded.config)
            .await?;
        let message = reloaded.recovery.last_error.as_deref().ok_or_else(|| {
            invalid_params("Office failed dispatch recovery is missing its error")
        })?;
        office_run::mark_auto_dispatch_intent_failed(
            cwd,
            &reloaded.recovery.intent_id,
            &reloaded.recovery.source_thread_id,
            &reloaded.recovery.source_turn_id,
            lease_id,
            message,
        )
        .await?;
        Ok(reloaded)
    }

    pub(crate) async fn office_auto_dispatch_intent_clear(
        &self,
        cwd: &str,
        intent_id: &str,
        source_thread_id: &str,
        source_turn_id: &str,
        lease_id: &str,
    ) -> Result<(), JSONRPCErrorError> {
        let _authority = self
            .lock_auto_dispatch_drain(cwd, source_thread_id, source_turn_id)
            .await?;
        office_run::clear_auto_dispatch_intent(
            cwd,
            intent_id,
            source_thread_id,
            source_turn_id,
            lease_id,
        )
        .await
    }

    #[cfg(test)]
    pub(crate) async fn office_delegation_dispatch_mark_started(
        &self,
        cwd: &str,
        config: JsonValue,
        run_id: &str,
        delegation_id: &str,
        turn_id: &str,
    ) -> Result<(String, JsonValue), JSONRPCErrorError> {
        let (_authority, config) = self
            .office_records
            .lock_resolved_config_mutation(cwd, &config)
            .await?;
        office_run::mark_delegation_started(cwd, config, run_id, delegation_id, turn_id).await
    }

    pub(crate) async fn office_auto_delegation_reserve_starting(
        &self,
        permitted: &mut PermittedOfficeDispatch<office_run::PreparedOfficeDelegationDispatch>,
        token: super::crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptToken<'_>,
    ) -> Result<
        super::crewon_domain_office_dispatch_receipt::OfficeDispatchReceipt,
        JSONRPCErrorError,
    > {
        validate_delegation_receipt_token(permitted.prepared(), permitted.record_id(), token)?;
        permitted
            .permit
            .ensure_config_identity(&permitted.prepared.cwd, &permitted.prepared.config)
            .await?;
        let prepared = permitted.prepared();
        let (config, receipt) = office_run::reserve_delegation_starting(
            &prepared.cwd,
            prepared.config.clone(),
            &prepared.run_id,
            &prepared.delegation_id,
            token,
        )
        .await?;
        permitted.prepared_mut().config = config;
        Ok(receipt)
    }

    pub(crate) async fn office_auto_delegation_commit_admitted(
        &self,
        permitted: PermittedOfficeDispatch<office_run::PreparedOfficeDelegationDispatch>,
        token: super::crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptToken<'_>,
        turn_id: &str,
        state: crewon_core::UserInputOnceState,
    ) -> Result<
        (
            String,
            JsonValue,
            super::crewon_domain_office_dispatch_receipt::OfficeDispatchReceipt,
        ),
        JSONRPCErrorError,
    > {
        let (prepared, permit) = permitted.into_parts();
        validate_delegation_receipt_token(&prepared, permit.record_id(), token)?;
        permit
            .ensure_config_identity(&prepared.cwd, &prepared.config)
            .await?;
        office_run::commit_delegation_admitted(
            &prepared.cwd,
            prepared.config,
            &prepared.run_id,
            &prepared.delegation_id,
            token,
            turn_id,
            state,
        )
        .await
    }

    pub(crate) async fn office_auto_delegation_fail_starting(
        &self,
        permitted: PermittedOfficeDispatch<office_run::PreparedOfficeDelegationDispatch>,
        token: super::crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptToken<'_>,
        message: &str,
    ) -> Result<(String, JsonValue), JSONRPCErrorError> {
        let (prepared, permit) = permitted.into_parts();
        validate_delegation_receipt_token(&prepared, permit.record_id(), token)?;
        permit
            .ensure_config_identity(&prepared.cwd, &prepared.config)
            .await?;
        office_run::fail_delegation_starting(
            &prepared.cwd,
            prepared.config,
            &prepared.run_id,
            &prepared.delegation_id,
            token,
            message,
        )
        .await
    }

    pub(crate) async fn office_delegation_dispatch_mark_started_permitted(
        &self,
        permitted: PermittedOfficeDispatch<office_run::PreparedOfficeDelegationDispatch>,
        turn_id: &str,
    ) -> Result<(String, JsonValue), JSONRPCErrorError> {
        let (prepared, permit) = permitted.into_parts();
        permit
            .ensure_config_identity(&prepared.cwd, &prepared.config)
            .await?;
        office_run::mark_delegation_started(
            &prepared.cwd,
            prepared.config,
            &prepared.run_id,
            &prepared.delegation_id,
            turn_id,
        )
        .await
    }

    #[cfg(test)]
    pub(crate) async fn office_delegation_dispatch_mark_failed(
        &self,
        cwd: &str,
        config: JsonValue,
        run_id: &str,
        delegation_id: &str,
        message: &str,
    ) -> Result<(), JSONRPCErrorError> {
        let (_authority, config) = self
            .office_records
            .lock_resolved_config_drain(cwd, &config)
            .await?;
        office_run::mark_delegation_failed(cwd, config, run_id, delegation_id, message).await
    }

    pub(crate) async fn office_delegation_dispatch_mark_failed_permitted(
        &self,
        permitted: PermittedOfficeDispatch<office_run::PreparedOfficeDelegationDispatch>,
        message: &str,
    ) -> Result<(), JSONRPCErrorError> {
        let (prepared, permit) = permitted.into_parts();
        permit
            .ensure_config_identity(&prepared.cwd, &prepared.config)
            .await?;
        office_run::mark_delegation_failed(
            &prepared.cwd,
            prepared.config,
            &prepared.run_id,
            &prepared.delegation_id,
            message,
        )
        .await
    }

    #[cfg(test)]
    pub(crate) async fn office_verification_dispatch_mark_started(
        &self,
        cwd: &str,
        config: JsonValue,
        started: OfficeVerificationDispatchStarted<'_>,
    ) -> Result<(String, JsonValue), JSONRPCErrorError> {
        let (_authority, config) = self
            .office_records
            .lock_resolved_config_mutation(cwd, &config)
            .await?;
        office_run::mark_verification_dispatch_started(
            cwd,
            config,
            office_run::StartedOfficeVerificationDispatch {
                run_id: started.run_id,
                verification_check_id: started.verification_check_id,
                automation_run_file_path: started.automation_run_file_path,
                automation_run_id: started.automation_run_id,
                automation_thread_id: started.automation_thread_id,
                automation_turn_id: started.automation_turn_id,
                runtime_repair_source_thread_id: started.runtime_repair_source_thread_id,
                runtime_repaired_at: started.runtime_repaired_at,
            },
        )
        .await
    }

    pub(crate) async fn office_verification_dispatch_mark_started_permitted(
        &self,
        permitted: PermittedOfficeDispatch<office_run::PreparedOfficeVerificationDispatch>,
        started: OfficeVerificationDispatchStarted<'_>,
    ) -> Result<(String, JsonValue), JSONRPCErrorError> {
        let (prepared, permit) = permitted.into_parts();
        if started.run_id != prepared.run_id
            || started.verification_check_id != prepared.verification_check_id
        {
            return Err(invalid_params(
                "Office verification start does not match its dispatch permit",
            ));
        }
        permit
            .ensure_config_identity(&prepared.cwd, &prepared.config)
            .await?;
        office_run::mark_verification_dispatch_started(
            &prepared.cwd,
            prepared.config,
            office_run::StartedOfficeVerificationDispatch {
                run_id: &prepared.run_id,
                verification_check_id: &prepared.verification_check_id,
                automation_run_file_path: started.automation_run_file_path,
                automation_run_id: started.automation_run_id,
                automation_thread_id: started.automation_thread_id,
                automation_turn_id: started.automation_turn_id,
                runtime_repair_source_thread_id: started.runtime_repair_source_thread_id,
                runtime_repaired_at: started.runtime_repaired_at,
            },
        )
        .await
    }

    pub(crate) async fn office_verification_dispatch_mark_failed_permitted(
        &self,
        permitted: PermittedOfficeDispatch<office_run::PreparedOfficeVerificationDispatch>,
        message: &str,
    ) -> Result<(), JSONRPCErrorError> {
        let (prepared, permit) = permitted.into_parts();
        permit
            .ensure_config_identity(&prepared.cwd, &prepared.config)
            .await?;
        office_run::mark_verification_dispatch_failed(
            &prepared.cwd,
            prepared.config,
            &prepared.run_id,
            &prepared.verification_check_id,
            message,
        )
        .await
    }

    pub(crate) async fn office_verification_dispatch_mark_retryable_start_failure_permitted(
        &self,
        permitted: PermittedOfficeDispatch<office_run::PreparedOfficeVerificationDispatch>,
        message: &str,
    ) -> Result<(), JSONRPCErrorError> {
        let (prepared, permit) = permitted.into_parts();
        permit
            .ensure_config_identity(&prepared.cwd, &prepared.config)
            .await?;
        office_run::mark_verification_dispatch_retryable_start_failure(
            &prepared.cwd,
            prepared.config,
            &prepared.run_id,
            &prepared.verification_check_id,
            message,
        )
        .await
    }

    pub(crate) async fn office_member_add(
        &self,
        params: OfficeMemberAddParams,
    ) -> Result<OfficeMemberAddResponse, JSONRPCErrorError> {
        let agent_record = read_agent_record(
            &params.cwd,
            Some(&params.agent_id),
            /*thread_id*/ None,
            /*name*/ None,
        )
        .await?;
        let mut config = append_office_member(
            params.config,
            &params.agent_id,
            params.member,
            agent_record.as_ref().map(|record| &record.config),
        )?;
        resolve_office_member_runtimes(&params.cwd, &mut config).await?;
        self.office_records
            .save(&params.cwd, config.clone())
            .await
            .map(|file_path| OfficeMemberAddResponse { file_path, config })
    }

    pub(crate) async fn office_approval_decide(
        &self,
        params: OfficeApprovalDecideParams,
    ) -> Result<OfficeApprovalDecideResponse, JSONRPCErrorError> {
        let config = decide_office_approval(
            params.config,
            &params.approval_id,
            params.decision,
            params.message,
        )?;
        self.office_records
            .save(&params.cwd, config.clone())
            .await
            .map(|file_path| OfficeApprovalDecideResponse { file_path, config })
    }

    pub(crate) async fn office_artifact_upsert(
        &self,
        params: OfficeArtifactUpsertParams,
    ) -> Result<OfficeArtifactUpsertResponse, JSONRPCErrorError> {
        let mut config = upsert_office_artifact(params.config, params.artifact, params.message)?;
        apply_office_artifact_file_fingerprints(&params.cwd, &mut config).await?;
        self.office_records
            .save(&params.cwd, config.clone())
            .await
            .map(|file_path| OfficeArtifactUpsertResponse { file_path, config })
    }

    pub(crate) async fn office_delete(
        &self,
        params: OfficeDeleteParams,
    ) -> Result<OfficeDeleteResponse, JSONRPCErrorError> {
        self.office_records
            .delete(&params.cwd, &params.file_path)
            .await
            .map(|deleted| OfficeDeleteResponse { deleted })
    }

    pub(crate) async fn automation_list(
        &self,
        params: AutomationListParams,
    ) -> Result<AutomationListResponse, JSONRPCErrorError> {
        list_records(
            DomainKind::Automation,
            &params.cwd,
            params.cursor,
            params.limit,
        )
        .await
        .map(|(data, next_cursor)| AutomationListResponse { data, next_cursor })
    }

    pub(crate) async fn automation_save(
        &self,
        params: AutomationSaveParams,
    ) -> Result<AutomationSaveResponse, JSONRPCErrorError> {
        save_record(DomainKind::Automation, &params.cwd, params.config)
            .await
            .map(|file_path| AutomationSaveResponse { file_path })
    }

    pub(crate) async fn automation_create(
        &self,
        params: AutomationCreateParams,
    ) -> Result<AutomationCreateResponse, JSONRPCErrorError> {
        let cwd = params.cwd.clone();
        let config = create_automation_config(params)?;
        save_record(DomainKind::Automation, &cwd, config.clone())
            .await
            .map(|file_path| AutomationCreateResponse { file_path, config })
    }

    pub(crate) async fn automation_read(
        &self,
        params: AutomationReadParams,
    ) -> Result<AutomationReadResponse, JSONRPCErrorError> {
        read_automation_record(
            &params.cwd,
            params.file_path.as_deref(),
            params.thread_id.as_deref(),
            params.title.as_deref(),
        )
        .await
        .map(|record| AutomationReadResponse { record })
    }

    pub(crate) async fn automation_update(
        &self,
        params: AutomationUpdateParams,
    ) -> Result<AutomationUpdateResponse, JSONRPCErrorError> {
        let config = params.config;
        update_record(
            DomainKind::Automation,
            &params.cwd,
            &params.file_path,
            config.clone(),
        )
        .await
        .map(|file_path| AutomationUpdateResponse { file_path, config })
    }

    pub(crate) async fn automation_read_by_identifier(
        &self,
        cwd: &str,
        automation_id: &str,
    ) -> Result<Option<CrewonDomainConfigRecord>, JSONRPCErrorError> {
        office_run::read_automation_record_by_identifier(cwd, automation_id).await
    }

    pub(crate) async fn automation_run(
        &self,
        params: AutomationRunParams,
    ) -> Result<AutomationRunResponse, JSONRPCErrorError> {
        create_automation_run(&params.cwd, params.config, params.note, params.turn_id).await
    }

    pub(crate) async fn automation_run_start_prepare(
        &self,
        params: AutomationRunStartParams,
    ) -> Result<PreparedAutomationRunStart, JSONRPCErrorError> {
        prepare_automation_run_start(params)
    }

    pub(crate) async fn automation_run_start_record(
        &self,
        prepared: &PreparedAutomationRunStart,
        turn_id: &str,
    ) -> Result<AutomationRunResponse, JSONRPCErrorError> {
        create_automation_run(
            &prepared.cwd,
            prepared.config.clone(),
            prepared.note.clone(),
            Some(turn_id.to_string()),
        )
        .await
    }

    pub(crate) async fn automation_run_update(
        &self,
        params: AutomationRunUpdateParams,
    ) -> Result<AutomationRunUpdateResponse, JSONRPCErrorError> {
        update_automation_run(
            &params.cwd,
            &params.file_path,
            params.status,
            params.completed_at,
        )
        .await
    }

    pub(crate) async fn automation_runs_list(
        &self,
        params: AutomationRunsListParams,
    ) -> Result<AutomationRunsListResponse, JSONRPCErrorError> {
        list_automation_runs(
            &params.cwd,
            params.thread_id.as_deref(),
            params.cursor,
            params.limit,
        )
        .await
        .map(|(data, next_cursor)| AutomationRunsListResponse { data, next_cursor })
    }

    pub(crate) async fn automation_delete(
        &self,
        params: AutomationDeleteParams,
    ) -> Result<AutomationDeleteResponse, JSONRPCErrorError> {
        delete_record(DomainKind::Automation, &params.cwd, &params.file_path)
            .await
            .map(|deleted| AutomationDeleteResponse { deleted })
    }

    pub(crate) async fn tool_list(
        &self,
        params: ToolListParams,
    ) -> Result<ToolListResponse, JSONRPCErrorError> {
        let (records, next_cursor) =
            list_tool_records(&params.cwd, params.kind, params.cursor, params.limit).await?;
        Ok(ToolListResponse {
            data: records,
            next_cursor,
        })
    }

    pub(crate) async fn tool_save(
        &self,
        params: ToolSaveParams,
    ) -> Result<ToolSaveResponse, JSONRPCErrorError> {
        save_record(DomainKind::Tool, &params.cwd, params.config)
            .await
            .map(|file_path| ToolSaveResponse { file_path })
    }

    pub(crate) async fn tool_read(
        &self,
        params: ToolReadParams,
    ) -> Result<ToolReadResponse, JSONRPCErrorError> {
        let record = read_tool_record(&params.cwd, &params.file_path).await?;
        Ok(ToolReadResponse { record })
    }

    pub(crate) async fn tool_update(
        &self,
        params: ToolUpdateParams,
    ) -> Result<ToolUpdateResponse, JSONRPCErrorError> {
        let config = params.config;
        update_record(
            DomainKind::Tool,
            &params.cwd,
            &params.file_path,
            config.clone(),
        )
        .await
        .map(|file_path| ToolUpdateResponse { file_path, config })
    }

    pub(crate) async fn tool_delete(
        &self,
        params: ToolDeleteParams,
    ) -> Result<ToolDeleteResponse, JSONRPCErrorError> {
        delete_record(DomainKind::Tool, &params.cwd, &params.file_path)
            .await
            .map(|deleted| ToolDeleteResponse { deleted })
    }
}

fn validate_delegation_receipt_token(
    prepared: &office_run::PreparedOfficeDelegationDispatch,
    permit_record_id: &str,
    token: super::crewon_domain_office_dispatch_receipt::OfficeDispatchReceiptToken<'_>,
) -> Result<(), JSONRPCErrorError> {
    let explicit_record_id = prepared
        .config
        .get("workspace")
        .and_then(|workspace| workspace.get("recordId"))
        .and_then(JsonValue::as_str);
    if explicit_record_id != Some(permit_record_id)
        || token.record_id != permit_record_id
        || token.run_id != prepared.run_id
        || token.delegation_id != prepared.delegation_id
        || token.target_thread_id != prepared.thread_id
    {
        return Err(invalid_params(
            "Office dispatch receipt does not match the permitted delegation",
        ));
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDomainConfigRecord {
    version: u32,
    kind: String,
    saved_at: Option<String>,
    config: JsonValue,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedAutomationRunRecord {
    version: u32,
    saved_at: Option<i64>,
    run: AutomationRunRecord,
}

#[derive(Debug)]
pub(crate) struct PreparedAutomationRunStart {
    pub(crate) cwd: String,
    pub(crate) config: JsonValue,
    pub(crate) thread_id: String,
    pub(crate) prompt: String,
    pub(crate) note: Option<String>,
    pub(crate) client_user_message_id: Option<String>,
}

#[cfg(test)]
pub(crate) async fn sync_office_runs_for_thread_turn(
    cwd: &str,
    thread_id: &str,
    turn: &Turn,
) -> Result<usize, JSONRPCErrorError> {
    office_run::sync_thread_turn(cwd, thread_id, turn).await
}

pub(crate) fn office_run_updated_notification(
    cwd: &str,
    file_path: &str,
    config: &JsonValue,
    reason: &str,
    source_thread_id: Option<&str>,
    source_turn_id: Option<&str>,
) -> ServerNotification {
    ServerNotification::OfficeRunUpdated(OfficeRunUpdatedNotification {
        cwd: cwd.to_string(),
        file_path: file_path.to_string(),
        config: config.clone(),
        reason: reason.to_string(),
        source_thread_id: source_thread_id.map(str::to_string),
        source_turn_id: source_turn_id.map(str::to_string),
    })
}

pub(crate) fn workflow_run_updated_notification(
    cwd: &str,
    file_path: &str,
    config: &JsonValue,
    reason: &str,
    source_thread_id: Option<&str>,
    source_turn_id: Option<&str>,
) -> ServerNotification {
    ServerNotification::WorkflowRunUpdated(WorkflowRunUpdatedNotification {
        cwd: cwd.to_string(),
        file_path: file_path.to_string(),
        config: config.clone(),
        reason: reason.to_string(),
        source_thread_id: source_thread_id.map(str::to_string),
        source_turn_id: source_turn_id.map(str::to_string),
    })
}

async fn list_records(
    kind: DomainKind,
    cwd: &str,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<(Vec<CrewonDomainConfigRecord>, Option<String>), JSONRPCErrorError> {
    list_records_matching(kind, cwd, cursor, limit, |_| true).await
}

async fn list_records_matching(
    kind: DomainKind,
    cwd: &str,
    cursor: Option<String>,
    limit: Option<u32>,
    mut include_record: impl FnMut(&CrewonDomainConfigRecord) -> bool,
) -> Result<(Vec<CrewonDomainConfigRecord>, Option<String>), JSONRPCErrorError> {
    let offset = parse_cursor(cursor)?;
    let limit = normalize_limit(limit);
    let directory = domain_directory(cwd, kind)?;
    let mut entries = match fs::read_dir(&directory).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok((Vec::new(), None)),
        Err(err) => {
            return Err(internal_error(format!(
                "failed to read {}: {err}",
                directory.display()
            )));
        }
    };

    let mut records = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(map_io_error)? {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }

        let file_type = match entry.file_type().await {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if !file_type.is_file() {
            continue;
        }

        let Some(record) = read_record(kind, &path).await? else {
            continue;
        };
        if !include_record(&record) {
            continue;
        }
        records.push(record);
    }

    records.sort_by(|left, right| right.saved_at.cmp(&left.saved_at));
    let next_cursor = if records.len() > offset + limit {
        Some((offset + limit).to_string())
    } else {
        None
    };
    let records = records.into_iter().skip(offset).take(limit).collect();
    Ok((records, next_cursor))
}

async fn read_record(
    kind: DomainKind,
    path: &Path,
) -> Result<Option<CrewonDomainConfigRecord>, JSONRPCErrorError> {
    if matches!(kind, DomainKind::Office) {
        let metadata = match fs::symlink_metadata(path).await {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(map_io_error(err)),
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(invalid_params(
                "Office record must be a regular server-owned file",
            ));
        }
        if metadata.len() == 0 || metadata.len() > crewon_state::MAX_OFFICE_MIGRATION_SOURCE_BYTES {
            return Err(invalid_params("Office record exceeds its bounded size"));
        }
    }
    let bytes = match fs::read(path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) if matches!(kind, DomainKind::Office) => return Err(map_io_error(err)),
        Err(_) => return Ok(None),
    };
    let record = match serde_json::from_slice::<PersistedDomainConfigRecord>(&bytes) {
        Ok(record) => record,
        Err(err) if matches!(kind, DomainKind::Office) => {
            return Err(internal_error(format!(
                "Office record is corrupt and cannot be used: {err}"
            )));
        }
        Err(_) => return Ok(None),
    };
    if record.version != 1
        || record.kind != kind.record_kind()
        || !kind.config_matches(&record.config)
    {
        return Ok(None);
    }

    Ok(Some(CrewonDomainConfigRecord {
        file_path: path.to_string_lossy().into_owned(),
        saved_at: record.saved_at.unwrap_or_default(),
        config: record.config,
    }))
}

async fn list_tool_records(
    cwd: &str,
    kind_filter: Option<ToolConfigKind>,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<(Vec<CrewonToolConfigRecord>, Option<String>), JSONRPCErrorError> {
    let (records, next_cursor) =
        list_records_matching(DomainKind::Tool, cwd, cursor, limit, |record| {
            let Some(kind) = tool_kind(&record.config) else {
                return false;
            };
            match kind_filter {
                Some(kind_filter) => kind_filter == kind,
                None => true,
            }
        })
        .await?;
    let records = records
        .into_iter()
        .filter_map(tool_record_from_domain)
        .collect();
    Ok((records, next_cursor))
}

async fn read_tool_record(
    cwd: &str,
    file_path: &str,
) -> Result<Option<CrewonToolConfigRecord>, JSONRPCErrorError> {
    let file_path = validate_record_file_path(cwd, DomainKind::Tool, file_path)?;
    let Some(record) = read_record(DomainKind::Tool, &file_path).await? else {
        return Ok(None);
    };
    Ok(tool_record_from_domain(record))
}

fn tool_record_from_domain(record: CrewonDomainConfigRecord) -> Option<CrewonToolConfigRecord> {
    let kind = tool_kind(&record.config)?;
    Some(CrewonToolConfigRecord {
        file_path: record.file_path,
        saved_at: record.saved_at,
        kind,
        config: record.config,
    })
}

async fn save_record(
    kind: DomainKind,
    cwd: &str,
    config: JsonValue,
) -> Result<String, JSONRPCErrorError> {
    if !kind.config_matches(&config) {
        return Err(invalid_params(format!(
            "{} config is missing required fields",
            kind.record_kind()
        )));
    }

    let directory = domain_directory(cwd, kind)?;
    fs::create_dir_all(&directory).await.map_err(map_io_error)?;

    if matches!(kind, DomainKind::Office)
        && let Some(record_id) = office_record_identity::record_id(&config)
    {
        let (records, _) = list_records(
            DomainKind::Office,
            cwd,
            /*cursor*/ None,
            Some(MAX_LIST_LIMIT as u32),
        )
        .await?;
        let record = records
            .into_iter()
            .find(|record| office_record_identity::record_id(&record.config) == Some(record_id))
            .ok_or_else(|| {
                invalid_params(
                    "office record identity no longer exists; reload the Office list before retrying",
                )
            })?;
        return update_record(kind, cwd, &record.file_path, config).await;
    }

    let saved_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let file_path = directory.join(domain_file_name(kind, &config));
    write_domain_record(kind, &file_path, saved_at, config).await?;
    Ok(file_path.to_string_lossy().into_owned())
}

async fn create_record(
    kind: DomainKind,
    cwd: &str,
    config: JsonValue,
) -> Result<String, JSONRPCErrorError> {
    if !kind.config_matches(&config) {
        return Err(invalid_params(format!(
            "{} config is missing required fields",
            kind.record_kind()
        )));
    }

    let directory = domain_directory(cwd, kind)?;
    fs::create_dir_all(&directory).await.map_err(map_io_error)?;

    let saved_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let file_path = directory.join(domain_file_name(kind, &config));
    if fs::try_exists(&file_path).await.map_err(map_io_error)? {
        return Err(invalid_params(format!(
            "{} config already exists",
            kind.record_kind()
        )));
    }
    write_domain_record(kind, &file_path, saved_at, config).await?;
    Ok(file_path.to_string_lossy().into_owned())
}

async fn update_record(
    kind: DomainKind,
    cwd: &str,
    file_path: &str,
    config: JsonValue,
) -> Result<String, JSONRPCErrorError> {
    if !kind.config_matches(&config) {
        return Err(invalid_params(format!(
            "{} config is missing required fields",
            kind.record_kind()
        )));
    }

    let file_path = validate_record_file_path(cwd, kind, file_path)?;
    match read_record(kind, &file_path).await? {
        Some(_) => {
            let saved_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
            write_domain_record(kind, &file_path, saved_at, config).await?;
            Ok(file_path.to_string_lossy().into_owned())
        }
        None => Err(invalid_params(format!(
            "{} config file does not match the requested kind",
            kind.record_kind()
        ))),
    }
}

async fn write_domain_record(
    kind: DomainKind,
    file_path: &Path,
    saved_at: String,
    config: JsonValue,
) -> Result<(), JSONRPCErrorError> {
    let _record_guard = if matches!(kind, DomainKind::Office) {
        Some(
            office_record_lock::lock(file_path)
                .await
                .map_err(map_io_error)?,
        )
    } else {
        None
    };
    write_domain_record_unlocked(kind, file_path, saved_at, config).await
}

async fn write_domain_record_unlocked(
    kind: DomainKind,
    file_path: &Path,
    saved_at: String,
    config: JsonValue,
) -> Result<(), JSONRPCErrorError> {
    let record = PersistedDomainConfigRecord {
        version: 1,
        kind: kind.record_kind().to_string(),
        saved_at: Some(saved_at),
        config,
    };

    let mut contents = serde_json::to_string_pretty(&record)
        .map_err(|err| internal_error(format!("failed to serialize domain config: {err}")))?;
    contents.push('\n');
    if matches!(kind, DomainKind::Office)
        && contents.len() as u64 > crewon_state::MAX_OFFICE_MIGRATION_SOURCE_BYTES
    {
        return Err(invalid_params("Office record exceeds its bounded size"));
    }
    let file_path = file_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        crewon_core::path_utils::write_atomically(&file_path, &contents)
    })
    .await
    .map_err(|err| internal_error(format!("failed to join domain config write: {err}")))?
    .map_err(map_io_error)
}

async fn create_automation_run(
    cwd: &str,
    config: JsonValue,
    note: Option<String>,
    turn_id: Option<String>,
) -> Result<AutomationRunResponse, JSONRPCErrorError> {
    if !DomainKind::Automation.config_matches(&config) {
        return Err(invalid_params(
            "automation config is missing required fields",
        ));
    }

    let directory = automation_runs_directory(cwd)?;
    fs::create_dir_all(&directory).await.map_err(map_io_error)?;
    let now = Utc::now();
    let started_at = now.timestamp();
    let title = config
        .get("title")
        .and_then(JsonValue::as_str)
        .unwrap_or("automation")
        .to_string();
    let thread_id = config
        .get("threadId")
        .and_then(JsonValue::as_str)
        .map(str::to_string);
    let run_id = format!("run-{}", Uuid::now_v7());
    let run = AutomationRunRecord {
        run_id: run_id.clone(),
        automation_title: title.clone(),
        thread_id,
        turn_id,
        status: "running".to_string(),
        started_at,
        completed_at: None,
        note,
        config,
    };
    let file_path = directory.join(format!(
        "{}-{}.json",
        slugify(&title, "automation"),
        slugify(&run_id, &run_id)
    ));
    let record = PersistedAutomationRunRecord {
        version: 1,
        saved_at: Some(started_at),
        run: run.clone(),
    };
    let mut bytes = serde_json::to_vec_pretty(&record)
        .map_err(|err| internal_error(format!("failed to serialize automation run: {err}")))?;
    bytes.push(b'\n');
    fs::write(&file_path, bytes).await.map_err(map_io_error)?;
    Ok(AutomationRunResponse {
        file_path: file_path.to_string_lossy().into_owned(),
        run,
    })
}

fn prepare_automation_run_start(
    params: AutomationRunStartParams,
) -> Result<PreparedAutomationRunStart, JSONRPCErrorError> {
    let AutomationRunStartParams {
        cwd,
        config,
        note,
        locale,
        client_user_message_id,
    } = params;
    if !DomainKind::Automation.config_matches(&config) {
        return Err(invalid_params(
            "automation config is missing required fields",
        ));
    }
    let thread_id = config
        .get("threadId")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|thread_id| !thread_id.is_empty())
        .ok_or_else(|| invalid_params("automation config has no threadId to start"))?
        .to_string();
    let prompt = build_automation_run_start_prompt(&config, note.as_deref(), locale.as_deref());
    Ok(PreparedAutomationRunStart {
        cwd,
        config,
        thread_id,
        prompt,
        note,
        client_user_message_id,
    })
}

fn build_automation_run_start_prompt(
    config: &JsonValue,
    note: Option<&str>,
    locale: Option<&str>,
) -> String {
    let is_zh = locale != Some("en");
    let title = config
        .get("title")
        .and_then(JsonValue::as_str)
        .unwrap_or("Automation");
    let prompt = config
        .get("prompt")
        .and_then(JsonValue::as_str)
        .filter(|prompt| !prompt.trim().is_empty())
        .unwrap_or({
            if is_zh {
                "运行自动化，记录结果、下一步和风险。"
            } else {
                "Run the automation. Record results, next steps, and risks."
            }
        });
    let thread_id = config
        .get("threadId")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    let mut parts = vec![
        prompt.to_string(),
        if is_zh {
            format!("自动化：{title}")
        } else {
            format!("Automation: {title}")
        },
        if is_zh {
            format!("执行线程：{thread_id}")
        } else {
            format!("Execution thread: {thread_id}")
        },
        if is_zh {
            "执行要求：遵守当前线程权限、审批和沙箱策略；完成后总结结果、证据、下一步和风险。"
                .to_string()
        } else {
            "Execution contract: follow this thread's permission, approval, and sandbox policy; finish with results, evidence, next steps, and risks."
                .to_string()
        },
    ];
    if let Some(note) = note.map(str::trim).filter(|note| !note.is_empty()) {
        parts.push(if is_zh {
            format!("运行备注：{note}")
        } else {
            format!("Run note: {note}")
        });
    }
    parts.join("\n\n")
}

fn create_automation_config(
    params: AutomationCreateParams,
) -> Result<JsonValue, JSONRPCErrorError> {
    let title = params.title.trim();
    if title.is_empty() {
        return Err(invalid_params("title must not be empty"));
    }
    if let Some(thread_id) = params.thread_id.as_deref()
        && thread_id.trim().is_empty()
    {
        return Err(invalid_params("threadId must not be empty"));
    }
    if let Some(target_office) = params.target_office.as_ref()
        && !target_office.is_object()
    {
        return Err(invalid_params("targetOffice must be an object"));
    }
    if let Some(execution_agent) = params.execution_agent.as_ref()
        && !execution_agent.is_object()
    {
        return Err(invalid_params("executionAgent must be an object"));
    }

    let target_office_name = params
        .target_office
        .as_ref()
        .and_then(display_name)
        .unwrap_or("No office")
        .to_string();
    let execution_agent_name = params
        .execution_agent
        .as_ref()
        .and_then(display_name)
        .unwrap_or("No agent")
        .to_string();
    let prompt = params.prompt.unwrap_or_else(|| {
        format!(
            "Run automation \"{title}\". Target office: {target_office_name}. Agent: {execution_agent_name}. Record results, next tasks, and risks."
        )
    });
    let enabled = params.enabled.unwrap_or(true);
    let status = params.status.unwrap_or_else(|| {
        if enabled {
            "enabled".to_string()
        } else {
            "disabled".to_string()
        }
    });
    let now = Utc::now().timestamp();
    let subtitle = format!("Manual trigger · {target_office_name} · {execution_agent_name}");
    let body = [
        "Trigger: manual".to_string(),
        format!("Target office: {target_office_name}"),
        format!("Agent: {execution_agent_name}"),
        format!("Status: {status}"),
        format!("Enabled: {enabled}"),
    ]
    .join("\n");
    let mut config = serde_json::json!({
        "title": title,
        "subtitle": subtitle,
        "body": body,
        "prompt": prompt,
        "trigger": { "type": "manual" },
        "targetOffice": params.target_office.unwrap_or(JsonValue::Null),
        "executionAgent": params.execution_agent.unwrap_or(JsonValue::Null),
        "enabled": enabled,
        "status": status,
        "createdAt": now,
        "updatedAt": now,
    });
    if let Some(thread_id) = params.thread_id {
        let Some(config_object) = config.as_object_mut() else {
            return Err(invalid_params("automation config must be an object"));
        };
        config_object.insert("threadId".to_string(), JsonValue::String(thread_id));
    }
    Ok(config)
}

fn display_name(config: &JsonValue) -> Option<&str> {
    config
        .get("title")
        .or_else(|| config.get("name"))
        .and_then(JsonValue::as_str)
}

fn create_office_config(params: OfficeCreateParams) -> Result<JsonValue, JSONRPCErrorError> {
    let title = params.title.trim();
    if title.is_empty() {
        return Err(invalid_params("title must not be empty"));
    }
    let subtitle = params
        .subtitle
        .as_deref()
        .map(str::trim)
        .filter(|subtitle| !subtitle.is_empty())
        .unwrap_or("Office workspace");
    let goal = params
        .goal
        .as_deref()
        .map(str::trim)
        .filter(|goal| !goal.is_empty())
        .unwrap_or(title);
    if let Some(thread_id) = params.thread_id.as_deref()
        && thread_id.trim().is_empty()
    {
        return Err(invalid_params("threadId must not be empty"));
    }

    let mut workspace = serde_json::json!({
        "goal": goal,
        "members": [],
        "messages": [],
        "tasks": [],
        "activity": {
            "approvals": [],
            "artifacts": []
        }
    });
    if let Some(thread_id) = params.thread_id {
        let Some(workspace_object) = workspace.as_object_mut() else {
            return Err(invalid_params("office workspace must be an object"));
        };
        workspace_object.insert(
            "threadId".to_string(),
            JsonValue::String(thread_id.trim().to_string()),
        );
    }

    Ok(serde_json::json!({
        "title": title,
        "subtitle": subtitle,
        "workspace": workspace
    }))
}

async fn update_automation_run(
    cwd: &str,
    file_path: &str,
    status: String,
    completed_at: Option<i64>,
) -> Result<AutomationRunUpdateResponse, JSONRPCErrorError> {
    if status.trim().is_empty() {
        return Err(invalid_params("status must not be empty"));
    }
    let file_path = validate_automation_run_file_path(cwd, file_path)?;
    let Some(mut record) = read_persisted_automation_run_record(&file_path).await? else {
        return Err(invalid_params("automation run file was not found"));
    };
    record.run.status = status;
    record.run.completed_at = completed_at;
    let run = record.run.clone();
    write_automation_run_record(&file_path, &record).await?;
    Ok(AutomationRunUpdateResponse {
        file_path: file_path.to_string_lossy().into_owned(),
        run,
    })
}

pub(crate) async fn sync_automation_runs_for_thread_turn(
    cwd: &str,
    thread_id: &str,
    turn: &Turn,
) -> Result<usize, JSONRPCErrorError> {
    if !automation_turn_status_is_terminal(&turn.status) {
        return Ok(0);
    }
    let directory = automation_runs_directory(cwd)?;
    let mut entries = match fs::read_dir(&directory).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(err) => {
            return Err(internal_error(format!(
                "failed to read {}: {err}",
                directory.display()
            )));
        }
    };
    let mut synced = 0;
    while let Some(entry) = entries.next_entry().await.map_err(map_io_error)? {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let Some(mut record) = read_persisted_automation_run_record(&path).await? else {
            continue;
        };
        if record.run.thread_id.as_deref() != Some(thread_id)
            || record.run.turn_id.as_deref() != Some(turn.id.as_str())
            || automation_run_status_is_terminal(&record.run.status)
        {
            continue;
        }
        record.run.status = automation_status_from_turn_status(&turn.status).to_string();
        record.run.completed_at = Some(turn.completed_at.unwrap_or_else(|| Utc::now().timestamp()));
        write_automation_run_record(&path, &record).await?;
        synced += 1;
    }
    Ok(synced)
}

fn automation_turn_status_is_terminal(status: &TurnStatus) -> bool {
    matches!(
        status,
        TurnStatus::Completed | TurnStatus::Failed | TurnStatus::Interrupted
    )
}

fn automation_run_status_is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "interrupted")
}

fn automation_status_from_turn_status(status: &TurnStatus) -> &'static str {
    match status {
        TurnStatus::Completed => "completed",
        TurnStatus::Failed => "failed",
        TurnStatus::Interrupted => "interrupted",
        TurnStatus::InProgress => "running",
    }
}

async fn list_automation_runs(
    cwd: &str,
    thread_id: Option<&str>,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<(Vec<CrewonAutomationRunConfigRecord>, Option<String>), JSONRPCErrorError> {
    let offset = parse_cursor(cursor)?;
    let limit = normalize_limit(limit);
    let directory = automation_runs_directory(cwd)?;
    let mut entries = match fs::read_dir(&directory).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok((Vec::new(), None)),
        Err(err) => {
            return Err(internal_error(format!(
                "failed to read {}: {err}",
                directory.display()
            )));
        }
    };

    let mut records = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(map_io_error)? {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let Some(record) = read_automation_run_config_record(&path).await? else {
            continue;
        };
        if thread_id.is_some_and(|thread_id| record.run.thread_id.as_deref() != Some(thread_id)) {
            continue;
        }
        records.push(record);
    }

    records.sort_by_key(|record| Reverse(record.saved_at));
    let next_cursor = if records.len() > offset + limit {
        Some((offset + limit).to_string())
    } else {
        None
    };
    let records = records.into_iter().skip(offset).take(limit).collect();
    Ok((records, next_cursor))
}

async fn read_automation_run_config_record(
    path: &Path,
) -> Result<Option<CrewonAutomationRunConfigRecord>, JSONRPCErrorError> {
    let Some(record) = read_persisted_automation_run_record(path).await? else {
        return Ok(None);
    };
    Ok(Some(CrewonAutomationRunConfigRecord {
        file_path: path.to_string_lossy().into_owned(),
        saved_at: record.saved_at.unwrap_or_default(),
        run: record.run,
    }))
}

async fn read_persisted_automation_run_record(
    path: &Path,
) -> Result<Option<PersistedAutomationRunRecord>, JSONRPCErrorError> {
    let bytes = match fs::read(path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(map_io_error(err)),
    };
    let record = match serde_json::from_slice::<PersistedAutomationRunRecord>(&bytes) {
        Ok(record) => record,
        Err(_) => return Ok(None),
    };
    if record.version != 1 {
        return Ok(None);
    }
    Ok(Some(record))
}

async fn write_automation_run_record(
    file_path: &Path,
    record: &PersistedAutomationRunRecord,
) -> Result<(), JSONRPCErrorError> {
    let mut bytes = serde_json::to_vec_pretty(record)
        .map_err(|err| internal_error(format!("failed to serialize automation run: {err}")))?;
    bytes.push(b'\n');
    fs::write(file_path, bytes).await.map_err(map_io_error)
}

fn ensure_agent_id(mut config: JsonValue) -> Result<(JsonValue, String), JSONRPCErrorError> {
    if !DomainKind::Agent.config_matches(&config) {
        return Err(invalid_params("agent config is missing required fields"));
    }
    let agent_id = config
        .get("agentId")
        .and_then(JsonValue::as_str)
        .filter(|agent_id| !agent_id.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            let title = DomainKind::Agent.title(&config).unwrap_or("agent");
            format!("agent-{}", slugify(title, "agent"))
        });
    let Some(config_object) = config.as_object_mut() else {
        return Err(invalid_params("agent config must be an object"));
    };
    config_object.insert("agentId".to_string(), JsonValue::String(agent_id.clone()));
    Ok((config, agent_id))
}

pub(super) async fn read_office_record(
    cwd: &str,
    thread_id: Option<&str>,
    title: Option<&str>,
) -> Result<Option<CrewonDomainConfigRecord>, JSONRPCErrorError> {
    if thread_id.is_none() && title.is_none() {
        return Err(invalid_params("threadId or title is required"));
    }
    let (records, _) = list_records(
        DomainKind::Office,
        cwd,
        /*cursor*/ None,
        Some(MAX_LIST_LIMIT as u32),
    )
    .await?;
    Ok(records.into_iter().find(|record| {
        thread_id.is_some_and(|thread_id| office_thread_id(&record.config) == Some(thread_id))
            || title.is_some_and(|title| {
                record.config.get("title").and_then(JsonValue::as_str) == Some(title)
            })
    }))
}

pub(super) async fn read_agent_record(
    cwd: &str,
    agent_id: Option<&str>,
    thread_id: Option<&str>,
    name: Option<&str>,
) -> Result<Option<CrewonDomainConfigRecord>, JSONRPCErrorError> {
    if agent_id.is_none() && thread_id.is_none() && name.is_none() {
        return Err(invalid_params("agentId, threadId, or name is required"));
    }
    let (records, _) = list_records(
        DomainKind::Agent,
        cwd,
        /*cursor*/ None,
        Some(MAX_LIST_LIMIT as u32),
    )
    .await?;
    Ok(records.into_iter().find(|record| {
        agent_id.is_some_and(|agent_id| {
            record.config.get("agentId").and_then(JsonValue::as_str) == Some(agent_id)
        }) || thread_id.is_some_and(|thread_id| {
            record.config.get("threadId").and_then(JsonValue::as_str) == Some(thread_id)
        }) || name
            .is_some_and(|name| record.config.get("name").and_then(JsonValue::as_str) == Some(name))
    }))
}

pub(super) async fn read_agent_record_by_file_path(
    cwd: &str,
    file_path: &str,
) -> Result<Option<CrewonDomainConfigRecord>, JSONRPCErrorError> {
    let file_path = validate_record_file_path(cwd, DomainKind::Agent, file_path)?;
    read_record(DomainKind::Agent, &file_path).await
}

pub(super) async fn read_office_record_by_file_path(
    cwd: &str,
    file_path: &str,
) -> Result<Option<CrewonDomainConfigRecord>, JSONRPCErrorError> {
    let file_path = validate_record_file_path(cwd, DomainKind::Office, file_path)?;
    read_record(DomainKind::Office, &file_path).await
}

async fn read_automation_record(
    cwd: &str,
    file_path: Option<&str>,
    thread_id: Option<&str>,
    title: Option<&str>,
) -> Result<Option<CrewonDomainConfigRecord>, JSONRPCErrorError> {
    if let Some(file_path) = file_path {
        let file_path = validate_record_file_path(cwd, DomainKind::Automation, file_path)?;
        return read_record(DomainKind::Automation, &file_path).await;
    }
    if thread_id.is_none() && title.is_none() {
        return Err(invalid_params("filePath, threadId, or title is required"));
    }
    let (records, _) = list_records(
        DomainKind::Automation,
        cwd,
        /*cursor*/ None,
        Some(MAX_LIST_LIMIT as u32),
    )
    .await?;
    Ok(records.into_iter().find(|record| {
        thread_id.is_some_and(|thread_id| {
            record.config.get("threadId").and_then(JsonValue::as_str) == Some(thread_id)
        }) || title.is_some_and(|title| {
            record.config.get("title").and_then(JsonValue::as_str) == Some(title)
        })
    }))
}

async fn list_recruitable_agents(
    cwd: &str,
    cursor: Option<String>,
    existing_agent_ids: Vec<String>,
    existing_names: Vec<String>,
    limit: Option<u32>,
) -> Result<(Vec<CrewonDomainConfigRecord>, Option<String>), JSONRPCErrorError> {
    let existing_agent_ids: HashSet<String> = existing_agent_ids
        .into_iter()
        .filter(|agent_id| !agent_id.trim().is_empty())
        .collect();
    let existing_names: HashSet<String> = existing_names
        .into_iter()
        .filter(|name| !name.trim().is_empty())
        .collect();

    list_records_matching(DomainKind::Agent, cwd, cursor, limit, |record| {
        let agent_id = record.config.get("agentId").and_then(JsonValue::as_str);
        let name = record.config.get("name").and_then(JsonValue::as_str);
        !agent_id.is_some_and(|agent_id| existing_agent_ids.contains(agent_id))
            && !name.is_some_and(|name| existing_names.contains(name))
    })
    .await
}

fn apply_office_message_update(
    mut config: JsonValue,
    message: JsonValue,
    text: Option<&str>,
    locale: Option<&str>,
    workspace_update: Option<JsonValue>,
) -> Result<JsonValue, JSONRPCErrorError> {
    if !DomainKind::Office.config_matches(&config) {
        return Err(invalid_params("office config is missing required fields"));
    }
    if !message.is_object() {
        return Err(invalid_params("message must be an object"));
    }

    if let Some(workspace_update) = workspace_update {
        if !workspace_update.is_object() {
            return Err(invalid_params("workspace must be an object"));
        }
        let Some(config_object) = config.as_object_mut() else {
            return Err(invalid_params("office config must be an object"));
        };
        config_object.insert("workspace".to_string(), workspace_update);
        return Ok(config);
    }

    let Some(workspace) = config
        .get_mut("workspace")
        .and_then(JsonValue::as_object_mut)
    else {
        return Err(invalid_params("office config is missing workspace"));
    };
    if let Some(text) = text {
        apply_office_text_message(workspace, message, text, locale)?;
        return Ok(config);
    }

    let messages = workspace
        .entry("messages")
        .or_insert_with(|| JsonValue::Array(Vec::new()));
    let Some(messages) = messages.as_array_mut() else {
        return Err(invalid_params("workspace.messages must be an array"));
    };
    messages.push(message);
    Ok(config)
}

fn apply_office_text_message(
    workspace: &mut serde_json::Map<String, JsonValue>,
    message: JsonValue,
    text: &str,
    locale: Option<&str>,
) -> Result<(), JSONRPCErrorError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(invalid_params("text must not be empty"));
    }
    let is_zh = locale != Some("en");
    let now = Utc::now().format("%H:%M").to_string();
    let reply = office_manager_reply_identity(workspace, is_zh);
    let reply_text = if text.contains('@') {
        if is_zh {
            "收到。我会先理解这条群聊信息，判断是否需要形成任务，再按需派发给合适成员。".to_string()
        } else {
            "Got it. I'll interpret this group-chat message first, decide whether it should become task work, then delegate to the right member if useful.".to_string()
        }
    } else if is_zh {
        "收到。我会先判断这是提问、补充背景还是新的可执行工作，再更新计划或派发任务。".to_string()
    } else {
        "Got it. I'll decide whether this is a question, context, or new actionable work before updating the plan or delegating tasks.".to_string()
    };

    let messages = workspace
        .entry("messages")
        .or_insert_with(|| JsonValue::Array(Vec::new()));
    let Some(messages) = messages.as_array_mut() else {
        return Err(invalid_params("workspace.messages must be an array"));
    };
    messages.push(message);
    messages.push(serde_json::json!({
        "author": reply.author,
        "glyph": reply.glyph,
        "accent": reply.accent,
        "time": now,
        "text": reply_text,
        "kind": "message"
    }));

    Ok(())
}

struct OfficeReplyIdentity {
    author: String,
    glyph: String,
    accent: String,
}

fn office_manager_reply_identity(
    workspace: &serde_json::Map<String, JsonValue>,
    is_zh: bool,
) -> OfficeReplyIdentity {
    let manager = workspace
        .get("members")
        .and_then(JsonValue::as_array)
        .and_then(|members| {
            members
                .iter()
                .find(|member| is_office_manager_member(member))
        });
    if let Some(manager) = manager {
        return OfficeReplyIdentity {
            author: manager
                .get("name")
                .and_then(JsonValue::as_str)
                .unwrap_or(if is_zh {
                    "主控智能体"
                } else {
                    "Manager agent"
                })
                .to_string(),
            glyph: manager
                .get("glyph")
                .and_then(JsonValue::as_str)
                .unwrap_or("M")
                .to_string(),
            accent: manager
                .get("accent")
                .and_then(JsonValue::as_str)
                .unwrap_or("indigo")
                .to_string(),
        };
    }
    OfficeReplyIdentity {
        author: if is_zh {
            "主控智能体"
        } else {
            "Manager agent"
        }
        .to_string(),
        glyph: "M".to_string(),
        accent: "indigo".to_string(),
    }
}

fn is_office_manager_member(member: &JsonValue) -> bool {
    let haystack = [
        member.get("name").and_then(JsonValue::as_str),
        member.get("role").and_then(JsonValue::as_str),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ")
    .to_ascii_lowercase();
    [
        "manager",
        "coordinator",
        "planner",
        "lead",
        "主控",
        "协调",
        "负责人",
        "规划",
    ]
    .iter()
    .any(|marker| haystack.contains(marker))
}

fn append_office_member(
    mut config: JsonValue,
    agent_id: &str,
    mut member: JsonValue,
    agent_config: Option<&JsonValue>,
) -> Result<JsonValue, JSONRPCErrorError> {
    if agent_id.trim().is_empty() {
        return Err(invalid_params("agentId must not be empty"));
    }
    if !DomainKind::Office.config_matches(&config) {
        return Err(invalid_params("office config is missing required fields"));
    }
    let Some(member_object) = member.as_object_mut() else {
        return Err(invalid_params("member must be an object"));
    };
    member_object.insert(
        "agentId".to_string(),
        JsonValue::String(agent_id.trim().to_string()),
    );
    if let Some(agent_config) = agent_config {
        merge_office_member_runtime(member_object, agent_config);
    }

    let Some(workspace) = config
        .get_mut("workspace")
        .and_then(JsonValue::as_object_mut)
    else {
        return Err(invalid_params("office config is missing workspace"));
    };
    let members = workspace
        .entry("members")
        .or_insert_with(|| JsonValue::Array(Vec::new()));
    let Some(members) = members.as_array_mut() else {
        return Err(invalid_params("workspace.members must be an array"));
    };
    members
        .retain(|existing| existing.get("agentId").and_then(JsonValue::as_str) != Some(agent_id));
    members.push(member);
    Ok(config)
}

async fn resolve_office_member_runtimes(
    cwd: &str,
    config: &mut JsonValue,
) -> Result<(), JSONRPCErrorError> {
    if !DomainKind::Office.config_matches(config) {
        return Err(invalid_params("office config is missing required fields"));
    }
    let Some(member_values) = config
        .get("workspace")
        .and_then(|workspace| workspace.get("members"))
        .and_then(JsonValue::as_array)
    else {
        return Ok(());
    };
    let mut agent_ids = Vec::new();
    for agent_id in member_values
        .iter()
        .filter_map(|member| member.get("agentId").and_then(JsonValue::as_str))
        .map(str::trim)
        .filter(|agent_id| !agent_id.is_empty())
    {
        if !agent_ids.iter().any(|existing| existing == agent_id) {
            agent_ids.push(agent_id.to_string());
        }
    }
    if agent_ids.is_empty() {
        return Ok(());
    }

    let (agent_records, _) = list_records(
        DomainKind::Agent,
        cwd,
        /*cursor*/ None,
        Some(MAX_LIST_LIMIT as u32),
    )
    .await?;
    if agent_records.is_empty() {
        return Ok(());
    }

    let Some(members) = config
        .get_mut("workspace")
        .and_then(|workspace| workspace.get_mut("members"))
        .and_then(JsonValue::as_array_mut)
    else {
        return Ok(());
    };
    for member in members {
        let Some(agent_id) = member
            .get("agentId")
            .and_then(JsonValue::as_str)
            .map(str::to_string)
        else {
            continue;
        };
        let Some(agent_record) = agent_records.iter().find(|record| {
            record.config.get("agentId").and_then(JsonValue::as_str) == Some(agent_id.as_str())
        }) else {
            continue;
        };
        if let Some(member_object) = member.as_object_mut() {
            merge_office_member_runtime(member_object, &agent_record.config);
        }
    }
    Ok(())
}

fn merge_office_member_runtime(
    member_object: &mut serde_json::Map<String, JsonValue>,
    agent_config: &JsonValue,
) {
    let fallback_thread_id = member_object
        .get("threadId")
        .and_then(JsonValue::as_str)
        .or_else(|| agent_config.get("threadId").and_then(JsonValue::as_str))
        .map(str::trim)
        .filter(|thread_id| !thread_id.is_empty())
        .map(str::to_string);
    let runtime = member_object
        .entry("runtime".to_string())
        .or_insert_with(|| JsonValue::Object(serde_json::Map::new()));
    if !runtime.is_object() {
        *runtime = JsonValue::Object(serde_json::Map::new());
    }
    let Some(runtime_object) = runtime.as_object_mut() else {
        return;
    };
    if !runtime_object.contains_key("threadId")
        && let Some(thread_id) = fallback_thread_id
    {
        runtime_object.insert("threadId".to_string(), JsonValue::String(thread_id));
    }
    runtime_object
        .entry("contextPolicy".to_string())
        .or_insert_with(|| JsonValue::String("sharedDigest".to_string()));
    runtime_object
        .entry("memoryScope".to_string())
        .or_insert_with(|| JsonValue::String("privateAndShared".to_string()));
    let has_agent_profile = runtime_object
        .get("agentProfile")
        .and_then(JsonValue::as_str)
        .is_some_and(|profile| !profile.trim().is_empty());
    if !has_agent_profile
        && let Some(agent_profile) = office_agent_profile::agent_profile_summary(agent_config)
    {
        runtime_object.insert("agentProfile".to_string(), JsonValue::String(agent_profile));
    }
}

fn decide_office_approval(
    mut config: JsonValue,
    approval_id: &str,
    decision: OfficeApprovalDecision,
    message: Option<JsonValue>,
) -> Result<JsonValue, JSONRPCErrorError> {
    let approval_id = approval_id.trim();
    if approval_id.is_empty() {
        return Err(invalid_params("approvalId must not be empty"));
    }
    if !DomainKind::Office.config_matches(&config) {
        return Err(invalid_params("office config is missing required fields"));
    }

    let Some(workspace) = config
        .get_mut("workspace")
        .and_then(JsonValue::as_object_mut)
    else {
        return Err(invalid_params("office config is missing workspace"));
    };
    let Some(activity) = workspace
        .get_mut("activity")
        .and_then(JsonValue::as_object_mut)
    else {
        return Err(invalid_params("workspace.activity is required"));
    };
    let Some(approvals) = activity
        .get_mut("approvals")
        .and_then(JsonValue::as_array_mut)
    else {
        return Err(invalid_params(
            "workspace.activity.approvals must be an array",
        ));
    };

    let decision = match decision {
        OfficeApprovalDecision::Approved => "approved",
        OfficeApprovalDecision::Denied => "denied",
    };
    let mut found = false;
    for approval in approvals {
        if approval.get("id").and_then(JsonValue::as_str) == Some(approval_id) {
            let Some(approval_object) = approval.as_object_mut() else {
                return Err(invalid_params("approval must be an object"));
            };
            approval_object.insert(
                "decision".to_string(),
                JsonValue::String(decision.to_string()),
            );
            found = true;
            break;
        }
    }
    if !found {
        return Err(invalid_params("approvalId was not found"));
    }

    if let Some(message) = message {
        if !message.is_object() {
            return Err(invalid_params("message must be an object"));
        }
        let messages = workspace
            .entry("messages")
            .or_insert_with(|| JsonValue::Array(Vec::new()));
        let Some(messages) = messages.as_array_mut() else {
            return Err(invalid_params("workspace.messages must be an array"));
        };
        messages.push(message);
    }

    Ok(config)
}

fn upsert_office_artifact(
    mut config: JsonValue,
    mut artifact: JsonValue,
    message: Option<JsonValue>,
) -> Result<JsonValue, JSONRPCErrorError> {
    if !DomainKind::Office.config_matches(&config) {
        return Err(invalid_params("office config is missing required fields"));
    }
    if !artifact.is_object() {
        return Err(invalid_params("artifact must be an object"));
    }
    let Some(artifact_title) = artifact
        .get("title")
        .and_then(JsonValue::as_str)
        .map(str::to_string)
    else {
        return Err(invalid_params("artifact.title is required"));
    };
    if artifact_title.trim().is_empty() {
        return Err(invalid_params("artifact.title must not be empty"));
    }
    apply_artifact_content_fingerprint(&mut artifact)?;

    let Some(workspace) = config
        .get_mut("workspace")
        .and_then(JsonValue::as_object_mut)
    else {
        return Err(invalid_params("office config is missing workspace"));
    };
    let Some(activity) = workspace
        .get_mut("activity")
        .and_then(JsonValue::as_object_mut)
    else {
        return Err(invalid_params("workspace.activity is required"));
    };
    let artifacts = activity
        .entry("artifacts")
        .or_insert_with(|| JsonValue::Array(Vec::new()));
    let Some(artifacts) = artifacts.as_array_mut() else {
        return Err(invalid_params(
            "workspace.activity.artifacts must be an array",
        ));
    };
    artifacts.retain(|existing| {
        existing.get("title").and_then(JsonValue::as_str) != Some(artifact_title.as_str())
    });
    artifacts.insert(0, artifact);

    if let Some(message) = message {
        if !message.is_object() {
            return Err(invalid_params("message must be an object"));
        }
        let messages = workspace
            .entry("messages")
            .or_insert_with(|| JsonValue::Array(Vec::new()));
        let Some(messages) = messages.as_array_mut() else {
            return Err(invalid_params("workspace.messages must be an array"));
        };
        messages.push(message);
    }

    Ok(config)
}

fn apply_artifact_content_fingerprint(artifact: &mut JsonValue) -> Result<(), JSONRPCErrorError> {
    for key in ["content", "body", "text"] {
        if artifact.get(key).is_some_and(|value| !value.is_string()) {
            return Err(invalid_params(
                "artifact inline content fields must be strings",
            ));
        }
    }

    let Some((content_sha256, content_bytes)) = ["content", "body", "text"]
        .into_iter()
        .find_map(|key| artifact.get(key).and_then(JsonValue::as_str))
        .map(|content| {
            let bytes = content.as_bytes();
            (sha256_hex(bytes), bytes.len())
        })
    else {
        return Ok(());
    };
    set_artifact_content_observation(
        artifact,
        OFFICE_ARTIFACT_CONTENT_SOURCE_INLINE,
        OFFICE_ARTIFACT_CONTENT_STATUS_FINGERPRINTED,
        Some(content_sha256),
        Some(content_bytes as u64),
        /*error*/ None,
    );
    if let Some(artifact) = artifact.as_object_mut() {
        for key in ["content", "body", "text"] {
            artifact.remove(key);
        }
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{digest:x}")
}

struct OfficeArtifactFileObservation {
    status: &'static str,
    content_sha256: Option<String>,
    content_bytes: Option<u64>,
    error: Option<String>,
}

fn set_artifact_content_observation(
    artifact: &mut JsonValue,
    source: &str,
    status: &str,
    content_sha256: Option<String>,
    content_bytes: Option<u64>,
    error: Option<String>,
) {
    if let Some(artifact) = artifact.as_object_mut() {
        artifact.remove("contentSha256");
        artifact.remove("contentBytes");
        artifact.remove("contentError");
    }

    artifact["contentSource"] = JsonValue::String(source.to_string());
    artifact["contentStatus"] = JsonValue::String(status.to_string());
    artifact["contentObservedAt"] =
        JsonValue::String(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
    if let Some(content_sha256) = content_sha256 {
        artifact["contentSha256"] = JsonValue::String(content_sha256);
    }
    if let Some(content_bytes) = content_bytes {
        artifact["contentBytes"] = JsonValue::Number(content_bytes.into());
    }
    if let Some(error) = error {
        artifact["contentError"] = JsonValue::String(error);
    }
}

fn office_artifact_content_error(message: String) -> String {
    let mut truncated = String::new();
    for (index, ch) in message.chars().enumerate() {
        if index >= MAX_OFFICE_ARTIFACT_CONTENT_ERROR_CHARS {
            truncated.push_str("...");
            return truncated;
        }
        truncated.push(ch);
    }
    truncated
}

pub(super) async fn apply_office_artifact_file_fingerprints(
    cwd: &str,
    config: &mut JsonValue,
) -> Result<(), JSONRPCErrorError> {
    let Some(artifacts) = config
        .get_mut("workspace")
        .and_then(|workspace| workspace.get_mut("activity"))
        .and_then(|activity| activity.get_mut("artifacts"))
        .and_then(JsonValue::as_array_mut)
    else {
        return Ok(());
    };
    let Ok(canonical_cwd) = fs::canonicalize(Path::new(cwd)).await else {
        return Ok(());
    };
    for artifact in artifacts.iter_mut().take(MAX_OFFICE_ARTIFACT_FINGERPRINTS) {
        let Some(path) = artifact
            .get("path")
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
        else {
            continue;
        };

        if artifact.get("contentSource").and_then(JsonValue::as_str)
            == Some(OFFICE_ARTIFACT_CONTENT_SOURCE_INLINE)
            && artifact.get("contentSha256").is_some()
        {
            continue;
        }

        let observation = office_artifact_file_fingerprint(&canonical_cwd, path).await;
        set_artifact_content_observation(
            artifact,
            OFFICE_ARTIFACT_CONTENT_SOURCE_FILE,
            observation.status,
            observation.content_sha256,
            observation.content_bytes,
            observation.error,
        );
    }
    Ok(())
}

async fn office_artifact_file_fingerprint(
    canonical_cwd: &Path,
    path: &str,
) -> OfficeArtifactFileObservation {
    let candidate = office_artifact_candidate_path(canonical_cwd, path);
    let canonical_path = match fs::canonicalize(candidate).await {
        Ok(canonical_path) => canonical_path,
        Err(err) => {
            let status = if err.kind() == io::ErrorKind::NotFound {
                OFFICE_ARTIFACT_CONTENT_STATUS_MISSING
            } else {
                OFFICE_ARTIFACT_CONTENT_STATUS_UNREADABLE
            };
            return OfficeArtifactFileObservation {
                status,
                content_sha256: None,
                content_bytes: None,
                error: Some(office_artifact_content_error(format!(
                    "canonicalize failed: {err}"
                ))),
            };
        }
    };
    if !canonical_path.starts_with(canonical_cwd) {
        return OfficeArtifactFileObservation {
            status: OFFICE_ARTIFACT_CONTENT_STATUS_OUTSIDE_WORKSPACE,
            content_sha256: None,
            content_bytes: None,
            error: Some("path resolves outside the workspace".to_string()),
        };
    }
    let metadata = match fs::metadata(&canonical_path).await {
        Ok(metadata) => metadata,
        Err(err) => {
            return OfficeArtifactFileObservation {
                status: OFFICE_ARTIFACT_CONTENT_STATUS_UNREADABLE,
                content_sha256: None,
                content_bytes: None,
                error: Some(office_artifact_content_error(format!(
                    "metadata failed: {err}"
                ))),
            };
        }
    };
    if !metadata.is_file() {
        return OfficeArtifactFileObservation {
            status: OFFICE_ARTIFACT_CONTENT_STATUS_NOT_FILE,
            content_sha256: None,
            content_bytes: None,
            error: Some("path is not a regular file".to_string()),
        };
    }
    if metadata.len() > MAX_OFFICE_ARTIFACT_FINGERPRINT_BYTES {
        return OfficeArtifactFileObservation {
            status: OFFICE_ARTIFACT_CONTENT_STATUS_TOO_LARGE,
            content_sha256: None,
            content_bytes: None,
            error: Some(format!(
                "file is {} bytes; fingerprint limit is {} bytes",
                metadata.len(),
                MAX_OFFICE_ARTIFACT_FINGERPRINT_BYTES
            )),
        };
    }
    let mut file = match fs::File::open(&canonical_path).await {
        Ok(file) => file,
        Err(err) => {
            return OfficeArtifactFileObservation {
                status: OFFICE_ARTIFACT_CONTENT_STATUS_UNREADABLE,
                content_sha256: None,
                content_bytes: None,
                error: Some(office_artifact_content_error(format!("open failed: {err}"))),
            };
        }
    };
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; OFFICE_ARTIFACT_FINGERPRINT_CHUNK_BYTES];
    loop {
        let read = match file.read(&mut buffer).await {
            Ok(read) => read,
            Err(err) => {
                return OfficeArtifactFileObservation {
                    status: OFFICE_ARTIFACT_CONTENT_STATUS_UNREADABLE,
                    content_sha256: None,
                    content_bytes: None,
                    error: Some(office_artifact_content_error(format!("read failed: {err}"))),
                };
            }
        };
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    OfficeArtifactFileObservation {
        status: OFFICE_ARTIFACT_CONTENT_STATUS_FINGERPRINTED,
        content_sha256: Some(format!("{:x}", hasher.finalize())),
        content_bytes: Some(metadata.len()),
        error: None,
    }
}

fn office_artifact_candidate_path(canonical_cwd: &Path, path: &str) -> PathBuf {
    let path = Path::new(path);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        canonical_cwd.join(path)
    }
}

fn office_thread_id(config: &JsonValue) -> Option<&str> {
    config
        .get("workspace")
        .and_then(|workspace| workspace.get("threadId"))
        .and_then(JsonValue::as_str)
}

async fn delete_record(
    kind: DomainKind,
    cwd: &str,
    file_path: &str,
) -> Result<bool, JSONRPCErrorError> {
    let file_path = validate_record_file_path(cwd, kind, file_path)?;
    if !fs::try_exists(&file_path).await.map_err(map_io_error)? {
        return Ok(false);
    }

    match read_record(kind, &file_path).await? {
        Some(_) => {
            fs::remove_file(file_path).await.map_err(map_io_error)?;
            Ok(true)
        }
        None => Err(invalid_params(format!(
            "{} config file does not match the requested kind",
            kind.record_kind()
        ))),
    }
}

fn domain_directory(cwd: &str, kind: DomainKind) -> Result<PathBuf, JSONRPCErrorError> {
    if cwd.trim().is_empty() {
        return Err(invalid_params("cwd must not be empty"));
    }

    let cwd = PathBuf::from(cwd);
    if !cwd.is_absolute() {
        return Err(invalid_params("cwd must be an absolute path"));
    }

    Ok(cwd.join(".crewon").join(kind.directory_name()))
}

fn automation_runs_directory(cwd: &str) -> Result<PathBuf, JSONRPCErrorError> {
    if cwd.trim().is_empty() {
        return Err(invalid_params("cwd must not be empty"));
    }

    let cwd = PathBuf::from(cwd);
    if !cwd.is_absolute() {
        return Err(invalid_params("cwd must be an absolute path"));
    }

    Ok(cwd.join(".crewon").join(AUTOMATION_RUNS_DIRECTORY))
}

fn validate_automation_run_file_path(
    cwd: &str,
    file_path: &str,
) -> Result<PathBuf, JSONRPCErrorError> {
    let directory = automation_runs_directory(cwd)?;
    let file_path = PathBuf::from(file_path);
    if !file_path.is_absolute() {
        return Err(invalid_params("filePath must be an absolute path"));
    }
    if file_path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(invalid_params("filePath must not contain parent segments"));
    }
    if file_path
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("json")
    {
        return Err(invalid_params("filePath must point to a JSON run file"));
    }
    if !file_path.starts_with(&directory) {
        return Err(invalid_params(format!(
            "filePath must be inside {}",
            directory.display()
        )));
    }

    Ok(file_path)
}

fn validate_record_file_path(
    cwd: &str,
    kind: DomainKind,
    file_path: &str,
) -> Result<PathBuf, JSONRPCErrorError> {
    let directory = domain_directory(cwd, kind)?;
    let file_path = PathBuf::from(file_path);
    if !file_path.is_absolute() {
        return Err(invalid_params("filePath must be an absolute path"));
    }
    if file_path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(invalid_params("filePath must not contain parent segments"));
    }
    if file_path
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("json")
    {
        return Err(invalid_params("filePath must point to a JSON config file"));
    }
    if !file_path.starts_with(&directory) {
        return Err(invalid_params(format!(
            "filePath must be inside {}",
            directory.display()
        )));
    }

    Ok(file_path)
}

fn normalize_limit(limit: Option<u32>) -> usize {
    limit
        .and_then(|limit| usize::try_from(limit).ok())
        .filter(|limit| *limit > 0)
        .map(|limit| limit.min(MAX_LIST_LIMIT))
        .unwrap_or(MAX_CONFIG_RECORDS)
}

fn parse_cursor(cursor: Option<String>) -> Result<usize, JSONRPCErrorError> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    cursor
        .parse::<usize>()
        .map_err(|err| invalid_params(format!("invalid cursor: {err}")))
}

fn domain_file_name(kind: DomainKind, config: &JsonValue) -> String {
    let title = kind.title(config).unwrap_or_else(|| kind.record_kind());
    let suffix = kind
        .thread_id(config)
        .map(|thread_id| match kind {
            DomainKind::Workflow => thread_id.to_string(),
            DomainKind::Agent | DomainKind::Office | DomainKind::Automation | DomainKind::Tool => {
                thread_id.chars().take(8).collect::<String>()
            }
        })
        .filter(|thread_id| !thread_id.is_empty())
        .unwrap_or_else(|| Utc::now().timestamp_millis().to_string());
    let stem = slugify(title, kind.record_kind());
    let suffix = slugify(&suffix, &suffix);
    format!("{stem}-{suffix}.json")
}

fn tool_kind(config: &JsonValue) -> Option<ToolConfigKind> {
    match config.get("kind").and_then(JsonValue::as_str) {
        Some("mcp") => Some(ToolConfigKind::Mcp),
        Some("skill") => Some(ToolConfigKind::Skill),
        _ => None,
    }
}

fn tool_identity(config: &JsonValue) -> Option<&str> {
    config
        .get("id")
        .or_else(|| config.get("name"))
        .and_then(JsonValue::as_str)
}

fn slugify(value: &str, fallback: &str) -> String {
    let mut slug = String::new();
    let mut needs_dash = false;
    for ch in value.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            if needs_dash && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(ch);
            needs_dash = false;
        } else {
            needs_dash = true;
        }
    }

    if slug.is_empty() {
        fallback.to_string()
    } else {
        slug
    }
}

fn map_io_error(err: io::Error) -> JSONRPCErrorError {
    internal_error(err.to_string())
}

#[cfg(test)]
#[path = "crewon_domain_processor_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "crewon_domain_office_terminal_sync_tests.rs"]
mod office_terminal_sync_tests;
