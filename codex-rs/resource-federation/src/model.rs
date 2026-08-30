use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de;
use serde::de::SeqAccess;
use serde::de::Visitor;
use std::collections::BTreeSet;
use std::fmt;
use std::marker::PhantomData;

/// Maximum number of resource binding capabilities accepted from one Provider.
pub const MAX_PROVIDER_CAPABILITIES: usize = 64;

const MAX_PROVIDER_ID_BYTES: usize = 256;
const MAX_RESOURCE_ID_BYTES: usize = 512;
const MAX_REVISION_BYTES: usize = 256;
const MAX_BINDING_ID_BYTES: usize = 256;
const MAX_WORKSPACE_KEY_BYTES: usize = 512;
const MAX_VERSION_BYTES: usize = 64;
const MAX_CURSOR_BYTES: usize = 1_024;

/// Classification for bounded resource model validation failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelErrorKind {
    Empty,
    TooLong,
    ControlCharacter,
    InvalidDigest,
    OutOfRange,
    TooManyItems,
}

/// Validation error that never echoes rejected Provider-controlled input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelError {
    field: &'static str,
    kind: ModelErrorKind,
}

impl ModelError {
    pub(crate) fn out_of_range(field: &'static str) -> Self {
        Self {
            field,
            kind: ModelErrorKind::OutOfRange,
        }
    }

    pub(crate) fn too_many_items(field: &'static str) -> Self {
        Self {
            field,
            kind: ModelErrorKind::TooManyItems,
        }
    }

    /// Returns the field whose value failed validation.
    pub fn field(&self) -> &'static str {
        self.field
    }

    /// Returns the stable failure classification without rejected input.
    pub fn kind(&self) -> ModelErrorKind {
        self.kind
    }
}

impl fmt::Display for ModelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid resource federation field {}: {:?}",
            self.field, self.kind
        )
    }
}

impl std::error::Error for ModelError {}

macro_rules! bounded_text {
    ($(#[$meta:meta])* $name:ident, $field:literal, $max:expr) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Constructs a validated opaque value.
            pub fn new(value: impl Into<String>) -> Result<Self, ModelError> {
                let value = value.into();
                validate_bounded_text(&value, $field, $max)?;
                Ok(Self(value))
            }

            /// Returns the validated opaque value.
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                self.as_str()
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
    /// Opaque stable identifier for a resource Provider.
    ProviderId,
    "providerId",
    MAX_PROVIDER_ID_BYTES
);
bounded_text!(
    /// Opaque stable identifier assigned by a resource Provider.
    ResourceId,
    "resourceId",
    MAX_RESOURCE_ID_BYTES
);
bounded_text!(
    /// Exact immutable Provider revision or locally pinned fork revision.
    ResourceRevision,
    "revision",
    MAX_REVISION_BYTES
);
bounded_text!(
    /// Opaque identifier for one resolved resource binding.
    BindingId,
    "bindingId",
    MAX_BINDING_ID_BYTES
);
bounded_text!(
    /// Stable workspace registry key that owns a binding.
    WorkspaceKey,
    "workspaceKey",
    MAX_WORKSPACE_KEY_BYTES
);
bounded_text!(
    /// Version of the Provider federation protocol used by an adapter.
    ProviderProtocolVersion,
    "protocolVersion",
    MAX_VERSION_BYTES
);
bounded_text!(
    /// Version of the resource manifest schema used for a resolved binding.
    ManifestSchemaVersion,
    "schemaVersion",
    MAX_VERSION_BYTES
);
bounded_text!(
    /// Opaque bounded cursor returned by a catalog Provider.
    PageCursor,
    "cursor",
    MAX_CURSOR_BYTES
);

/// Canonical SHA-256 digest for immutable resource content.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ContentDigest(String);

impl ContentDigest {
    /// Parses a canonical `sha256:<64 lowercase hex>` digest.
    pub fn new(value: impl Into<String>) -> Result<Self, ModelError> {
        let value = value.into();
        let Some(hex) = value.strip_prefix("sha256:") else {
            return Err(ModelError {
                field: "contentDigest",
                kind: ModelErrorKind::InvalidDigest,
            });
        };
        if hex.len() != 64
            || !hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(ModelError {
                field: "contentDigest",
                kind: ModelErrorKind::InvalidDigest,
            });
        }
        Ok(Self(value))
    }

    /// Returns the canonical digest text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl AsRef<str> for ContentDigest {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl<'de> Deserialize<'de> for ContentDigest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

/// Closed set of resource kinds supported by the first federation contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourceKind {
    Agent,
    Skill,
    McpServer,
    McpTool,
    KnowledgeBase,
    Workflow,
}

/// How CrewON binds a versioned resource into a task contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BindingMode {
    RemoteReference,
    LocalSnapshot,
    LocalFork,
    ProviderManaged,
}

