use std::collections::HashMap;
use std::collections::HashSet;
use std::io;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::RequestIdentityTransport;
use crewon_app_server_protocol::WorkspaceAccessMode;
use crewon_app_server_protocol::WorkspaceAvailability;
use crewon_app_server_protocol::WorkspaceBindParams;
use crewon_app_server_protocol::WorkspaceBindResponse;
use crewon_app_server_protocol::WorkspaceListParams;
use crewon_app_server_protocol::WorkspaceListResponse;
use crewon_app_server_protocol::WorkspaceRef;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_app_server_protocol::WorkspaceSummary;
use crewon_exec_server::LOCAL_ENVIRONMENT_ID;
use crewon_state::StateRuntime;
use tokio::fs;
use tokio::sync::Mutex;
use tokio::sync::Semaphore;
use uuid::Uuid;

use super::RequestIdentity;
use super::durable_workspace_adapter::resolve_durable_workspace_key;
use crate::error_code::internal_error;
use crate::error_code::invalid_params;

#[path = "workspace_binding.rs"]
mod workspace_binding;

const DEFAULT_WORKSPACE_LIST_LIMIT: usize = 50;
const MAX_WORKSPACE_LIST_LIMIT: usize = 100;
const MAX_REGISTERED_WORKSPACE_ROOTS: usize = 64;
const MAX_WORKSPACE_BINDINGS: usize = 256;
const MAX_WORKSPACE_KEY_CHARS: usize = 128;
const MAX_WORKSPACE_SCOPE_ID_CHARS: usize = 256;

/// Server-owned roots that may be granted opaque keys to a connection session.
#[derive(Debug, Clone)]
pub(crate) struct WorkspaceRootCatalog {
    node_id: String,
    environment_id: String,
    paths: Vec<PathBuf>,
}

impl WorkspaceRootCatalog {
    pub(crate) fn new(
        node_id: String,
        current_directory: PathBuf,
        workspace_roots: Vec<PathBuf>,
    ) -> Self {
        let mut paths = Vec::with_capacity(
            workspace_roots
                .len()
                .min(MAX_REGISTERED_WORKSPACE_ROOTS.saturating_sub(1))
                .saturating_add(1),
        );
        let mut seen = HashSet::new();
        for path in std::iter::once(current_directory).chain(workspace_roots) {
            if paths.len() >= MAX_REGISTERED_WORKSPACE_ROOTS {
                break;
            }
            if path.is_absolute() && seen.insert(path.clone()) {
                paths.push(path);
            }
        }
        Self {
            node_id,
            environment_id: LOCAL_ENVIRONMENT_ID.to_string(),
            paths,
        }
    }

    async fn resolve_roots(&self) -> Vec<ResolvedWorkspaceRoot> {
        let mut roots = Vec::new();
        let mut seen = HashSet::new();
        for path in &self.paths {
            let Ok(canonical_root) = fs::canonicalize(path).await else {
                continue;
            };
            let Ok(metadata) = fs::metadata(&canonical_root).await else {
                continue;
            };
            if !metadata.is_dir()
                || fs::read_dir(&canonical_root).await.is_err()
                || !seen.insert(canonical_root.clone())
            {
                continue;
            }
            let display_name = canonical_root
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| !name.is_empty())
                .unwrap_or("workspace")
                .to_string();
            roots.push(ResolvedWorkspaceRoot {
                canonical_root,
                display_name,
                node_id: self.node_id.clone(),
                environment_id: self.environment_id.clone(),
            });
        }
        roots
    }
}

/// Connection-session registry for opaque workspace roots and scope bindings.
#[derive(Debug)]
pub(crate) struct WorkspaceRegistry {
    owner_session_id: String,
    refresh_semaphore: Semaphore,
    state: Mutex<WorkspaceRegistryState>,
}

impl WorkspaceRegistry {
    pub(crate) fn new(owner_session_id: String) -> Self {
        Self {
            owner_session_id,
            refresh_semaphore: Semaphore::new(/*permits*/ 1),
            state: Mutex::new(WorkspaceRegistryState::default()),
        }
    }

    #[cfg(test)]
    pub(crate) async fn list(
        &self,
        identity: &RequestIdentity,
        catalog: &WorkspaceRootCatalog,
        params: WorkspaceListParams,
    ) -> Result<WorkspaceListResponse, JSONRPCErrorError> {
        self.authorize(identity)?;
        self.refresh(catalog, WorkspaceKeyMode::ConnectionScoped)
            .await?;

        self.list_registered(identity, params).await
    }

