use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::PathBuf;

use chrono::Utc;
use crewon_app_server_protocol::JSONRPCErrorError;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;
use sha2::Digest as _;
use sha2::Sha256;
use tokio::fs;

use super::DomainKind;
use super::domain_directory;
use super::map_io_error;
use super::office_authority_lock;
use super::office_runtime_owner_reconciliation;
use super::office_runtime_owner_registry_config;
use super::office_runtime_owner_registry_store;
use crate::error_code::internal_error;
use crate::error_code::invalid_params;
use crate::office_runtime_contract::MAX_OFFICE_RUNTIME_ID_CHARS;

pub(super) const REGISTRY_VERSION: u32 = 1;
const REGISTRY_FILE_NAME: &str = ".runtime-owners.state";
const MAX_REGISTRY_ENTRIES: usize = 1_024;
const MAX_RUNTIME_REFERENCES_PER_CONFIG: usize = 4_096;

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RuntimeOwnerRegistry {
    pub(super) version: u32,
    #[serde(default)]
    pub(super) bootstrap_complete: bool,
    #[serde(default)]
    pub(super) quarantined_unreadable_records: bool,
    pub(super) entries: BTreeMap<String, RuntimeOwner>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RuntimeOwner {
    record_id: String,
    #[serde(default)]
    member_id: Option<String>,
    agent_id: String,
    #[serde(default)]
    kind: RuntimeOwnerKind,
    state: RuntimeOwnerState,
    source_thread_id: String,
    updated_at: i64,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum RuntimeOwnerKind {
    #[default]
    Member,
    Automation,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum RuntimeOwnerState {
    Pending,
    Active,
}

#[derive(Clone, Debug)]
pub(super) struct PendingRuntimeOwnerClaim {
    runtime_thread_id: String,
    record_id: String,
    member_id: Option<String>,
    agent_id: String,
    kind: RuntimeOwnerKind,
    source_thread_id: String,
    created: bool,
}

pub(crate) struct OfficeAutomationRuntimeOwnerClaim {
    inner: PendingRuntimeOwnerClaim,
}

pub(super) struct OfficeRuntimeOwnerRegistryGuard<'a> {
    _authority_guard: &'a office_authority_lock::OfficeAuthorityGuard,
    registry_path: PathBuf,
    registry: RuntimeOwnerRegistry,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum OfficeRuntimeOwnerReconciliation {
    Complete,
    QuarantinedUnreadableRecords,
}

pub(super) async fn load<'a>(
    cwd: &str,
    authority_guard: &'a office_authority_lock::OfficeAuthorityGuard,
) -> Result<OfficeRuntimeOwnerRegistryGuard<'a>, JSONRPCErrorError> {
    let directory = domain_directory(cwd, DomainKind::Office)?;
    let registry_path = directory.join(REGISTRY_FILE_NAME);
    let registry = office_runtime_owner_registry_store::read(&registry_path).await?;
    Ok(OfficeRuntimeOwnerRegistryGuard {
        _authority_guard: authority_guard,
        registry_path,
        registry,
    })
}

pub(crate) async fn runtime_thread_has_owner(
    cwd: &str,
    runtime_thread_id: &str,
) -> Result<bool, JSONRPCErrorError> {
    let directory = domain_directory(cwd, DomainKind::Office)?;
    if !fs::try_exists(&directory).await.map_err(map_io_error)? {
        return Ok(false);
    }
    let authority_guard = office_authority_lock::lock(cwd).await?;
    let runtime_owners = load(cwd, &authority_guard).await?;
    Ok(runtime_owners.owns_runtime_thread(runtime_thread_id))
}

pub(crate) async fn claim_automation_runtime(
    cwd: &str,
    runtime_thread_id: &str,
    automation_owner_key: &str,
    source_thread_id: &str,
) -> Result<OfficeAutomationRuntimeOwnerClaim, JSONRPCErrorError> {
    let directory = domain_directory(cwd, DomainKind::Office)?;
    let authority_guard = office_authority_lock::lock(cwd).await?;
    let mut runtime_owners = load(cwd, &authority_guard).await?;
    office_runtime_owner_reconciliation::reconcile_if_needed(&directory, &mut runtime_owners)
        .await?;
    let inner = runtime_owners
        .claim_automation_pending(runtime_thread_id, automation_owner_key, source_thread_id)
        .await?;
    Ok(OfficeAutomationRuntimeOwnerClaim { inner })
}

pub(crate) async fn automation_runtime_has_owner(
    cwd: &str,
    runtime_thread_id: &str,
    automation_owner_key: &str,
    source_thread_id: &str,
) -> Result<bool, JSONRPCErrorError> {
    let directory = domain_directory(cwd, DomainKind::Office)?;
    if !fs::try_exists(&directory).await.map_err(map_io_error)? {
        return Ok(false);
    }
    let authority_guard = office_authority_lock::lock(cwd).await?;
    let runtime_owners = load(cwd, &authority_guard).await?;
    Ok(runtime_owners.owns_automation_runtime(
        runtime_thread_id,
        automation_owner_key,
        source_thread_id,
    ))
}

pub(crate) async fn activate_automation_runtime(
    cwd: &str,
    claim: &OfficeAutomationRuntimeOwnerClaim,
) -> Result<(), JSONRPCErrorError> {
    let authority_guard = office_authority_lock::lock(cwd).await?;
    let mut runtime_owners = load(cwd, &authority_guard).await?;
    runtime_owners.activate(&claim.inner).await
}

pub(crate) async fn remove_pending_automation_runtime(
    cwd: &str,
    claim: &OfficeAutomationRuntimeOwnerClaim,
) -> Result<(), JSONRPCErrorError> {
    let authority_guard = office_authority_lock::lock(cwd).await?;
    let mut runtime_owners = load(cwd, &authority_guard).await?;
    runtime_owners.remove_pending(&claim.inner).await
}

impl OfficeRuntimeOwnerRegistryGuard<'_> {
    pub(super) fn needs_reconciliation(&self) -> bool {
        !self.registry.bootstrap_complete
            || self.registry.quarantined_unreadable_records
            || self.registry.entries.values().any(|owner| {
                owner.kind == RuntimeOwnerKind::Member && owner.state == RuntimeOwnerState::Pending
            })
    }

    pub(super) fn owns_runtime_thread(&self, runtime_thread_id: &str) -> bool {
        self.registry.entries.contains_key(runtime_thread_id)
    }

    pub(super) fn owns_automation_runtime(
        &self,
        runtime_thread_id: &str,
        automation_owner_key: &str,
        source_thread_id: &str,
    ) -> bool {
        let record_id = automation_owner_record_id(automation_owner_key);
        self.registry
            .entries
            .get(runtime_thread_id)
            .is_some_and(|owner| {
                owner.kind == RuntimeOwnerKind::Automation
                    && owner.record_id == record_id
                    && owner.agent_id == "automation"
                    && owner.source_thread_id == source_thread_id
            })
    }

    pub(super) fn validate_config(&self, config: &JsonValue) -> Result<(), JSONRPCErrorError> {
        if self.registry.entries.is_empty() {
            return Ok(());
        }
        let record_id = config_record_id(config);
        let Some(workspace) = config.get("workspace") else {
            return Ok(());
        };
        let mut visited = 0usize;
        validate_runtime_reference(
            &self.registry,
            record_id,
            None,
            None,
            text(workspace, "threadId"),
            &mut visited,
        )?;

        let mut member_agents = HashMap::<String, Option<String>>::new();
        let mut agent_members = HashMap::<String, Option<String>>::new();
        let mut named_members = HashMap::<String, Option<String>>::new();
        if let Some(members) = workspace.get("members").and_then(JsonValue::as_array) {
            for member in members {
                visit_reference(&mut visited)?;
                let agent_id = text(member, "agentId");
                let member_id = text(member, "memberId");
                if let Some(agent_id) = agent_id {
                    insert_unique_identity(&mut agent_members, agent_id, member_id);
                }
                if let Some(member_name) = text(member, "name").or_else(|| text(member, "member")) {
                    match member_agents.entry(member_name.to_string()) {
                        std::collections::hash_map::Entry::Vacant(entry) => {
                            entry.insert(agent_id.map(str::to_string));
                        }
                        std::collections::hash_map::Entry::Occupied(mut entry) => {
                            entry.insert(None);
                        }
                    }
                    insert_unique_identity(&mut named_members, member_name, member_id);
                }
                validate_runtime_reference(
                    &self.registry,
                    record_id,
                    member_id,
                    agent_id,
                    text(member, "threadId"),
                    &mut visited,
                )?;
                validate_runtime_reference(
                    &self.registry,
                    record_id,
                    member_id,
                    agent_id,
                    member
                        .get("runtime")
                        .and_then(|runtime| text(runtime, "threadId")),
                    &mut visited,
                )?;
            }
        }

        let Some(runs) = workspace
            .get("activity")
            .and_then(|activity| activity.get("runs"))
            .and_then(JsonValue::as_array)
        else {
            return Ok(());
        };
        for run in runs {
            if let Some(routes) = run.get("delegationRoutes").and_then(JsonValue::as_array) {
                for route in routes {
                    visit_reference(&mut visited)?;
                    if !matches!(text(route, "targetKind"), None | Some("runtimeThread")) {
                        continue;
                    }
                    let agent_id = row_agent_id(route, &member_agents);
                    let member_id = row_member_id(route, &agent_members, &named_members);
                    validate_runtime_reference(
                        &self.registry,
                        record_id,
                        member_id,
                        agent_id,
                        text(route, "threadId"),
                        &mut visited,
                    )?;
                    validate_runtime_reference(
                        &self.registry,
                        record_id,
                        member_id,
                        agent_id,
                        text(route, "target"),
                        &mut visited,
                    )?;
                }
            }
            if let Some(delegations) = run.get("delegations").and_then(JsonValue::as_array) {
                for delegation in delegations {
                    visit_reference(&mut visited)?;
                    validate_runtime_reference(
                        &self.registry,
                        record_id,
                        row_member_id(delegation, &agent_members, &named_members),
                        row_agent_id(delegation, &member_agents),
                        text(delegation, "threadId"),
                        &mut visited,
                    )?;
                }
            }
        }
        Ok(())
    }

    pub(super) async fn register_persisted_repairs(
        &mut self,
        config: &JsonValue,
    ) -> Result<(), JSONRPCErrorError> {
        let bindings = office_runtime_owner_registry_config::persisted_repair_bindings(config)?;
        if bindings.is_empty() {
            return Ok(());
        }
        let now = Utc::now().timestamp();
        let mut changed = false;
        for binding in bindings {
            match self.registry.entries.get_mut(&binding.runtime_thread_id) {
                Some(owner)
                    if owner.record_id == binding.record_id
                        && owner.member_id == binding.member_id
                        && owner.agent_id == binding.agent_id
                        && owner.kind == RuntimeOwnerKind::Member
                        && owner.source_thread_id == binding.source_thread_id =>
                {
                    if owner.state == RuntimeOwnerState::Pending {
                        owner.state = RuntimeOwnerState::Active;
                        owner.updated_at = now;
                        changed = true;
                    }
                }
                Some(owner) => {
                    return Err(owner_conflict_error(
                        &binding.runtime_thread_id,
                        owner,
                        &binding.record_id,
                        &binding.agent_id,
                    ));
                }
                None => {
                    ensure_registry_capacity(&self.registry)?;
                    self.registry.entries.insert(
                        binding.runtime_thread_id,
                        RuntimeOwner {
                            record_id: binding.record_id,
                            member_id: binding.member_id,
                            agent_id: binding.agent_id,
                            kind: RuntimeOwnerKind::Member,
                            state: RuntimeOwnerState::Active,
                            source_thread_id: binding.source_thread_id,
                            updated_at: now,
                        },
                    );
                    changed = true;
                }
            }
        }
        if changed {
            self.persist().await?;
        }
        Ok(())
    }

    pub(super) async fn reconcile_persisted_configs<'a>(
        &mut self,
        configs: impl IntoIterator<Item = &'a JsonValue>,
        reconciliation: OfficeRuntimeOwnerReconciliation,
    ) -> Result<(), JSONRPCErrorError> {
        let mut observed = BTreeMap::new();
        for config in configs {
            for binding in office_runtime_owner_registry_config::persisted_repair_bindings(config)?
            {
                if observed
                    .insert(binding.runtime_thread_id.clone(), binding)
                    .is_some()
                {
                    return Err(invalid_params(
                        "multiple persisted Office repairs reference the same runtime thread",
                    ));
                }
            }
        }

        let now = Utc::now().timestamp();
        let mut changed = match reconciliation {
            OfficeRuntimeOwnerReconciliation::Complete => {
                !self.registry.bootstrap_complete || self.registry.quarantined_unreadable_records
            }
            OfficeRuntimeOwnerReconciliation::QuarantinedUnreadableRecords => {
                !self.registry.quarantined_unreadable_records
            }
        };
        for (runtime_thread_id, binding) in &observed {
            match self.registry.entries.get_mut(runtime_thread_id) {
                Some(owner)
                    if owner.record_id == binding.record_id
                        && owner.member_id == binding.member_id
                        && owner.agent_id == binding.agent_id
                        && owner.kind == RuntimeOwnerKind::Member
                        && owner.source_thread_id == binding.source_thread_id =>
                {
                    if owner.state == RuntimeOwnerState::Pending {
                        owner.state = RuntimeOwnerState::Active;
                        owner.updated_at = now;
                        changed = true;
                    }
                }
                Some(owner) => {
                    return Err(owner_conflict_error(
                        runtime_thread_id,
                        owner,
                        &binding.record_id,
                        &binding.agent_id,
                    ));
                }
                None => {
                    ensure_registry_capacity(&self.registry)?;
                    self.registry.entries.insert(
                        runtime_thread_id.clone(),
                        RuntimeOwner {
                            record_id: binding.record_id.clone(),
                            member_id: binding.member_id.clone(),
                            agent_id: binding.agent_id.clone(),
                            kind: RuntimeOwnerKind::Member,
                            state: RuntimeOwnerState::Active,
                            source_thread_id: binding.source_thread_id.clone(),
                            updated_at: now,
                        },
                    );
                    changed = true;
                }
            }
        }
        if reconciliation == OfficeRuntimeOwnerReconciliation::Complete {
            let stale_pending = self
                .registry
                .entries
                .iter()
                .filter(|&(runtime_thread_id, owner)| {
                    owner.kind == RuntimeOwnerKind::Member
                        && owner.state == RuntimeOwnerState::Pending
                        && !observed.contains_key(runtime_thread_id)
                })
                .map(|(runtime_thread_id, _owner)| runtime_thread_id.clone())
                .collect::<Vec<_>>();
            for runtime_thread_id in stale_pending {
                self.registry.entries.remove(&runtime_thread_id);
                changed = true;
            }
            self.registry.bootstrap_complete = true;
            self.registry.quarantined_unreadable_records = false;
        } else {
            self.registry.quarantined_unreadable_records = true;
        }
        if changed {
            self.persist().await?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) async fn claim_pending(
        &mut self,
        runtime_thread_id: &str,
        record_id: &str,
        agent_id: &str,
        source_thread_id: &str,
    ) -> Result<PendingRuntimeOwnerClaim, JSONRPCErrorError> {
        self.claim_pending_with_kind(
            runtime_thread_id,
            record_id,
            None,
            agent_id,
            source_thread_id,
            RuntimeOwnerKind::Member,
        )
        .await
    }

    pub(super) async fn claim_member_pending(
        &mut self,
        runtime_thread_id: &str,
        record_id: &str,
        member_id: Option<&str>,
        agent_id: &str,
        source_thread_id: &str,
    ) -> Result<PendingRuntimeOwnerClaim, JSONRPCErrorError> {
        self.claim_pending_with_kind(
            runtime_thread_id,
            record_id,
            member_id,
            agent_id,
            source_thread_id,
            RuntimeOwnerKind::Member,
        )
        .await
    }

    pub(super) async fn claim_automation_pending(
        &mut self,
        runtime_thread_id: &str,
        automation_owner_key: &str,
        source_thread_id: &str,
    ) -> Result<PendingRuntimeOwnerClaim, JSONRPCErrorError> {
        let record_id = automation_owner_record_id(automation_owner_key);
        self.claim_pending_with_kind(
            runtime_thread_id,
            &record_id,
            None,
            "automation",
            source_thread_id,
            RuntimeOwnerKind::Automation,
        )
        .await
    }

    async fn claim_pending_with_kind(
        &mut self,
        runtime_thread_id: &str,
        record_id: &str,
        member_id: Option<&str>,
        agent_id: &str,
        source_thread_id: &str,
        kind: RuntimeOwnerKind,
    ) -> Result<PendingRuntimeOwnerClaim, JSONRPCErrorError> {
        if self.registry.quarantined_unreadable_records {
            return Err(internal_error(
                "Office runtime owner claims are disabled while unreadable Office records are quarantined",
            ));
        }
        validate_owner_id("runtime thread id", runtime_thread_id)?;
        validate_owner_id("record id", record_id)?;
        if let Some(member_id) = member_id {
            validate_owner_id("member id", member_id)?;
        }
        validate_owner_id("agent id", agent_id)?;
        validate_owner_id("repair source thread id", source_thread_id)?;
        let requested = RuntimeOwner {
            record_id: record_id.to_string(),
            member_id: member_id.map(str::to_string),
            agent_id: agent_id.to_string(),
            kind,
            state: RuntimeOwnerState::Pending,
            source_thread_id: source_thread_id.to_string(),
            updated_at: Utc::now().timestamp(),
        };
        let created = match self.registry.entries.get(runtime_thread_id) {
            Some(owner) if owner_identity_matches(owner, &requested) => false,
            Some(owner) => {
                return Err(owner_conflict_error(
                    runtime_thread_id,
                    owner,
                    record_id,
                    agent_id,
                ));
            }
            None => {
                ensure_registry_capacity(&self.registry)?;
                self.registry
                    .entries
                    .insert(runtime_thread_id.to_string(), requested);
                self.persist().await?;
                true
            }
        };
        Ok(PendingRuntimeOwnerClaim {
            runtime_thread_id: runtime_thread_id.to_string(),
            record_id: record_id.to_string(),
            member_id: member_id.map(str::to_string),
            agent_id: agent_id.to_string(),
            kind,
            source_thread_id: source_thread_id.to_string(),
            created,
        })
    }

    pub(super) async fn activate(
        &mut self,
        claim: &PendingRuntimeOwnerClaim,
    ) -> Result<(), JSONRPCErrorError> {
        let owner = self
            .registry
            .entries
            .get_mut(&claim.runtime_thread_id)
            .ok_or_else(|| {
                internal_error("Office runtime owner claim disappeared before activation")
            })?;
        if !claim.matches(owner) {
            return Err(owner_conflict_error(
                &claim.runtime_thread_id,
                owner,
                &claim.record_id,
                &claim.agent_id,
            ));
        }
        if owner.state == RuntimeOwnerState::Active {
            return Ok(());
        }
        owner.state = RuntimeOwnerState::Active;
        owner.updated_at = Utc::now().timestamp();
        self.persist().await
    }

    pub(super) async fn remove_pending(
        &mut self,
        claim: &PendingRuntimeOwnerClaim,
    ) -> Result<(), JSONRPCErrorError> {
        if !claim.created {
            return Ok(());
        }
        let should_remove = self
            .registry
            .entries
            .get(&claim.runtime_thread_id)
            .is_some_and(|owner| owner.state == RuntimeOwnerState::Pending && claim.matches(owner));
        if !should_remove {
            return Ok(());
        }
        self.registry.entries.remove(&claim.runtime_thread_id);
        self.persist().await
    }

    async fn persist(&self) -> Result<(), JSONRPCErrorError> {
        office_runtime_owner_registry_store::write(&self.registry_path, &self.registry).await
    }
}

