mod catalog;
mod catalog_io;
mod catalog_migration;
mod catalog_transition;
mod catalog_validation;
mod catalog_values;
mod lease;
mod material;
mod payload;
mod runtime_route;
mod session;

#[allow(unused_imports)]
pub(crate) use catalog::DesktopWorkspaceAuthority;
#[allow(unused_imports)]
pub(crate) use catalog::DesktopWorkspaceAuthorityManager;
#[allow(unused_imports)]
pub(crate) use catalog::WorkspaceAuthorityIntent;
#[allow(unused_imports)]
pub(crate) use catalog::WorkspaceAuthorityIntentReplay;
#[allow(unused_imports)]
pub(crate) use catalog::WorkspaceAuthorityPrepareResult;
#[allow(unused_imports)]
pub(crate) use catalog::WorkspaceSelectionBeginResult;
pub(crate) use catalog::MAX_SAFE_REVISION;
pub(crate) use catalog_io::prepare_authority_directory as prepare_private_directory;
pub(crate) use catalog_values::valid_id;
pub(crate) use lease::WorkspaceAuthorityLease;
use material::WorkspaceLaunchMaterial;
#[allow(unused_imports)]
pub(crate) use payload::GatewayReadyAddress;
#[allow(unused_imports)]
pub(crate) use payload::WorkspaceGatewayLaunchPayloads;
#[allow(unused_imports)]
pub(crate) use payload::WorkspaceLaunchPayloads;
#[allow(unused_imports)]
pub(crate) use payload::WorkspacePayloadConfig;
pub(crate) use runtime_route::RuntimeRouteProjection;
#[allow(unused_imports)]
pub(crate) use session::WorkspaceNativeLaunchSession;

const STANDALONE_TENANT_ID: &str = "standalone-tenant";
const STANDALONE_SPACE_ID: &str = "standalone-space";
const STANDALONE_POLICY_SNAPSHOT_ID: &str = "standalone-policy-v0";

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkspaceNativeError {
    AuthorityInvalid,
    AuthorityConflict,
    AuthorityRecoveryRequired,
    AuthorityUnavailable,
    AuthorityMutationUnknown,
    MaterialGenerationFailed,
    PayloadInvalid,
}

impl WorkspaceNativeError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::AuthorityInvalid => "desktop_workspace_authority_invalid",
            Self::AuthorityConflict => "desktop_workspace_authority_conflict",
            Self::AuthorityRecoveryRequired => "desktop_workspace_authority_recovery_required",
            Self::AuthorityUnavailable => "desktop_workspace_authority_unavailable",
            Self::AuthorityMutationUnknown => "desktop_workspace_authority_mutation_unknown",
            Self::MaterialGenerationFailed => "desktop_workspace_material_generation_failed",
            Self::PayloadInvalid => "desktop_workspace_payload_invalid",
        }
    }
}

impl std::fmt::Debug for WorkspaceNativeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::fmt::Display for WorkspaceNativeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for WorkspaceNativeError {}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod catalog_tests;

#[cfg(test)]
#[path = "catalog_migration_tests.rs"]
mod catalog_migration_tests;

#[cfg(test)]
#[path = "material_tests.rs"]
mod material_tests;

#[cfg(test)]
#[path = "payload_tests.rs"]
mod payload_tests;

#[cfg(test)]
#[path = "runtime_route_tests.rs"]
mod runtime_route_tests;