    pub(crate) async fn list_with_state(
        &self,
        identity: &RequestIdentity,
        catalog: &WorkspaceRootCatalog,
        state: Option<&StateRuntime>,
        params: WorkspaceListParams,
    ) -> Result<WorkspaceListResponse, JSONRPCErrorError> {
        self.authorize(identity)?;
        let mode = workspace_key_mode(identity, state)?;
        self.refresh(catalog, mode).await?;

        self.list_registered(identity, params).await
    }

    async fn list_registered(
        &self,
        identity: &RequestIdentity,
        params: WorkspaceListParams,
    ) -> Result<WorkspaceListResponse, JSONRPCErrorError> {
        let roots = {
            let state = self.state.lock().await;
            state.roots_by_key.values().cloned().collect::<Vec<_>>()
        };
        let mut data = Vec::with_capacity(roots.len());
        for root in roots {
            data.push(WorkspaceSummary {
                workspace_key: root.workspace_key,
                display_name: root.display_name,
                node_id: root.node_id,
                environment_id: root.environment_id,
                availability: workspace_availability(&root.canonical_root).await,
            });
        }
        data.sort_by(|left, right| {
            left.display_name
                .cmp(&right.display_name)
                .then_with(|| left.workspace_key.cmp(&right.workspace_key))
        });

        let offset = parse_cursor(params.cursor)?;
        let limit = parse_limit(params.limit)?;
        if offset > data.len() {
            return Err(invalid_params("workspace cursor is out of range"));
        }
        let end = offset.saturating_add(limit).min(data.len());
        let next_cursor = (end < data.len()).then(|| end.to_string());
        Ok(WorkspaceListResponse {
            data: data[offset..end].to_vec(),
            next_cursor,
            access_mode: workspace_access_mode(identity.transport()),
        })
    }

    pub(crate) async fn bind(
        &self,
        identity: &RequestIdentity,
        params: WorkspaceBindParams,
    ) -> Result<WorkspaceBindResponse, JSONRPCErrorError> {
        self.authorize(identity)?;
        validate_workspace_key(&params.workspace_key)?;
        validate_scope_id(&params.scope_id)?;
        self.resolve_workspace_path(&params.workspace_key, Path::new("."))
            .await?;
        let root = {
            let state = self.state.lock().await;
            state
                .roots_by_key
                .get(&params.workspace_key)
                .cloned()
                .ok_or_else(|| invalid_params("workspaceKey is not registered for this session"))?
        };
        let binding_key = (
            params.workspace_key.clone(),
            workspace_scope_key(params.scope).to_string(),
            params.scope_id.clone(),
        );
        let mut state = self.state.lock().await;
        if let Some(workspace) = state.bindings_by_identity.get(&binding_key) {
            return Ok(WorkspaceBindResponse {
                workspace: workspace.clone(),
            });
        }
        if state.bindings_by_identity.len() >= MAX_WORKSPACE_BINDINGS {
            return Err(invalid_params("workspace binding limit reached"));
        }
        let workspace = WorkspaceRef {
            workspace_key: params.workspace_key,
            binding_id: opaque_id("binding"),
            scope: params.scope,
            scope_id: params.scope_id,
            node_id: root.node_id,
            environment_id: root.environment_id,
        };
        state
            .bindings_by_identity
            .insert(binding_key, workspace.clone());
        Ok(WorkspaceBindResponse { workspace })
    }

    pub(crate) async fn bind_with_state(
        &self,
        identity: &RequestIdentity,
        catalog: &WorkspaceRootCatalog,
        state: Option<&StateRuntime>,
        params: WorkspaceBindParams,
    ) -> Result<WorkspaceBindResponse, JSONRPCErrorError> {
        self.authorize(identity)?;
        let mode = workspace_key_mode(identity, state)?;
        self.refresh(catalog, mode).await?;
        self.bind(identity, params).await
    }

    pub(crate) async fn prepare_workspace_key_with_state(
        &self,
        identity: &RequestIdentity,
        catalog: &WorkspaceRootCatalog,
        state: Option<&StateRuntime>,
        workspace_key: &str,
    ) -> Result<(), JSONRPCErrorError> {
        self.authorize(identity)?;
        validate_workspace_key(workspace_key)?;
        self.refresh(catalog, workspace_key_mode(identity, state)?)
            .await?;
        self.resolve_workspace_path(workspace_key, Path::new("."))
            .await
            .map(|_| ())
    }

    pub(crate) async fn registered_root_path_with_state(
        &self,
        identity: &RequestIdentity,
        catalog: &WorkspaceRootCatalog,
        state: Option<&StateRuntime>,
        workspace_key: &str,
    ) -> Result<PathBuf, JSONRPCErrorError> {
        self.authorize(identity)?;
        validate_workspace_key(workspace_key)?;
        self.refresh(catalog, workspace_key_mode(identity, state)?)
            .await?;
        self.resolve_workspace_path(workspace_key, Path::new("."))
            .await
    }