fn automation_owner_record_id(automation_owner_key: &str) -> String {
    let digest = Sha256::digest(automation_owner_key.as_bytes());
    format!("automation-{digest:x}")
}

impl PendingRuntimeOwnerClaim {
    fn matches(&self, owner: &RuntimeOwner) -> bool {
        owner.record_id == self.record_id
            && owner.member_id == self.member_id
            && owner.agent_id == self.agent_id
            && owner.kind == self.kind
            && owner.source_thread_id == self.source_thread_id
    }
}

fn validate_runtime_reference(
    registry: &RuntimeOwnerRegistry,
    record_id: Option<&str>,
    member_id: Option<&str>,
    agent_id: Option<&str>,
    runtime_thread_id: Option<&str>,
    visited: &mut usize,
) -> Result<(), JSONRPCErrorError> {
    let Some(runtime_thread_id) = runtime_thread_id else {
        return Ok(());
    };
    visit_reference(visited)?;
    let Some(owner) = registry.entries.get(runtime_thread_id) else {
        return Ok(());
    };
    let member_matches = match owner.member_id.as_deref() {
        Some(owner_member_id) => member_id == Some(owner_member_id),
        None => true,
    };
    if record_id == Some(owner.record_id.as_str())
        && member_matches
        && agent_id == Some(owner.agent_id.as_str())
    {
        return Ok(());
    }
    Err(owner_conflict_error(
        runtime_thread_id,
        owner,
        record_id.unwrap_or("missing"),
        agent_id.unwrap_or("missing"),
    ))
}

