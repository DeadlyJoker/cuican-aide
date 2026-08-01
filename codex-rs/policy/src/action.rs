use crewon_resource_federation::BindingId;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use crewon_resource_federation::WorkspaceKey;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de;
use serde_json::Value as JsonValue;

use crate::ActionDigest;
use crate::ArgumentsHash;
use crate::PolicyModelError;
use crate::canonical_json_string;
use crate::validate_opaque_text;

const ACTION_SCHEMA_VERSION: &str = "1";
const MAX_ID_BYTES: usize = 256;
const MAX_PURPOSE_BYTES: usize = 128;

macro_rules! bounded_text {
    ($(#[$meta:meta])* $name:ident, $field:literal, $max:expr) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, PolicyModelError> {
                let value = value.into();
                validate_opaque_text(&value, $field, $max)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Self::new(value).map_err(de::Error::custom)
            }
        }
    };
}

bounded_text!(
    /// Stable server-generated identifier for one policy evaluation.
    AccessDecisionId,
    "accessDecisionId",
    MAX_ID_BYTES
);
bounded_text!(
    /// Opaque single-use nonce bound into an action approval.
    ActionNonce,
    "nonce",
    MAX_ID_BYTES
);
bounded_text!(
    /// Bounded semantic purpose supplied to the server-side policy adapter.
    ActionPurpose,
    "purpose",
    MAX_PURPOSE_BYTES
);
bounded_text!(
    /// Opaque Tool or Provider operation identifier.
    ActionTargetId,
    "targetId",
    MAX_ID_BYTES
);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyActor {
    actor_id: String,
    tenant_id: Option<String>,
    space_id: Option<String>,
}

impl PolicyActor {
    pub fn user(actor_id: impl Into<String>) -> Result<Self, PolicyModelError> {
        Self::build(
            actor_id.into(),
            /*tenant_id*/ None,
            /*space_id*/ None,
        )
    }

    pub fn tenant_user(
        actor_id: impl Into<String>,
        tenant_id: impl Into<String>,
    ) -> Result<Self, PolicyModelError> {
        Self::build(
            actor_id.into(),
            Some(tenant_id.into()),
            /*space_id*/ None,
        )
    }

    pub fn space_user(
        actor_id: impl Into<String>,
        tenant_id: impl Into<String>,
        space_id: impl Into<String>,
    ) -> Result<Self, PolicyModelError> {
        Self::build(
            actor_id.into(),
            Some(tenant_id.into()),
            Some(space_id.into()),
        )
    }

    fn build(
        actor_id: String,
        tenant_id: Option<String>,
        space_id: Option<String>,
    ) -> Result<Self, PolicyModelError> {
        validate_opaque_text(&actor_id, "actorId", MAX_ID_BYTES)?;
        if let Some(tenant_id) = tenant_id.as_deref() {
            validate_opaque_text(tenant_id, "tenantId", MAX_ID_BYTES)?;
        }
        if let Some(space_id) = space_id.as_deref() {
            validate_opaque_text(space_id, "spaceId", MAX_ID_BYTES)?;
            if tenant_id.is_none() {
                return Err(PolicyModelError::invalid("spaceId"));
            }
        }
        Ok(Self {
            actor_id,
            tenant_id,
            space_id,
        })
    }

    pub fn actor_id(&self) -> &str {
        &self.actor_id
    }

    pub fn tenant_id(&self) -> Option<&str> {
        self.tenant_id.as_deref()
    }

    pub fn space_id(&self) -> Option<&str> {
        self.space_id.as_deref()
    }
}

