use std::collections::HashMap;
use std::io;
use std::io::ErrorKind;
use std::sync::Arc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use crewon_provider_agent_platform::AgentPlatformDynamicResourceManifest;
use crewon_provider_agent_platform::AgentPlatformProviderClient;
use crewon_provider_agent_platform::AgentPlatformProviderConnector;
use crewon_provider_agent_platform::AgentPlatformProviderError;
use crewon_provider_agent_platform::ProviderRs256SigningKey;
use crewon_provider_agent_platform::Rs256ProviderAuthorizer;
use crewon_resource_federation::CatalogProvider;
use crewon_resource_federation::ProviderError;
use crewon_resource_federation::ResourceListQuery;
use crewon_resource_federation::ResourceManifest;
use crewon_resource_federation::ResourcePage;
use crewon_resource_federation::ResourceRef;

use super::principal_session_production::FileSensitivity;
use super::principal_session_production::read_bounded_file;
use super::principal_session_production::required;
use super::principal_session_production::required_path;
use super::provider_connection_descriptor::LiveProviderDescriptor;
use super::provider_connection_descriptor::ProviderConnectionClock;
use super::provider_connection_descriptor::ProviderDescriptorReadError;
use super::provider_connection_descriptor::ProviderDescriptorReadRequest;
use super::provider_connection_descriptor::ProviderDescriptorReader;
use super::provider_resource_catalog::ProviderResourceCatalog;
use super::provider_resource_catalog::ProviderResourceCatalogFactory;

const ENABLED_ENV: &str = "CREWON_PROVIDER_AGENT_PLATFORM_ENABLED";
const ENDPOINT_ENV: &str = "CREWON_PROVIDER_AGENT_PLATFORM_URL";
const ENDPOINT_MODE_ENV: &str = "CREWON_PROVIDER_AGENT_PLATFORM_ENDPOINT_MODE";
const SIGNING_KEY_ID_ENV: &str = "CREWON_PROVIDER_AGENT_PLATFORM_SIGNING_KEY_ID";
const SIGNING_PRIVATE_KEY_FILE_ENV: &str =
    "CREWON_PROVIDER_AGENT_PLATFORM_SIGNING_PRIVATE_KEY_FILE";
const MAX_KEY_FILE_BYTES: usize = 64 * 1024;
const AGENT_PLATFORM_PROVIDER_ID: &str = "agent-platform";

pub(crate) struct PreparedProviderConnectionProduction {
    factory: AgentPlatformProviderDescriptorFactory,
}

impl PreparedProviderConnectionProduction {
    pub(crate) async fn from_environment(
        environment: &HashMap<String, String>,
    ) -> io::Result<Option<Self>> {
        if !enabled(environment)? {
            return Ok(None);
        }
        let endpoint = required(environment, ENDPOINT_ENV)?;
        let connector = match environment
            .get(ENDPOINT_MODE_ENV)
            .map(String::as_str)
            .unwrap_or("production")
        {
            "production" => AgentPlatformProviderConnector::production(endpoint).await,
            "development-loopback" => {
                AgentPlatformProviderConnector::development_loopback(endpoint).await
            }
            _ => return Err(invalid_configuration()),
        }
        .map_err(configuration_error)?;
        let key_id = required(environment, SIGNING_KEY_ID_ENV)?;
        let private_key = read_bounded_file(
            &required_path(environment, SIGNING_PRIVATE_KEY_FILE_ENV)?,
            MAX_KEY_FILE_BYTES,
            FileSensitivity::Private,
        )?;
        let signing_key = ProviderRs256SigningKey::from_owned_rsa_pem(key_id, private_key)
            .map_err(|_| invalid_configuration())?;
        Ok(Some(Self {
            factory: AgentPlatformProviderDescriptorFactory {
                connector,
                signing_key: Arc::new(signing_key),
            },
        }))
    }

    pub(crate) fn factory(&self) -> &AgentPlatformProviderDescriptorFactory {
        &self.factory
    }
}

#[derive(Clone)]
pub(crate) struct AgentPlatformProviderDescriptorFactory {
    connector: AgentPlatformProviderConnector,
    signing_key: Arc<ProviderRs256SigningKey>,
}

impl AgentPlatformProviderDescriptorFactory {
    pub(crate) async fn connect_provider_client(
        &self,
        provider_id: &str,
        authorization_identity: crewon_provider_agent_platform::ProviderAuthorizationIdentity,
    ) -> Result<AgentPlatformProviderClient<Rs256ProviderAuthorizer>, AgentPlatformProviderError>
    {
        if provider_id != AGENT_PLATFORM_PROVIDER_ID {
            return Err(AgentPlatformProviderError::Incompatible);
        }
        self.connector
            .connect(Rs256ProviderAuthorizer::from_shared(
                self.signing_key.clone(),
                authorization_identity,
            ))
            .await
    }

