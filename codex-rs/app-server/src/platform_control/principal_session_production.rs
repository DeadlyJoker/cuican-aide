use std::collections::HashMap;
use std::env;
use std::fs;
use std::fs::File;
use std::io;
use std::io::ErrorKind;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use crewon_app_server_transport::PrincipalSessionExchangeService;
use crewon_app_server_transport::PrincipalSessionRs256AuthConfig;
use crewon_app_server_transport::TransportPrincipalRevocationRegistry;
use crewon_app_server_transport::auth::WebsocketAuthPolicy;
use crewon_app_server_transport::auth::principal_session_rs256_policy;
use crewon_provider_agent_platform::AgentPlatformIdentitySourceConnector;
use crewon_provider_agent_platform::IdentitySourceBootstrapRs256Verifier;
use crewon_provider_agent_platform::IdentitySourceRs256SigningKey;
use crewon_provider_agent_platform::Rs256IdentitySourceAuthorizer;
use crewon_state::StateRuntime;
use serde::Deserialize;
use serde::Deserializer;
use serde::de::MapAccess;
use serde::de::Visitor;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tracing::error;

use super::principal_revocation_listener::PrincipalRevocationListener;
use super::principal_revocation_listener::PrincipalRevocationListenerSettings;
use super::principal_revocation_listener::ReadyPrincipalRevocationCursor;
use super::principal_session_exchange::AgentPlatformBootstrapSessionIssuer;
use super::principal_session_exchange::principal_session_exchange_service;

const ENABLED_ENV: &str = "CREWON_PRINCIPAL_SESSION_ENABLED";
const ENDPOINT_ENV: &str = "CREWON_IDENTITY_SOURCE_URL";
const ENDPOINT_MODE_ENV: &str = "CREWON_IDENTITY_SOURCE_ENDPOINT_MODE";
const SERVICE_KEY_ID_ENV: &str = "CREWON_IDENTITY_SOURCE_SERVICE_SIGNING_KEY_ID";
const SERVICE_PRIVATE_KEY_FILE_ENV: &str =
    "CREWON_IDENTITY_SOURCE_SERVICE_SIGNING_PRIVATE_KEY_FILE";
const BOOTSTRAP_PUBLIC_KEYS_FILE_ENV: &str =
    "CREWON_IDENTITY_SOURCE_BOOTSTRAP_TRUSTED_PUBLIC_KEYS_FILE";
const SESSION_PUBLIC_KEYS_FILE_ENV: &str = "CREWON_PRINCIPAL_SESSION_TRUSTED_PUBLIC_KEYS_FILE";
const MAX_KEY_FILE_BYTES: usize = 64 * 1024;
const MAX_KEYSET_FILE_BYTES: usize = 1024 * 1024;
const MAX_KEYS: usize = 16;
const CLOCK_SKEW_SECONDS: u64 = 30;
const REVOCATION_PAGE_SIZE: u32 = 100;
const MAX_REVOCATIONS: usize = 4_096;

pub(crate) struct PreparedPrincipalSessionProduction {
    auth_policy: WebsocketAuthPolicy,
    registry: TransportPrincipalRevocationRegistry,
    exchange: PrincipalSessionExchangeService,
    feed: Arc<
        crewon_provider_agent_platform::AgentPlatformIdentitySourceClient<
            Rs256IdentitySourceAuthorizer,
        >,
    >,
    listener_settings: PrincipalRevocationListenerSettings,
    ready_cursor: Option<ReadyPrincipalRevocationCursor>,
}

impl PreparedPrincipalSessionProduction {
    pub(crate) fn is_enabled_in_process_environment() -> io::Result<bool> {
        let environment = env::vars().collect::<HashMap<_, _>>();
        enabled(&environment)
    }

    pub(crate) async fn from_process_environment(
        state: Arc<StateRuntime>,
    ) -> io::Result<Option<Self>> {
        let environment = env::vars().collect::<HashMap<_, _>>();
        Self::from_environment_with_state(&environment, Some(state)).await
    }

    pub(crate) fn identity_source_reader(
        &self,
    ) -> &crewon_provider_agent_platform::AgentPlatformIdentitySourceClient<
        Rs256IdentitySourceAuthorizer,
    > {
        self.feed.as_ref()
    }

    #[cfg(test)]
    async fn from_environment(environment: &HashMap<String, String>) -> io::Result<Option<Self>> {
        Self::from_environment_with_state(environment, /*state*/ None).await
    }