fn visit_reference(visited: &mut usize) -> Result<(), JSONRPCErrorError> {
    *visited = visited.saturating_add(/*rhs*/ 1);
    if *visited > MAX_RUNTIME_REFERENCES_PER_CONFIG {
        return Err(invalid_params(format!(
            "office runtime references exceed the validation limit of {MAX_RUNTIME_REFERENCES_PER_CONFIG}"
        )));
    }
    Ok(())
}

fn row_agent_id<'a>(
    row: &'a JsonValue,
    member_agents: &'a HashMap<String, Option<String>>,
) -> Option<&'a str> {
    text(row, "agentId").or_else(|| {
        text(row, "member")
            .and_then(|member| member_agents.get(member))
            .and_then(Option::as_deref)
    })
}

fn row_member_id<'a>(
    row: &'a JsonValue,
    agent_members: &'a HashMap<String, Option<String>>,
    named_members: &'a HashMap<String, Option<String>>,
) -> Option<&'a str> {
    text(row, "memberId")
        .or_else(|| {
            text(row, "agentId")
                .and_then(|agent_id| agent_members.get(agent_id))
                .and_then(Option::as_deref)
        })
        .or_else(|| {
            text(row, "member")
                .and_then(|member| named_members.get(member))
                .and_then(Option::as_deref)
        })
}