    async fn connect_catalog_session(
        &self,
        request: ProviderDescriptorReadRequest,
    ) -> Result<AgentPlatformProviderResourceCatalog, ProviderDescriptorReadError> {
        let client = self
            .connect_provider_client(&request.provider_id, request.authorization_identity)
            .await
            .map_err(descriptor_error)?;
        let provider_descriptor = client.descriptor();
        let descriptor = LiveProviderDescriptor::new_agent_platform(
            provider_descriptor.provider().clone(),
            provider_descriptor.capabilities(),
            provider_descriptor.resource_capabilities().clone(),
        )?;
        Ok(AgentPlatformProviderResourceCatalog { client, descriptor })
    }
}

impl ProviderDescriptorReader for AgentPlatformProviderDescriptorFactory {
    async fn read_descriptor(
        &self,
        request: ProviderDescriptorReadRequest,
    ) -> Result<LiveProviderDescriptor, ProviderDescriptorReadError> {
        self.connect_catalog_session(request)
            .await
            .map(|catalog| catalog.descriptor)
    }
}

impl ProviderResourceCatalogFactory for AgentPlatformProviderDescriptorFactory {
    type Catalog = AgentPlatformProviderResourceCatalog;

    async fn connect_catalog(
        &self,
        request: ProviderDescriptorReadRequest,
    ) -> Result<Self::Catalog, ProviderDescriptorReadError> {
        self.connect_catalog_session(request).await
    }
}

pub(crate) struct AgentPlatformProviderResourceCatalog {
    client: AgentPlatformProviderClient<Rs256ProviderAuthorizer>,
    descriptor: LiveProviderDescriptor,
}

impl ProviderResourceCatalog for AgentPlatformProviderResourceCatalog {
    fn descriptor(&self) -> &LiveProviderDescriptor {
        &self.descriptor
    }

    async fn list_resources(
        &self,
        query: ResourceListQuery,
    ) -> Result<ResourcePage, ProviderError> {
        self.client.list_resources(query).await
    }

    async fn read_manifest(
        &self,
        resource: ResourceRef,
    ) -> Result<ResourceManifest, ProviderError> {
        self.client.read_manifest(resource).await
    }
}

impl AgentPlatformProviderResourceCatalog {
    pub(crate) async fn read_dynamic_manifest(
        &self,
        resource: ResourceRef,
    ) -> Result<AgentPlatformDynamicResourceManifest, AgentPlatformProviderError> {
        self.client.read_dynamic_manifest(resource).await
    }
}

impl std::fmt::Debug for AgentPlatformProviderDescriptorFactory {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("AgentPlatformProviderDescriptorFactory([REDACTED])")
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct SystemProviderConnectionClock;

impl ProviderConnectionClock for SystemProviderConnectionClock {
    fn now(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|duration| i64::try_from(duration.as_secs()).ok())
            .unwrap_or(-1)
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

fn configuration_error(error: AgentPlatformProviderError) -> io::Error {
    match error {
        AgentPlatformProviderError::Unavailable
        | AgentPlatformProviderError::Timeout
        | AgentPlatformProviderError::UnknownOutcome
        | AgentPlatformProviderError::RateLimited { .. } => unavailable_configuration(),
        AgentPlatformProviderError::InvalidRequest
        | AgentPlatformProviderError::Unauthorized
        | AgentPlatformProviderError::NotFound
        | AgentPlatformProviderError::Conflict
        | AgentPlatformProviderError::Incompatible
        | AgentPlatformProviderError::InvalidResponse => invalid_configuration(),
        _ => invalid_configuration(),
    }
}

fn descriptor_error(error: AgentPlatformProviderError) -> ProviderDescriptorReadError {
    match error {
        AgentPlatformProviderError::Unauthorized => ProviderDescriptorReadError::Unauthorized,
        AgentPlatformProviderError::Unavailable
        | AgentPlatformProviderError::Timeout
        | AgentPlatformProviderError::UnknownOutcome
        | AgentPlatformProviderError::RateLimited { .. } => {
            ProviderDescriptorReadError::Unavailable
        }
        AgentPlatformProviderError::Incompatible => ProviderDescriptorReadError::Incompatible,
        AgentPlatformProviderError::InvalidRequest
        | AgentPlatformProviderError::NotFound
        | AgentPlatformProviderError::Conflict
        | AgentPlatformProviderError::InvalidResponse => {
            ProviderDescriptorReadError::InvalidResponse
        }
        _ => ProviderDescriptorReadError::InvalidResponse,
    }
}

fn invalid_configuration() -> io::Error {
    io::Error::new(
        ErrorKind::InvalidInput,
        "Agent Platform Provider production configuration is invalid",
    )
}

fn unavailable_configuration() -> io::Error {
    io::Error::new(
        ErrorKind::ConnectionRefused,
        "Agent Platform Provider authority is unavailable",
    )
}