/// Runtime location at which the bound resource is actually executed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionLocation {
    LocalNode,
    Provider,
}

/// Versioned identity of a resource catalog Provider.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRef {
    pub provider_id: ProviderId,
    pub protocol_version: ProviderProtocolVersion,
}

/// Exact Provider-owned resource revision; never means latest or compatible.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceRef {
    pub provider: ProviderRef,
    pub kind: ResourceKind,
    pub resource_id: ResourceId,
    pub revision: ResourceRevision,
}

/// Versioned resource manifest returned by a catalog Provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceManifest {
    pub resource: ResourceRef,
    pub schema_version: ManifestSchemaVersion,
    pub content_digest: Option<ContentDigest>,
}

/// One exact Provider-supported resource binding combination.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capability {
    pub resource_kind: ResourceKind,
    pub binding_mode: BindingMode,
    pub execution_location: ExecutionLocation,
}

/// Bounded capability snapshot for one exact Provider protocol version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    provider: ProviderRef,
    capabilities: BTreeSet<Capability>,
}

impl ProviderCapabilities {
    /// Builds a bounded, de-duplicated capability snapshot.
    pub fn new(
        provider: ProviderRef,
        capabilities: impl IntoIterator<Item = Capability>,
    ) -> Result<Self, ModelError> {
        let mut bounded = BTreeSet::new();
        for (index, capability) in capabilities.into_iter().enumerate() {
            if index >= MAX_PROVIDER_CAPABILITIES {
                return Err(ModelError::too_many_items("capabilities"));
            }
            bounded.insert(capability);
        }
        Ok(Self {
            provider,
            capabilities: bounded,
        })
    }

    /// Returns whether the Provider explicitly supports the exact combination.
    pub fn contains(&self, capability: &Capability) -> bool {
        self.capabilities.contains(capability)
    }

    /// Returns the exact Provider version that advertised this snapshot.
    pub fn provider(&self) -> &ProviderRef {
        &self.provider
    }

    /// Iterates over the stable, de-duplicated capability snapshot.
    pub fn iter(&self) -> impl Iterator<Item = &Capability> {
        self.capabilities.iter()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderCapabilitiesWire {
    provider: ProviderRef,
    capabilities: BoundedVec<Capability, MAX_PROVIDER_CAPABILITIES>,
}

impl<'de> Deserialize<'de> for ProviderCapabilities {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = ProviderCapabilitiesWire::deserialize(deserializer)?;
        Self::new(wire.provider, wire.capabilities.into_inner()).map_err(de::Error::custom)
    }
}

pub(crate) struct BoundedVec<T, const MAX: usize>(Vec<T>);

impl<T, const MAX: usize> BoundedVec<T, MAX> {
    pub(crate) fn into_inner(self) -> Vec<T> {
        self.0
    }
}

impl<'de, T, const MAX: usize> Deserialize<'de> for BoundedVec<T, MAX>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct BoundedVecVisitor<T, const MAX: usize>(PhantomData<T>);

        impl<'de, T, const MAX: usize> Visitor<'de> for BoundedVecVisitor<T, MAX>
        where
            T: Deserialize<'de>,
        {
            type Value = BoundedVec<T, MAX>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(formatter, "a sequence with at most {MAX} items")
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let capacity = sequence.size_hint().unwrap_or_default().min(MAX);
                let mut values = Vec::with_capacity(capacity);
                while let Some(value) = sequence.next_element()? {
                    if values.len() == MAX {
                        return Err(de::Error::custom("bounded sequence exceeds item limit"));
                    }
                    values.push(value);
                }
                Ok(BoundedVec(values))
            }
        }

        deserializer.deserialize_seq(BoundedVecVisitor::<T, MAX>(PhantomData))
    }
}

fn validate_bounded_text(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), ModelError> {
    let kind = if value.trim().is_empty() {
        Some(ModelErrorKind::Empty)
    } else if value.len() > max_bytes {
        Some(ModelErrorKind::TooLong)
    } else if value.chars().any(char::is_control) {
        Some(ModelErrorKind::ControlCharacter)
    } else {
        None
    };

    if let Some(kind) = kind {
        return Err(ModelError { field, kind });
    }
    Ok(())
}