fn insert_unique_identity(
    identities: &mut HashMap<String, Option<String>>,
    key: &str,
    member_id: Option<&str>,
) {
    match identities.entry(key.to_string()) {
        std::collections::hash_map::Entry::Vacant(entry) => {
            entry.insert(member_id.map(str::to_string));
        }
        std::collections::hash_map::Entry::Occupied(mut entry) => {
            entry.insert(None);
        }
    }
}

fn config_record_id(config: &JsonValue) -> Option<&str> {
    config
        .get("workspace")
        .and_then(|workspace| text(workspace, "recordId"))
}

fn validate_owner_id(label: &str, value: &str) -> Result<(), JSONRPCErrorError> {
    if value.is_empty()
        || value != value.trim()
        || value.chars().any(char::is_whitespace)
        || value.chars().count() > MAX_OFFICE_RUNTIME_ID_CHARS
    {
        return Err(invalid_params(format!(
            "Office runtime owner {label} must be non-empty, contain no whitespace, and not exceed {MAX_OFFICE_RUNTIME_ID_CHARS} characters"
        )));
    }
    Ok(())
}

fn owner_identity_matches(left: &RuntimeOwner, right: &RuntimeOwner) -> bool {
    left.record_id == right.record_id
        && left.member_id == right.member_id
        && left.agent_id == right.agent_id
        && left.kind == right.kind
        && left.source_thread_id == right.source_thread_id
}

