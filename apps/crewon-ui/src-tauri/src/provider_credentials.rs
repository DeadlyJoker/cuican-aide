//! Cross-platform Provider credential authority for the packaged desktop app.
//!
//! Provider identity, endpoint, and credential kind are non-sensitive metadata.
//! The raw credential is bound separately by provider id in the operating
//! system's secret store and is never serialized into the metadata file.

use std::collections::BTreeMap;
use std::fs;
use std::sync::Arc;

use serde::Deserialize;
use serde::Serialize;
use tauri::AppHandle;
use tauri::Manager;
use tauri::State;
use zeroize::Zeroize;
use zeroize::Zeroizing;

#[path = "provider_credentials_store.rs"]
mod store;

use self::store::restrict_directory;
use self::store::OsProviderSecretStore;
use self::store::ProviderCredentialManager;

const CATALOG_SCHEMA_VERSION: &str = "crewon.provider-credential-catalog.v1";
const MUTATION_JOURNAL_SCHEMA_VERSION: &str = "crewon.provider-credential-mutation.v1";
const CREDENTIAL_SERVICE: &str = "ai.crewon.desktop.model-provider";
const MAX_CATALOG_BYTES: u64 = 64 * 1024;
const MAX_ENDPOINT_BYTES: usize = 2048;
const MAX_PROVIDER_ID_BYTES: usize = 128;
const MAX_SECRET_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderCredentialError {
    CatalogInvalid,
    CredentialMissing,
    CredentialStoreUnavailable,
    InvalidRequest,
    StateAlreadyInstalled,
    StateUnavailable,
}