    pub(crate) async fn workspace_key_for_registered_root_with_state(
        &self,
        identity: &RequestIdentity,
        catalog: &WorkspaceRootCatalog,
        state: Option<&StateRuntime>,
        root: &Path,
    ) -> Result<String, JSONRPCErrorError> {
        self.authorize(identity)?;
        self.refresh(catalog, workspace_key_mode(identity, state)?)
            .await?;
        let canonical_root = fs::canonicalize(root)
            .await
            .map_err(|_| invalid_params("Office workspace root is unavailable"))?;
        let registry = self.state.lock().await;
        registry
            .key_by_canonical_root
            .get(&canonical_root)
            .cloned()
            .ok_or_else(|| invalid_params("Office workspace root is not registered"))
    }

    async fn resolve_workspace_path(
        &self,
        workspace_key: &str,
        relative_path: &Path,
    ) -> Result<PathBuf, JSONRPCErrorError> {
        validate_workspace_key(workspace_key)?;
        let root = {
            let state = self.state.lock().await;
            state
                .roots_by_key
                .get(workspace_key)
                .cloned()
                .ok_or_else(|| invalid_params("workspaceKey is not registered for this session"))?
        };
        match workspace_availability(&root.canonical_root).await {
            WorkspaceAvailability::Available => {
                resolve_registered_path(&root.canonical_root, relative_path).await
            }
            WorkspaceAvailability::Missing => Err(invalid_params("workspace is missing")),
            WorkspaceAvailability::Unreadable => Err(invalid_params("workspace is unreadable")),
        }
    }

    fn authorize(&self, identity: &RequestIdentity) -> Result<(), JSONRPCErrorError> {
        if identity.reference().session_id != self.owner_session_id {
            return Err(invalid_params(
                "workspace registry does not belong to this session",
            ));
        }
        Ok(())
    }

    async fn refresh(
        &self,
        catalog: &WorkspaceRootCatalog,
        mode: WorkspaceKeyMode<'_>,
    ) -> Result<(), JSONRPCErrorError> {
        let _refresh_permit = self
            .refresh_semaphore
            .acquire()
            .await
            .map_err(|_| internal_error("workspace registry is unavailable"))?;
        let resolved_roots = catalog.resolve_roots().await;
        let existing_keys = {
            let state = self.state.lock().await;
            state.key_by_canonical_root.clone()
        };
        let mut roots_by_key = HashMap::with_capacity(resolved_roots.len());
        let mut key_by_canonical_root = HashMap::with_capacity(resolved_roots.len());
        for root in resolved_roots {
            if roots_by_key.len() >= MAX_REGISTERED_WORKSPACE_ROOTS {
                break;
            }
            let workspace_key = match mode {
                WorkspaceKeyMode::ConnectionScoped => existing_keys
                    .get(&root.canonical_root)
                    .cloned()
                    .unwrap_or_else(|| opaque_id("workspace")),
                WorkspaceKeyMode::Durable(state) => {
                    resolve_durable_workspace_key(state, &root).await?
                }
            };
            key_by_canonical_root.insert(root.canonical_root.clone(), workspace_key.clone());
            roots_by_key.insert(
                workspace_key.clone(),
                RegisteredWorkspaceRoot {
                    workspace_key,
                    canonical_root: root.canonical_root,
                    display_name: root.display_name,
                    node_id: root.node_id,
                    environment_id: root.environment_id,
                },
            );
        }
        let mut state = self.state.lock().await;
        state
            .bindings_by_identity
            .retain(|(workspace_key, _, _), _| roots_by_key.contains_key(workspace_key));
        state.roots_by_key = roots_by_key;
        state.key_by_canonical_root = key_by_canonical_root;
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum WorkspaceKeyMode<'a> {
    ConnectionScoped,
    Durable(&'a StateRuntime),
}

fn workspace_key_mode<'a>(
    identity: &RequestIdentity,
    state: Option<&'a StateRuntime>,
) -> Result<WorkspaceKeyMode<'a>, JSONRPCErrorError> {
    if identity.authenticated_principal().is_some() {
        Ok(WorkspaceKeyMode::Durable(state.ok_or_else(|| {
            internal_error("durable workspace authority is unavailable")
        })?))
    } else {
        Ok(WorkspaceKeyMode::ConnectionScoped)
    }
}