fn owner_conflict_error(
    runtime_thread_id: &str,
    owner: &RuntimeOwner,
    proposed_record_id: &str,
    proposed_agent_id: &str,
) -> JSONRPCErrorError {
    invalid_params(format!(
        "Office runtime thread {runtime_thread_id} is owned by record {} agent {}; record {proposed_record_id} agent {proposed_agent_id} cannot use it",
        owner.record_id, owner.agent_id
    ))
}

fn ensure_registry_capacity(registry: &RuntimeOwnerRegistry) -> Result<(), JSONRPCErrorError> {
    if registry.entries.len() >= MAX_REGISTRY_ENTRIES {
        return Err(internal_error(format!(
            "Office runtime owner registry reached its entry limit of {MAX_REGISTRY_ENTRIES}"
        )));
    }
    Ok(())
}

pub(super) fn validate_loaded_registry(
    registry: &RuntimeOwnerRegistry,
) -> Result<(), JSONRPCErrorError> {
    if registry.version != REGISTRY_VERSION {
        return Err(internal_error(format!(
            "unsupported Office runtime owner registry version {}",
            registry.version
        )));
    }
    if registry.entries.len() > MAX_REGISTRY_ENTRIES {
        return Err(internal_error(format!(
            "Office runtime owner registry exceeds its entry limit of {MAX_REGISTRY_ENTRIES}"
        )));
    }
    for (runtime_thread_id, owner) in &registry.entries {
        validate_owner_id("runtime thread id", runtime_thread_id)?;
        validate_owner_id("record id", &owner.record_id)?;
        if let Some(member_id) = owner.member_id.as_deref() {
            validate_owner_id("member id", member_id)?;
        }
        validate_owner_id("agent id", &owner.agent_id)?;
        validate_owner_id("repair source thread id", &owner.source_thread_id)?;
    }
    Ok(())
}

fn text<'a>(value: &'a JsonValue, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
#[path = "crewon_domain_office_runtime_owner_registry_tests.rs"]
mod tests;
