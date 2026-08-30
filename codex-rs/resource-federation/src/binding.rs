use crate::BindingId;
use crate::BindingMode;
use crate::Capability;
use crate::ContentDigest;
use crate::ExecutionLocation;
use crate::ManifestSchemaVersion;
use crate::ProviderCapabilities;
use crate::ResourceManifest;
use crate::ResourceRef;
use crate::ResourceRevision;
use crate::WorkspaceKey;
use serde::Deserialize;
use serde::Serialize;

/// Provenance and pinned content identity for a local resource materialization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalMaterialization {
    pub source_revision: ResourceRevision,
    pub source_digest: ContentDigest,
    pub local_revision: ResourceRevision,
    pub content_digest: ContentDigest,
}

/// Requested resource binding before federation validation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingRequest {
    pub binding_id: BindingId,
    pub workspace_key: WorkspaceKey,
    pub resource: ResourceRef,
    pub mode: BindingMode,
    pub execution_location: ExecutionLocation,
    pub materialization: Option<LocalMaterialization>,
}

/// Serialized form of a resolved binding that must be revalidated on restore.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedResourceBindingSnapshot {
    pub binding_id: BindingId,
    pub workspace_key: WorkspaceKey,
    pub resource: ResourceRef,
    pub mode: BindingMode,
    pub execution_location: ExecutionLocation,
    pub manifest_schema_version: ManifestSchemaVersion,
    pub content_digest: Option<ContentDigest>,
    pub capability: Capability,
    pub materialization: Option<LocalMaterialization>,
}

/// Immutable version and capability snapshot safe to place in a Task contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[non_exhaustive]
pub struct ResolvedResourceBinding {
    pub(crate) binding_id: BindingId,
    pub(crate) workspace_key: WorkspaceKey,
    pub(crate) resource: ResourceRef,
    pub(crate) mode: BindingMode,
    pub(crate) execution_location: ExecutionLocation,
    pub(crate) manifest_schema_version: ManifestSchemaVersion,
    pub(crate) content_digest: Option<ContentDigest>,
    pub(crate) capability: Capability,
    pub(crate) materialization: Option<LocalMaterialization>,
}

impl ResolvedResourceBinding {
    /// Produces a persistence DTO that contains every pinned binding invariant.
    pub fn to_snapshot(&self) -> ResolvedResourceBindingSnapshot {
        ResolvedResourceBindingSnapshot {
            binding_id: self.binding_id.clone(),
            workspace_key: self.workspace_key.clone(),
            resource: self.resource.clone(),
            mode: self.mode,
            execution_location: self.execution_location,
            manifest_schema_version: self.manifest_schema_version.clone(),
            content_digest: self.content_digest.clone(),
            capability: self.capability,
            materialization: self.materialization.clone(),
        }
    }

    /// Restores a persisted binding only after replaying federation validation.
    pub fn restore(snapshot: ResolvedResourceBindingSnapshot) -> Result<Self, BindingError> {
        let expected_capability = Capability {
            resource_kind: snapshot.resource.kind,
            binding_mode: snapshot.mode,
            execution_location: snapshot.execution_location,
        };
        if snapshot.capability != expected_capability {
            return Err(BindingError::SnapshotCapabilityMismatch);
        }

        let request = BindingRequest {
            binding_id: snapshot.binding_id,
            workspace_key: snapshot.workspace_key,
            resource: snapshot.resource.clone(),
            mode: snapshot.mode,
            execution_location: snapshot.execution_location,
            materialization: snapshot.materialization,
        };
        let manifest = ResourceManifest {
            resource: snapshot.resource.clone(),
            schema_version: snapshot.manifest_schema_version,
            content_digest: snapshot.content_digest,
        };
        let capabilities =
            ProviderCapabilities::new(snapshot.resource.provider, [snapshot.capability])
                .map_err(|_| BindingError::SnapshotCapabilityMismatch)?;

        resolve_binding(&request, &manifest, &capabilities)
    }

    /// Returns the stable binding identifier.
    pub fn binding_id(&self) -> &BindingId {
        &self.binding_id
    }

    /// Returns the workspace registry key that owns the binding.
    pub fn workspace_key(&self) -> &WorkspaceKey {
        &self.workspace_key
    }

    /// Returns the exact Provider resource revision.
    pub fn resource(&self) -> &ResourceRef {
        &self.resource
    }

    /// Returns how CrewON holds the resource.
    pub fn mode(&self) -> BindingMode {
        self.mode
    }

    /// Returns where the resource is executed.
    pub fn execution_location(&self) -> ExecutionLocation {
        self.execution_location
    }