    async fn from_environment_with_state(
        environment: &HashMap<String, String>,
        state: Option<Arc<StateRuntime>>,
    ) -> io::Result<Option<Self>> {
        if !enabled(environment)? {
            return Ok(None);
        }
        let state = state.ok_or_else(invalid_configuration)?;
        let endpoint = required(environment, ENDPOINT_ENV)?;
        let connector = match environment
            .get(ENDPOINT_MODE_ENV)
            .map(String::as_str)
            .unwrap_or("production")
        {
            "production" => AgentPlatformIdentitySourceConnector::production(endpoint).await,
            "development-loopback" => {
                AgentPlatformIdentitySourceConnector::development_loopback(endpoint).await
            }
            _ => return Err(invalid_configuration()),
        }
        .map_err(|_| invalid_configuration())?;
        let service_key_id = required(environment, SERVICE_KEY_ID_ENV)?;
        let service_private_key = read_bounded_file(
            &required_path(environment, SERVICE_PRIVATE_KEY_FILE_ENV)?,
            MAX_KEY_FILE_BYTES,
            FileSensitivity::Private,
        )?;
        let signing_key = Arc::new(
            IdentitySourceRs256SigningKey::from_owned_rsa_pem(service_key_id, service_private_key)
                .map_err(|_| invalid_configuration())?,
        );
        let bootstrap_keys =
            read_keyset(&required_path(environment, BOOTSTRAP_PUBLIC_KEYS_FILE_ENV)?)?;
        let session_keys = read_keyset(&required_path(environment, SESSION_PUBLIC_KEYS_FILE_ENV)?)?;
        let bootstrap_verifier =
            IdentitySourceBootstrapRs256Verifier::new(bootstrap_keys, CLOCK_SKEW_SECONDS)
                .map_err(|_| invalid_configuration())?;
        let session_auth = PrincipalSessionRs256AuthConfig::new(session_keys, CLOCK_SKEW_SECONDS)
            .map_err(|_| invalid_configuration())?;
        let service_authorizer = Rs256IdentitySourceAuthorizer::service_only(signing_key.clone());
        let feed = Arc::new(
            connector
                .client(service_authorizer)
                .map_err(|_| invalid_configuration())?,
        );
        let registry = TransportPrincipalRevocationRegistry::new();
        let listener_settings =
            PrincipalRevocationListenerSettings::new(REVOCATION_PAGE_SIZE, MAX_REVOCATIONS)
                .map_err(|_| invalid_configuration())?;
        let now = unix_now()?;
        let ready_cursor =
            PrincipalRevocationListener::new(feed.as_ref(), &registry, listener_settings)
                .prepare(now)
                .await
                .map_err(|_| unavailable_configuration())?;
        let issuer = Arc::new(AgentPlatformBootstrapSessionIssuer::new(
            connector,
            signing_key,
            bootstrap_verifier,
            state,
        ));
        Ok(Some(Self {
            auth_policy: principal_session_rs256_policy(session_auth),
            registry,
            exchange: principal_session_exchange_service(issuer),
            feed,
            listener_settings,
            ready_cursor: Some(ready_cursor),
        }))
    }

    pub(crate) fn auth_policy(&self) -> WebsocketAuthPolicy {
        self.auth_policy.clone()
    }

    pub(crate) fn registry(&self) -> TransportPrincipalRevocationRegistry {
        self.registry.clone()
    }

    pub(crate) fn exchange(&self) -> PrincipalSessionExchangeService {
        self.exchange.clone()
    }

    pub(crate) fn start_listener(
        &mut self,
        cancellation: CancellationToken,
    ) -> io::Result<JoinHandle<()>> {
        let ready = self
            .ready_cursor
            .take()
            .ok_or_else(|| io::Error::new(ErrorKind::AlreadyExists, "listener already started"))?;
        let feed = self.feed.clone();
        let registry = self.registry.clone();
        let settings = self.listener_settings;
        Ok(tokio::spawn(async move {
            let listener = PrincipalRevocationListener::new(feed.as_ref(), &registry, settings);
            if let Err(error) = listener.run(ready, &cancellation).await {
                error!(%error, "principal revocation listener failed closed");
            }
        }))
    }
}

fn enabled(environment: &HashMap<String, String>) -> io::Result<bool> {
    match environment
        .get(ENABLED_ENV)
        .map(String::as_str)
        .unwrap_or("false")
    {
        "false" => Ok(false),
        "true" => Ok(true),
        _ => Err(invalid_configuration()),
    }
}