#[derive(Debug, Default)]
struct WorkspaceRegistryState {
    roots_by_key: HashMap<String, RegisteredWorkspaceRoot>,
    key_by_canonical_root: HashMap<PathBuf, String>,
    bindings_by_identity: HashMap<(String, String, String), WorkspaceRef>,
}

#[derive(Clone, Debug)]
pub(super) struct ResolvedWorkspaceRoot {
    pub(super) canonical_root: PathBuf,
    display_name: String,
    pub(super) node_id: String,
    pub(super) environment_id: String,
}

#[derive(Clone, Debug)]
struct RegisteredWorkspaceRoot {
    workspace_key: String,
    canonical_root: PathBuf,
    display_name: String,
    node_id: String,
    environment_id: String,
}

async fn workspace_availability(root: &Path) -> WorkspaceAvailability {
    match fs::metadata(root).await {
        Ok(metadata) if metadata.is_dir() => match fs::read_dir(root).await {
            Ok(_) => WorkspaceAvailability::Available,
            Err(err) if err.kind() == io::ErrorKind::NotFound => WorkspaceAvailability::Missing,
            Err(_) => WorkspaceAvailability::Unreadable,
        },
        Ok(_) => WorkspaceAvailability::Unreadable,
        Err(err) if err.kind() == io::ErrorKind::NotFound => WorkspaceAvailability::Missing,
        Err(_) => WorkspaceAvailability::Unreadable,
    }
}

async fn resolve_registered_path(
    canonical_root: &Path,
    relative_path: &Path,
) -> Result<PathBuf, JSONRPCErrorError> {
    if relative_path.is_absolute()
        || relative_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(invalid_params("relative path must stay within workspace"));
    }
    let candidate = canonical_root.join(relative_path);
    let canonical_candidate =
        fs::canonicalize(candidate)
            .await
            .map_err(|err| match err.kind() {
                io::ErrorKind::NotFound => invalid_params("workspace path is missing"),
                io::ErrorKind::PermissionDenied => invalid_params("workspace path is unreadable"),
                _ => invalid_params("workspace path cannot be resolved"),
            })?;
    if !canonical_candidate.starts_with(canonical_root) {
        return Err(invalid_params("path resolves outside workspace"));
    }
    Ok(canonical_candidate)
}

fn parse_cursor(cursor: Option<String>) -> Result<usize, JSONRPCErrorError> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    if cursor.len() > 20 {
        return Err(invalid_params("invalid workspace cursor"));
    }
    cursor
        .parse::<usize>()
        .map_err(|_| invalid_params("invalid workspace cursor"))
}

fn parse_limit(limit: Option<u32>) -> Result<usize, JSONRPCErrorError> {
    let limit = limit
        .map(|limit| limit as usize)
        .unwrap_or(DEFAULT_WORKSPACE_LIST_LIMIT);
    if limit == 0 || limit > MAX_WORKSPACE_LIST_LIMIT {
        return Err(invalid_params("workspace limit must be between 1 and 100"));
    }
    Ok(limit)
}

fn validate_workspace_key(workspace_key: &str) -> Result<(), JSONRPCErrorError> {
    if workspace_key.is_empty()
        || workspace_key.len() > MAX_WORKSPACE_KEY_CHARS
        || workspace_key.chars().any(char::is_whitespace)
    {
        return Err(invalid_params("invalid workspaceKey"));
    }
    Ok(())
}

fn validate_scope_id(scope_id: &str) -> Result<(), JSONRPCErrorError> {
    if scope_id.is_empty()
        || scope_id.len() > MAX_WORKSPACE_SCOPE_ID_CHARS
        || scope_id.trim() != scope_id
        || scope_id.chars().any(char::is_control)
    {
        return Err(invalid_params("invalid workspace scopeId"));
    }
    Ok(())
}

fn workspace_access_mode(transport: RequestIdentityTransport) -> WorkspaceAccessMode {
    match transport {
        RequestIdentityTransport::Stdio | RequestIdentityTransport::InProcess => {
            WorkspaceAccessMode::LocalProcessServerRoots
        }
        RequestIdentityTransport::WebSocket | RequestIdentityTransport::RemoteControl => {
            WorkspaceAccessMode::RemoteServerRoots
        }
    }
}

fn workspace_scope_key(scope: WorkspaceScope) -> &'static str {
    match scope {
        WorkspaceScope::Conversation => "conversation",
        WorkspaceScope::Office => "office",
        WorkspaceScope::Workflow => "workflow",
        WorkspaceScope::Automation => "automation",
    }
}

fn opaque_id(prefix: &str) -> String {
    format!("{prefix}:{}", Uuid::now_v7())
}

#[cfg(test)]
#[path = "workspace_tests.rs"]
mod tests;