impl ProviderCredentialError {
    pub fn code(self) -> &'static str {
        match self {
            Self::CatalogInvalid => "provider_credential_catalog_invalid",
            Self::CredentialMissing => "provider_credential_missing",
            Self::CredentialStoreUnavailable => "provider_credential_store_unavailable",
            Self::InvalidRequest => "provider_credential_request_invalid",
            Self::StateAlreadyInstalled => "provider_credential_state_already_installed",
            Self::StateUnavailable => "provider_credential_state_unavailable",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProviderCredentialMutationError {
    Credential(ProviderCredentialError),
    Runtime(&'static str),
    Rollback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderRuntimeMutationFailure {
    BeforeCommit(&'static str),
    AfterCommit,
}

pub(crate) struct ProviderRuntimeMutation<'a> {
    pub(crate) operation_id: &'a str,
    pub(crate) active_provider_id: Option<&'a str>,
    pub(crate) runtime_binding_id: Option<&'a str>,
    pub(crate) bindings: Vec<ProviderRuntimeMutationBinding>,
    pub(crate) previous_runtime: Option<&'a ActiveProviderRuntime>,
    pub(crate) candidate_runtime: Option<&'a ActiveProviderRuntime>,
}

pub(crate) struct ProviderRuntimeMutationBinding {
    pub(crate) credential_kind: ProviderCredentialKind,
    pub(crate) endpoint: String,
    pub(crate) environment_variable: Option<String>,
    pub(crate) provider_id: String,
}

pub(crate) enum ProviderCredentialRecoveryDisposition {
    KeepCandidate,
    RestorePrevious,
}

pub(crate) struct ProviderCredentialRecovery<'a> {
    pub(crate) operation_id: &'a str,
    pub(crate) runtime_binding_id: Option<&'a str>,
    pub(crate) previous_runtime: Option<&'a ActiveProviderRuntime>,
}

impl ProviderCredentialMutationError {
    fn code(self) -> &'static str {
        match self {
            Self::Credential(error) => error.code(),
            Self::Runtime(code) => code,
            Self::Rollback => "provider_credential_rollback_failed",
        }
    }
}

impl From<ProviderCredentialError> for ProviderCredentialMutationError {
    fn from(error: ProviderCredentialError) -> Self {
        Self::Credential(error)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderCredentialKind {
    Environment,
    Keychain,
    None,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderBinding {
    credential_kind: ProviderCredentialKind,
    endpoint: String,
    environment_variable: Option<String>,
    provider_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderCredentialCatalogFile {
    active_provider_id: Option<String>,
    #[serde(default)]
    active_runtime_binding_id: Option<String>,
    bindings: BTreeMap<String, ProviderBinding>,
    schema_version: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderCredentialMutationJournal {
    schema_version: String,
    operation_id: String,
    runtime_binding_id: Option<String>,
    provider_id: String,
    backup_secret_key: String,
    previous_secret_present: bool,
    previous_catalog: ProviderCredentialCatalogFile,
    candidate_catalog: ProviderCredentialCatalogFile,
}

impl Default for ProviderCredentialCatalogFile {
    fn default() -> Self {
        Self {
            active_provider_id: None,
            active_runtime_binding_id: None,
            bindings: BTreeMap::new(),
            schema_version: CATALOG_SCHEMA_VERSION.to_string(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCredentialUpsertRequest {
    activate: bool,
    credential_kind: ProviderCredentialKind,
    endpoint: String,
    environment_variable: Option<String>,
    provider_id: String,
    secret: Option<String>,
}

impl Drop for ProviderCredentialUpsertRequest {
    fn drop(&mut self) {
        if let Some(secret) = self.secret.as_mut() {
            secret.zeroize();
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCredentialTargetRequest {
    provider_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCredentialBindingView {
    credential_available: bool,
    credential_kind: ProviderCredentialKind,
    endpoint: String,
    environment_variable: Option<String>,
    is_active: bool,
    provider_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCredentialCatalogView {
    active_provider_id: Option<String>,
    bindings: Vec<ProviderCredentialBindingView>,
}

#[derive(Clone)]
pub struct ActiveProviderBinding {
    pub credential_kind: ProviderCredentialKind,
    pub endpoint: String,
    pub environment_variable: Option<String>,
    pub provider_id: String,
    pub runtime_binding_id: String,
}

pub struct ActiveProviderRuntime {
    pub binding: ActiveProviderBinding,
    pub secret: Option<Zeroizing<String>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SecretStoreError {
    Missing,
    Unavailable,
}

/// Stores only raw Provider secrets; implementations must not persist metadata
/// or return backend-specific error text to callers.
trait ProviderSecretStore: Send + Sync {
    fn delete(&self, provider_id: &str) -> Result<(), SecretStoreError>;
    fn get(&self, provider_id: &str) -> Result<Zeroizing<String>, SecretStoreError>;
    fn set(&self, provider_id: &str, secret: &str) -> Result<(), SecretStoreError>;
}

#[tauri::command]
pub fn provider_credential_catalog(
    manager: State<'_, ProviderCredentialManager>,
) -> Result<ProviderCredentialCatalogView, &'static str> {
    manager
        .catalog_view()
        .map_err(ProviderCredentialError::code)
}

#[tauri::command]
pub fn provider_credential_upsert(
    app: AppHandle,
    manager: State<'_, ProviderCredentialManager>,
    request: ProviderCredentialUpsertRequest,
) -> Result<ProviderCredentialCatalogView, &'static str> {
    credential_mutation_result(
        &app,
        manager.upsert_with_coordinator(&request, |mutation| {
            crate::control_runtime::provider_switch::coordinate_provider_runtime(&app, mutation)
        }),
    )
}

#[tauri::command]
pub fn provider_credential_activate(
    app: AppHandle,
    manager: State<'_, ProviderCredentialManager>,
    request: ProviderCredentialTargetRequest,
) -> Result<ProviderCredentialCatalogView, &'static str> {
    credential_mutation_result(
        &app,
        manager.activate_with_coordinator(&request, |mutation| {
            crate::control_runtime::provider_switch::coordinate_provider_runtime(&app, mutation)
        }),
    )
}

#[tauri::command]
pub fn provider_credential_delete(
    app: AppHandle,
    manager: State<'_, ProviderCredentialManager>,
    request: ProviderCredentialTargetRequest,
) -> Result<ProviderCredentialCatalogView, &'static str> {
    credential_mutation_result(
        &app,
        manager.delete_with_coordinator(&request, |mutation| {
            crate::control_runtime::provider_switch::coordinate_provider_runtime(&app, mutation)
        }),
    )
}

fn credential_mutation_result<T>(
    app: &AppHandle,
    result: Result<T, ProviderCredentialMutationError>,
) -> Result<T, &'static str> {
    credential_mutation_result_with_shutdown(result, || {
        crate::control_runtime::shutdown_managed_supervisor(app);
    })
}

fn credential_mutation_result_with_shutdown<T>(
    result: Result<T, ProviderCredentialMutationError>,
    shutdown: impl FnOnce(),
) -> Result<T, &'static str> {
    match result {
        Ok(value) => Ok(value),
        Err(error @ ProviderCredentialMutationError::Rollback) => {
            shutdown();
            Err(error.code())
        }
        Err(error) => Err(error.code()),
    }
}

pub fn install(app: &AppHandle) -> Result<(), ProviderCredentialError> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| ProviderCredentialError::CatalogInvalid)?
        .join("control-runtime-v0");
    fs::create_dir_all(&root).map_err(|_| ProviderCredentialError::CatalogInvalid)?;
    restrict_directory(&root)?;
    let manager = ProviderCredentialManager::open(
        root.join("provider-credentials.v1.json"),
        Arc::new(OsProviderSecretStore {
            service: CREDENTIAL_SERVICE,
        }),
    )?;
    if app.manage(manager) {
        Ok(())
    } else {
        Err(ProviderCredentialError::StateAlreadyInstalled)
    }
}

pub fn active_provider_binding(
    app: &AppHandle,
) -> Result<Option<ActiveProviderBinding>, ProviderCredentialError> {
    app.try_state::<ProviderCredentialManager>()
        .ok_or(ProviderCredentialError::StateUnavailable)?
        .active_binding()
}

pub fn active_provider_runtime(
    app: &AppHandle,
) -> Result<Option<ActiveProviderRuntime>, ProviderCredentialError> {
    app.try_state::<ProviderCredentialManager>()
        .ok_or(ProviderCredentialError::StateUnavailable)?
        .active_runtime()
}

pub(crate) fn recover_pending_mutation(
    app: &AppHandle,
    recover: impl FnOnce(
        &ProviderCredentialRecovery<'_>,
    ) -> Result<ProviderCredentialRecoveryDisposition, &'static str>,
) -> Result<(), ProviderCredentialError> {
    app.try_state::<ProviderCredentialManager>()
        .ok_or(ProviderCredentialError::StateUnavailable)?
        .recover_with_coordinator(recover)
        .map_err(|_| ProviderCredentialError::StateUnavailable)
}

include!("provider_credentials_validation.rs");