#[derive(Clone, Copy)]
pub(super) enum FileSensitivity {
    Public,
    Private,
}

fn read_keyset(path: &Path) -> io::Result<HashMap<String, String>> {
    let bytes = read_bounded_file(path, MAX_KEYSET_FILE_BYTES, FileSensitivity::Public)?;
    let keyset = serde_json::from_slice::<StrictKeyset>(&bytes)
        .map_err(|_| invalid_configuration())?
        .0;
    if keyset.is_empty() || keyset.len() > MAX_KEYS {
        return Err(invalid_configuration());
    }
    Ok(keyset)
}

struct StrictKeyset(HashMap<String, String>);

impl<'de> Deserialize<'de> for StrictKeyset {
    fn deserialize<DeserializerT>(deserializer: DeserializerT) -> Result<Self, DeserializerT::Error>
    where
        DeserializerT: Deserializer<'de>,
    {
        deserializer.deserialize_map(StrictKeysetVisitor)
    }
}

struct StrictKeysetVisitor;

impl<'de> Visitor<'de> for StrictKeysetVisitor {
    type Value = StrictKeyset;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a bounded unique string keyset")
    }

    fn visit_map<MapT>(self, mut map: MapT) -> Result<Self::Value, MapT::Error>
    where
        MapT: MapAccess<'de>,
    {
        let mut keys = HashMap::new();
        while let Some((key, value)) = map.next_entry::<String, String>()? {
            if keys.len() >= MAX_KEYS || keys.insert(key, value).is_some() {
                return Err(serde::de::Error::custom("invalid keyset"));
            }
        }
        Ok(StrictKeyset(keys))
    }
}

pub(super) fn read_bounded_file(
    path: &Path,
    max_bytes: usize,
    sensitivity: FileSensitivity,
) -> io::Result<Vec<u8>> {
    if !path.is_absolute() {
        return Err(invalid_configuration());
    }
    let path_metadata = fs::symlink_metadata(path).map_err(|_| invalid_configuration())?;
    if path_metadata.file_type().is_symlink()
        || !path_metadata.is_file()
        || path_metadata.len() > max_bytes as u64
    {
        return Err(invalid_configuration());
    }
    let file = File::open(path).map_err(|_| invalid_configuration())?;
    let opened_metadata = file.metadata().map_err(|_| invalid_configuration())?;
    let current_path_metadata = fs::symlink_metadata(path).map_err(|_| invalid_configuration())?;
    if current_path_metadata.file_type().is_symlink()
        || !current_path_metadata.is_file()
        || !opened_metadata.is_file()
        || opened_metadata.len() > max_bytes as u64
    {
        return Err(invalid_configuration());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened_metadata.dev() != current_path_metadata.dev()
            || opened_metadata.ino() != current_path_metadata.ino()
        {
            return Err(invalid_configuration());
        }
    }
    #[cfg(unix)]
    if matches!(sensitivity, FileSensitivity::Private) {
        use std::os::unix::fs::PermissionsExt;
        if opened_metadata.permissions().mode() & 0o077 != 0 {
            return Err(invalid_configuration());
        }
    }
    let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
    file.take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid_configuration())?;
    if bytes.is_empty() || bytes.len() > max_bytes {
        return Err(invalid_configuration());
    }
    Ok(bytes)
}

pub(super) fn required<'a>(
    environment: &'a HashMap<String, String>,
    key: &str,
) -> io::Result<&'a str> {
    let value = environment.get(key).ok_or_else(invalid_configuration)?;
    if value.is_empty() || value.trim() != value || value.len() > 4_096 {
        return Err(invalid_configuration());
    }
    Ok(value)
}

pub(super) fn required_path(
    environment: &HashMap<String, String>,
    key: &str,
) -> io::Result<PathBuf> {
    Ok(PathBuf::from(required(environment, key)?))
}

fn unix_now() -> io::Result<i64> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| unavailable_configuration())?
        .as_secs();
    i64::try_from(now).map_err(|_| unavailable_configuration())
}

fn invalid_configuration() -> io::Error {
    io::Error::new(
        ErrorKind::InvalidInput,
        "principal session production configuration is invalid",
    )
}

fn unavailable_configuration() -> io::Error {
    io::Error::new(
        ErrorKind::ConnectionRefused,
        "principal session authority is unavailable",
    )
}

#[cfg(test)]
#[path = "principal_session_production_tests.rs"]
mod tests;