    /// Returns the manifest schema version used during resolution.
    pub fn manifest_schema_version(&self) -> &ManifestSchemaVersion {
        &self.manifest_schema_version
    }

    /// Returns the Provider content digest when the manifest supplied one.
    pub fn content_digest(&self) -> Option<&ContentDigest> {
        self.content_digest.as_ref()
    }

    /// Returns the exact Provider capability that authorized this binding.
    pub fn capability(&self) -> Capability {
        self.capability
    }

    /// Returns the pinned local materialization for local binding modes.
    pub fn materialization(&self) -> Option<&LocalMaterialization> {
        self.materialization.as_ref()
    }
}

/// Closed failure set for deterministic, fail-closed binding resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindingError {
    ResourceProviderMismatch,
    ResourceIdentityMismatch,
    RevisionMismatch,
    CapabilityProviderMismatch,
    ExecutionLocationNotAllowed,
    CapabilityNotSupported,
    MaterializationRequired,
    UnexpectedMaterialization,
    ManifestDigestRequired,
    SnapshotVerificationFailed,
    ForkProvenanceMismatch,
    SnapshotCapabilityMismatch,
}

/// Resolves one exact resource binding without performing I/O or access checks.
pub fn resolve_binding(
    request: &BindingRequest,
    manifest: &ResourceManifest,
    capabilities: &ProviderCapabilities,
) -> Result<ResolvedResourceBinding, BindingError> {
    if request.resource.provider != manifest.resource.provider {
        return Err(BindingError::ResourceProviderMismatch);
    }
    if request.resource.kind != manifest.resource.kind
        || request.resource.resource_id != manifest.resource.resource_id
    {
        return Err(BindingError::ResourceIdentityMismatch);
    }
    if request.resource.revision != manifest.resource.revision {
        return Err(BindingError::RevisionMismatch);
    }
    if capabilities.provider() != &request.resource.provider {
        return Err(BindingError::CapabilityProviderMismatch);
    }

    let allowed_location = match request.mode {
        BindingMode::RemoteReference | BindingMode::ProviderManaged => ExecutionLocation::Provider,
        BindingMode::LocalSnapshot | BindingMode::LocalFork => ExecutionLocation::LocalNode,
    };
    if request.execution_location != allowed_location {
        return Err(BindingError::ExecutionLocationNotAllowed);
    }

    let capability = Capability {
        resource_kind: request.resource.kind,
        binding_mode: request.mode,
        execution_location: request.execution_location,
    };
    if !capabilities.contains(&capability) {
        return Err(BindingError::CapabilityNotSupported);
    }

    validate_materialization(request, manifest)?;

    Ok(ResolvedResourceBinding {
        binding_id: request.binding_id.clone(),
        workspace_key: request.workspace_key.clone(),
        resource: request.resource.clone(),
        mode: request.mode,
        execution_location: request.execution_location,
        manifest_schema_version: manifest.schema_version.clone(),
        content_digest: manifest.content_digest.clone(),
        capability,
        materialization: request.materialization.clone(),
    })
}

fn validate_materialization(
    request: &BindingRequest,
    manifest: &ResourceManifest,
) -> Result<(), BindingError> {
    match request.mode {
        BindingMode::RemoteReference | BindingMode::ProviderManaged => {
            if request.materialization.is_some() {
                Err(BindingError::UnexpectedMaterialization)
            } else {
                Ok(())
            }
        }
        BindingMode::LocalSnapshot => {
            let materialization = request
                .materialization
                .as_ref()
                .ok_or(BindingError::MaterializationRequired)?;
            let manifest_digest = manifest
                .content_digest
                .as_ref()
                .ok_or(BindingError::ManifestDigestRequired)?;
            if materialization.source_revision != request.resource.revision
                || materialization.source_digest != *manifest_digest
                || materialization.local_revision != request.resource.revision
                || materialization.content_digest != *manifest_digest
            {
                return Err(BindingError::SnapshotVerificationFailed);
            }
            Ok(())
        }
        BindingMode::LocalFork => {
            let materialization = request
                .materialization
                .as_ref()
                .ok_or(BindingError::MaterializationRequired)?;
            let manifest_digest = manifest
                .content_digest
                .as_ref()
                .ok_or(BindingError::ManifestDigestRequired)?;
            if materialization.source_revision != request.resource.revision
                || materialization.source_digest != *manifest_digest
            {
                return Err(BindingError::ForkProvenanceMismatch);
            }
            Ok(())
        }
    }
}
