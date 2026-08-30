//! Strict Agent Platform Provider v3 adapter.
//!
//! This crate maps authenticated Agent Platform HTTP responses into Provider domain contracts. It
//! does not own Task state, retries, credentials, workspace identity, or UI state.

mod authorization;
mod catalog;
mod dynamic_artifact_client;
mod dynamic_artifact_model;
mod dynamic_artifact_wire;
mod dynamic_execution_client;
mod dynamic_execution_model;
mod dynamic_execution_wire;
mod dynamic_manifest;
mod dynamic_manifest_wire;
mod error;
mod http_client;
mod identity_source;
mod identity_source_authorization;
mod identity_source_client;
mod identity_source_rs256_authorizer;
mod principal_session_client;
mod principal_session_source;
mod rs256_authorizer;
mod rs256_dynamic_authorizer;
mod run_artifact;
mod run_artifact_wire;
mod run_client;
mod run_event;
mod run_event_wire;
mod run_model;
mod run_wire;
mod wire;

pub use authorization::DelegationToken;
pub use authorization::DiscoveryAuthorizationOperation;
pub use authorization::DynamicAuthorizationOperation;
pub use authorization::ProviderAuthorizationError;
pub use authorization::ProviderAuthorizationHeaders;
pub use authorization::ProviderAuthorizationRequest;
pub use authorization::ProviderAuthorizer;
pub use authorization::ProviderDynamicAuthorizationBinding;
pub use authorization::ProviderRunAuthorizationBinding;
pub use authorization::RunAuthorizationOperation;
pub use authorization::ServiceBearerToken;
pub use catalog::AgentPlatformProviderClient;
pub use catalog::AgentPlatformProviderConnector;
pub use catalog::AgentPlatformProviderDescriptor;
pub use dynamic_artifact_client::ProviderDynamicArtifactClient;
pub use dynamic_artifact_model::ProviderDynamicArtifactContent;
pub use dynamic_artifact_model::ProviderDynamicArtifactReadRequest;
pub use dynamic_execution_client::ProviderDynamicExecutionClient;
pub use dynamic_execution_model::ProviderDynamicArtifactRef;
pub use dynamic_execution_model::ProviderDynamicExecutionFailure;
pub use dynamic_execution_model::ProviderDynamicExecutionOutcome;
pub use dynamic_execution_model::ProviderDynamicExecutionRequest;
pub use dynamic_execution_model::ProviderDynamicExecutionSuccess;
pub use dynamic_execution_model::ProviderDynamicExecutionUnknown;
pub use dynamic_execution_model::ProviderDynamicResult;
pub use dynamic_manifest::AgentPlatformDynamicResourceManifest;
pub use dynamic_manifest::ProviderDynamicOperation;
pub use dynamic_manifest::ProviderDynamicSideEffect;
pub use error::AgentPlatformProviderError;
pub use identity_source::ProviderIdentitySourceBinding;
pub use identity_source::ProviderIdentitySourceError;
pub use identity_source::ProviderIdentitySourceSnapshot;
pub use identity_source::ProviderIdentitySourceStatus;
pub use identity_source_authorization::IdentitySourceAuthorizationError;
pub use identity_source_authorization::IdentitySourceAuthorizationHeaders;
pub use identity_source_authorization::IdentitySourceAuthorizationRequest;
pub use identity_source_authorization::IdentitySourceAuthorizer;
pub use identity_source_authorization::IdentitySourcePrincipalAssertion;
pub use identity_source_authorization::IdentitySourceServiceToken;
pub use identity_source_authorization::ProviderIdentitySourceOwner;
pub use identity_source_client::AgentPlatformIdentitySourceClient;
pub use identity_source_client::AgentPlatformIdentitySourceConnector;
pub use identity_source_rs256_authorizer::IdentitySourceBootstrapRs256Verifier;
pub use identity_source_rs256_authorizer::IdentitySourceRs256ConfigurationError;
pub use identity_source_rs256_authorizer::IdentitySourceRs256SigningKey;
pub use identity_source_rs256_authorizer::Rs256IdentitySourceAuthorizer;
pub use identity_source_rs256_authorizer::VerifiedBootstrapPrincipal;
pub use principal_session_source::PrincipalRevocation;
pub use principal_session_source::PrincipalRevocationCursor;
pub use principal_session_source::PrincipalRevocationCursorSpec;
pub use principal_session_source::PrincipalRevocationReadPage;
pub use principal_session_source::PrincipalRevocationSnapshotPage;
pub use principal_session_source::PrincipalRevocationSpec;
pub use principal_session_source::PrincipalSessionIssued;
pub use principal_session_source::PrincipalSessionToken;
pub use rs256_authorizer::ProviderAuthorizationConfigurationError;
pub use rs256_authorizer::ProviderAuthorizationIdentity;
pub use rs256_authorizer::ProviderAuthorizationIdentitySpec;
pub use rs256_authorizer::ProviderRs256SigningKey;
pub use rs256_authorizer::Rs256ProviderAuthorizer;
pub use run_artifact::ProviderArtifactMediaType;
pub use run_artifact::ProviderArtifactSensitivity;
pub use run_artifact::ProviderRunArtifactClient;
pub use run_artifact::ProviderRunArtifactContent;
pub use run_artifact::ProviderRunArtifactImportInput;
pub use run_artifact::ProviderRunArtifactImportRequest;
pub use run_artifact::ProviderRunArtifactImportResult;
pub use run_artifact::ProviderRunArtifactReadRequest;
pub use run_client::DurableProviderRunClient;
pub use run_event::ProviderRunEvent;
pub use run_event::ProviderRunEventMetadata;
pub use run_event::ProviderRunEventPage;
pub use run_event::ProviderRunEventPayload;
pub use run_event::ProviderRunFailure;
pub use run_event::ProviderRunFailureCode;
pub use run_model::ProviderArtifactKind;
pub use run_model::ProviderArtifactRef;
pub use run_model::ProviderArtifactRetention;
pub use run_model::ProviderRunCancelRequest;
pub use run_model::ProviderRunCancelResult;
pub use run_model::ProviderRunCancelStatus;
pub use run_model::ProviderRunEventsRequest;
pub use run_model::ProviderRunReadRequest;
pub use run_model::ProviderRunSnapshot;
pub use run_model::ProviderRunStartRequest;
pub use run_model::ProviderRunStartResult;
pub use run_model::ProviderRunStatus;
pub use wire::AgentPlatformCapability;

#[cfg(test)]
#[path = "identity_source_tests.rs"]
mod identity_source_tests;

#[cfg(test)]
#[path = "identity_source_client_tests.rs"]
mod identity_source_client_tests;

#[cfg(test)]
#[path = "identity_source_rs256_authorizer_tests.rs"]
mod identity_source_rs256_authorizer_tests;

#[cfg(test)]
#[path = "rs256_authorizer_tests.rs"]
mod rs256_authorizer_tests;

#[cfg(test)]
#[path = "run_artifact_tests.rs"]
mod run_artifact_tests;