impl<'de> Deserialize<'de> for PolicyActor {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            actor_id: String,
            tenant_id: Option<String>,
            space_id: Option<String>,
        }

        let wire = Wire::deserialize(deserializer)?;
        Self::build(wire.actor_id, wire.tenant_id, wire.space_id).map_err(de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceScopeKind {
    Conversation,
    Office,
    Workflow,
    Automation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionWorkspace {
    workspace_key: WorkspaceKey,
    binding_id: String,
    scope: WorkspaceScopeKind,
    scope_id: String,
    node_id: String,
    environment_id: String,
}

impl ActionWorkspace {
    pub fn new(
        workspace_key: WorkspaceKey,
        binding_id: impl Into<String>,
        scope: WorkspaceScopeKind,
        scope_id: impl Into<String>,
        node_id: impl Into<String>,
        environment_id: impl Into<String>,
    ) -> Result<Self, PolicyModelError> {
        let binding_id = binding_id.into();
        let scope_id = scope_id.into();
        let node_id = node_id.into();
        let environment_id = environment_id.into();
        validate_opaque_text(&binding_id, "bindingId", MAX_ID_BYTES)?;
        validate_opaque_text(&scope_id, "scopeId", MAX_ID_BYTES)?;
        validate_opaque_text(&node_id, "nodeId", MAX_ID_BYTES)?;
        validate_opaque_text(&environment_id, "environmentId", MAX_ID_BYTES)?;
        Ok(Self {
            workspace_key,
            binding_id,
            scope,
            scope_id,
            node_id,
            environment_id,
        })
    }

    pub fn workspace_key(&self) -> &WorkspaceKey {
        &self.workspace_key
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionType {
    ToolCall,
    ProviderRun,
    ResourceOperation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ActionTarget {
    Tool {
        provider: ProviderRef,
        tool_id: ActionTargetId,
        revision: ResourceRevision,
    },
    Provider {
        provider: ProviderRef,
        operation_id: ActionTargetId,
    },
    Resource {
        binding_id: BindingId,
        resource: ResourceRef,
    },
}

impl ActionTarget {
    pub fn tool(
        provider: ProviderRef,
        tool_id: ActionTargetId,
        revision: ResourceRevision,
    ) -> Self {
        Self::Tool {
            provider,
            tool_id,
            revision,
        }
    }

    pub fn provider(provider: ProviderRef, operation_id: ActionTargetId) -> Self {
        Self::Provider {
            provider,
            operation_id,
        }
    }

    pub fn resource(binding_id: BindingId, resource: ResourceRef) -> Self {
        Self::Resource {
            binding_id,
            resource,
        }
    }

    fn matches_action_type(&self, action_type: ActionType) -> bool {
        matches!(
            (action_type, self),
            (ActionType::ToolCall, Self::Tool { .. })
                | (ActionType::ProviderRun, Self::Provider { .. })
                | (ActionType::ResourceOperation, Self::Resource { .. })
        )
    }

    fn provider_id(&self) -> &ProviderId {
        match self {
            Self::Tool { provider, .. } | Self::Provider { provider, .. } => &provider.provider_id,
            Self::Resource { resource, .. } => &resource.provider.provider_id,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialState {
    Available,
    Expired,
    Revoked,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "type", content = "at", rename_all = "camelCase")]
pub enum CredentialExpiry {
    Never,
    At(i64),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionCredentialRef {
    credential_id: String,
    provider_id: ProviderId,
    status: CredentialState,
    revision: u64,
    expiry: CredentialExpiry,
}

impl ActionCredentialRef {
    pub fn new(
        credential_id: impl Into<String>,
        provider_id: ProviderId,
        status: CredentialState,
        revision: u64,
        expiry: CredentialExpiry,
    ) -> Result<Self, PolicyModelError> {
        let credential_id = credential_id.into();
        validate_opaque_text(&credential_id, "credentialId", MAX_ID_BYTES)?;
        if revision == 0 || matches!(expiry, CredentialExpiry::At(value) if value <= 0) {
            return Err(PolicyModelError::invalid("credential"));
        }
        Ok(Self {
            credential_id,
            provider_id,
            status,
            revision,
            expiry,
        })
    }

    pub(crate) fn is_available_at(&self, now: i64) -> bool {
        self.status == CredentialState::Available
            && match self.expiry {
                CredentialExpiry::Never => true,
                CredentialExpiry::At(expires_at) => expires_at > now,
            }
    }

    fn provider_id(&self) -> &ProviderId {
        &self.provider_id
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", content = "reference", rename_all = "camelCase")]
pub enum CredentialBinding {
    None,
    Reference(ActionCredentialRef),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SideEffect {
    ReadOnly,
    LocalMutation,
    ExternalWrite,
    Send,
    Publish,
    Delete,
    Destructive,
}

#[derive(Debug, Clone)]
pub struct ActionIntentSpec {
    pub action_type: ActionType,
    pub actor: PolicyActor,
    pub purpose: ActionPurpose,
    pub workspace: ActionWorkspace,
    pub target: ActionTarget,
    pub arguments: JsonValue,
    pub credential: CredentialBinding,
    pub execution_location: ExecutionLocation,
    pub side_effect: SideEffect,
    pub expires_at: i64,
    pub nonce: ActionNonce,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionIntent {
    schema_version: &'static str,
    action_type: ActionType,
    actor: PolicyActor,
    purpose: ActionPurpose,
    workspace: ActionWorkspace,
    target: ActionTarget,
    arguments_hash: ArgumentsHash,
    credential: CredentialBinding,
    execution_location: ExecutionLocation,
    side_effect: SideEffect,
    expires_at: i64,
    nonce: ActionNonce,
}

impl ActionIntent {
    pub fn new(spec: ActionIntentSpec) -> Result<Self, PolicyModelError> {
        if spec.expires_at <= 0 {
            return Err(PolicyModelError::invalid("expiresAt"));
        }
        if !spec.target.matches_action_type(spec.action_type) {
            return Err(PolicyModelError::invalid("target"));
        }
        if let CredentialBinding::Reference(credential) = &spec.credential
            && credential.provider_id() != spec.target.provider_id()
        {
            return Err(PolicyModelError::invalid("credential.providerId"));
        }
        Ok(Self {
            schema_version: ACTION_SCHEMA_VERSION,
            action_type: spec.action_type,
            actor: spec.actor,
            purpose: spec.purpose,
            workspace: spec.workspace,
            target: spec.target,
            arguments_hash: ArgumentsHash::compute(&spec.arguments)?,
            credential: spec.credential,
            execution_location: spec.execution_location,
            side_effect: spec.side_effect,
            expires_at: spec.expires_at,
            nonce: spec.nonce,
        })
    }

    pub fn actor(&self) -> &PolicyActor {
        &self.actor
    }

    pub fn nonce(&self) -> &ActionNonce {
        &self.nonce
    }

    pub fn expires_at(&self) -> i64 {
        self.expires_at
    }

    pub fn side_effect(&self) -> SideEffect {
        self.side_effect
    }

    pub fn arguments_hash(&self) -> &ArgumentsHash {
        &self.arguments_hash
    }

    pub fn canonical_json(&self) -> Result<String, PolicyModelError> {
        canonical_json_string(self)
    }

    pub fn digest(&self) -> Result<ActionDigest, PolicyModelError> {
        ActionDigest::compute(self)
    }

    pub(crate) fn is_expired_at(&self, now: i64) -> bool {
        now < 0 || self.expires_at <= now
    }

    pub(crate) fn credential_is_available_at(&self, now: i64) -> bool {
        match &self.credential {
            CredentialBinding::None => true,
            CredentialBinding::Reference(reference) => reference.is_available_at(now),
        }
    }
}
