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
    bindings: BTreeMap<String, ProviderBinding>,
    schema_version: String,
}

impl Default for ProviderCredentialCatalogFile {
    fn default() -> Self {
        Self {
            active_provider_id: None,
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
        manager.upsert_with_reload(&request, |previous, candidate| {
            crate::control_runtime::reload::replace_provider_runtime(&app, previous, candidate)
                .map_err(crate::control_runtime::ControlRuntimeStartError::code)
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
        manager.activate_with_reload(&request, |previous, candidate| {
            crate::control_runtime::reload::replace_provider_runtime(&app, previous, candidate)
                .map_err(crate::control_runtime::ControlRuntimeStartError::code)
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
        manager.delete_with_reload(&request, |previous, candidate| {
            crate::control_runtime::reload::replace_provider_runtime(&app, previous, candidate)
                .map_err(crate::control_runtime::ControlRuntimeStartError::code)
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

fn validated_binding(
    request: &ProviderCredentialUpsertRequest,
) -> Result<ProviderBinding, ProviderCredentialError> {
    validate_provider_id(&request.provider_id)?;
    let endpoint = validate_endpoint(&request.endpoint)?;
    let environment_variable = match request.credential_kind {
        ProviderCredentialKind::Environment => Some(validate_environment_variable(
            request
                .environment_variable
                .as_deref()
                .ok_or(ProviderCredentialError::InvalidRequest)?,
        )?),
        ProviderCredentialKind::Keychain | ProviderCredentialKind::None => {
            if request.environment_variable.is_some() {
                return Err(ProviderCredentialError::InvalidRequest);
            }
            None
        }
    };
    match request.credential_kind {
        ProviderCredentialKind::Keychain => {
            if let Some(secret) = request.secret.as_deref() {
                validate_secret(secret)?;
            }
        }
        ProviderCredentialKind::Environment | ProviderCredentialKind::None => {
            if request.secret.is_some() {
                return Err(ProviderCredentialError::InvalidRequest);
            }
        }
    }
    Ok(ProviderBinding {
        credential_kind: request.credential_kind,
        endpoint,
        environment_variable,
        provider_id: request.provider_id.clone(),
    })
}

fn validate_catalog(
    catalog: &ProviderCredentialCatalogFile,
) -> Result<(), ProviderCredentialError> {
    if catalog.schema_version != CATALOG_SCHEMA_VERSION {
        return Err(ProviderCredentialError::CatalogInvalid);
    }
    for (provider_id, binding) in &catalog.bindings {
        if provider_id != &binding.provider_id {
            return Err(ProviderCredentialError::CatalogInvalid);
        }
        validate_provider_id(provider_id).map_err(|_| ProviderCredentialError::CatalogInvalid)?;
        validate_endpoint(&binding.endpoint)
            .map_err(|_| ProviderCredentialError::CatalogInvalid)?;
        match binding.credential_kind {
            ProviderCredentialKind::Environment => {
                validate_environment_variable(
                    binding
                        .environment_variable
                        .as_deref()
                        .ok_or(ProviderCredentialError::CatalogInvalid)?,
                )
                .map_err(|_| ProviderCredentialError::CatalogInvalid)?;
            }
            ProviderCredentialKind::Keychain | ProviderCredentialKind::None => {
                if binding.environment_variable.is_some() {
                    return Err(ProviderCredentialError::CatalogInvalid);
                }
            }
        }
    }
    if catalog
        .active_provider_id
        .as_ref()
        .is_some_and(|provider_id| !catalog.bindings.contains_key(provider_id))
    {
        return Err(ProviderCredentialError::CatalogInvalid);
    }
    Ok(())
}

fn validate_provider_id(provider_id: &str) -> Result<(), ProviderCredentialError> {
    if provider_id.is_empty()
        || provider_id.len() > MAX_PROVIDER_ID_BYTES
        || !provider_id.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'-' | b'_'))
        })
    {
        return Err(ProviderCredentialError::InvalidRequest);
    }
    Ok(())
}

fn validate_endpoint(endpoint: &str) -> Result<String, ProviderCredentialError> {
    if endpoint.is_empty() || endpoint.len() > MAX_ENDPOINT_BYTES {
        return Err(ProviderCredentialError::InvalidRequest);
    }
    let parsed = url::Url::parse(endpoint).map_err(|_| ProviderCredentialError::InvalidRequest)?;
    let is_loopback = match parsed.host() {
        Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    };
    if !matches!(parsed.scheme(), "http" | "https")
        || (parsed.scheme() == "http" && !is_loopback)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(ProviderCredentialError::InvalidRequest);
    }
    Ok(endpoint.to_string())
}

fn validate_environment_variable(variable: &str) -> Result<String, ProviderCredentialError> {
    if variable.is_empty()
        || variable.len() > 128
        || !variable.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphabetic() || byte == b'_' || (index > 0 && byte.is_ascii_digit())
        })
    {
        return Err(ProviderCredentialError::InvalidRequest);
    }
    Ok(variable.to_string())
}

fn validate_secret(secret: &str) -> Result<(), ProviderCredentialError> {
    if secret.is_empty()
        || secret.len() > MAX_SECRET_BYTES
        || secret.trim() != secret
        || secret.chars().any(char::is_control)
    {
        return Err(ProviderCredentialError::InvalidRequest);
    }
    Ok(())
}

#[cfg(test)]
#[path = "provider_credentials_tests.rs"]
mod tests;
