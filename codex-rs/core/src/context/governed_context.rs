use super::ContextualUserFragment;
use crewon_protocol::protocol::AdditionalContextKind;
use crewon_utils_string::approx_bytes_for_tokens;
use crewon_utils_string::approx_token_count;
use crewon_utils_string::truncate_middle_chars;
use serde::Serialize;
use std::fmt;

const CONTEXT_START_MARKER: &str = "<crewon_governed_context>";
const CONTEXT_END_MARKER: &str = "</crewon_governed_context>";
const MIN_FRAGMENT_TOKENS: usize = 128;
/// Maximum model-visible size of one governed fragment, below the 1K P0 threshold.
pub const MAX_GOVERNED_CONTEXT_FRAGMENT_TOKENS: usize = 900;
const MAX_FRAGMENT_ID_BYTES: usize = 32;
const MAX_BINDING_ID_BYTES: usize = 64;
const MAX_SCOPE_ID_BYTES: usize = 128;
const MAX_MEMBER_ID_BYTES: usize = 128;
const MAX_SOURCE_ID_BYTES: usize = 128;
const MAX_ACTOR_ID_BYTES: usize = 256;

/// Consumer boundary that owns one model-visible context fragment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ContextAudienceKind {
    Single,
    Experts,
    OfficeShared,
    OfficeMemberPrivate,
}

/// Opaque workspace binding and collaboration scope for context isolation.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextAudience {
    kind: ContextAudienceKind,
    workspace_binding_id: String,
    scope_id: String,
    member_id: Option<String>,
}

impl ContextAudience {
    pub fn single(
        workspace_binding_id: impl Into<String>,
        scope_id: impl Into<String>,
    ) -> Result<Self, GovernedContextError> {
        Self::build(
            ContextAudienceKind::Single,
            workspace_binding_id,
            scope_id,
            None,
        )
    }

    pub fn experts(
        workspace_binding_id: impl Into<String>,
        scope_id: impl Into<String>,
    ) -> Result<Self, GovernedContextError> {
        Self::build(
            ContextAudienceKind::Experts,
            workspace_binding_id,
            scope_id,
            None,
        )
    }

    pub fn office_shared(
        workspace_binding_id: impl Into<String>,
        scope_id: impl Into<String>,
    ) -> Result<Self, GovernedContextError> {
        Self::build(
            ContextAudienceKind::OfficeShared,
            workspace_binding_id,
            scope_id,
            None,
        )
    }

    pub fn office_member_private(
        workspace_binding_id: impl Into<String>,
        scope_id: impl Into<String>,
        member_id: impl Into<String>,
    ) -> Result<Self, GovernedContextError> {
        Self::build(
            ContextAudienceKind::OfficeMemberPrivate,
            workspace_binding_id,
            scope_id,
            Some(member_id.into()),
        )
    }

    fn build(
        kind: ContextAudienceKind,
        workspace_binding_id: impl Into<String>,
        scope_id: impl Into<String>,
        member_id: Option<String>,
    ) -> Result<Self, GovernedContextError> {
        let workspace_binding_id = workspace_binding_id.into();
        let scope_id = scope_id.into();
        validate_opaque_id(
            &workspace_binding_id,
            "workspaceBindingId",
            MAX_BINDING_ID_BYTES,
        )?;
        validate_opaque_id(&scope_id, "scopeId", MAX_SCOPE_ID_BYTES)?;
        if let Some(member_id) = member_id.as_deref() {
            validate_opaque_id(member_id, "memberId", MAX_MEMBER_ID_BYTES)?;
        }
        Ok(Self {
            kind,
            workspace_binding_id,
            scope_id,
            member_id,
        })
    }

    pub fn kind(&self) -> ContextAudienceKind {
        self.kind
    }

    pub fn workspace_binding_id(&self) -> &str {
        &self.workspace_binding_id
    }

    pub fn scope_id(&self) -> &str {
        &self.scope_id
    }

    pub fn member_id(&self) -> Option<&str> {
        self.member_id.as_deref()
    }
}

/// Origin class used to prevent data sources from escalating instruction priority.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ContextSourceKind {
    Application,
    User,
    Tool,
    Provider,
    Knowledge,
    Memory,
    WorkspaceFile,
}

/// Instruction priority allowed for a context source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ContextTrust {
    TrustedApplication,
    UntrustedData,
}

/// Data sensitivity allowed to enter model-visible context.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ContextSensitivity {
    Public,
    Internal,
    WorkspaceSensitive,
    Secret,
}

/// Why a bounded fragment is needed by the current model turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ContextPurpose {
    TaskInput,
    Coordination,
    MemoryRetrieval,
    ToolResult,
    ResourceContext,
}

/// Auditable source identity for one context fragment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextProvenance {
    source_kind: ContextSourceKind,
    source_id: String,
    actor_id: String,
}

impl ContextProvenance {
    pub fn new(
        source_kind: ContextSourceKind,
        source_id: impl Into<String>,
        actor_id: impl Into<String>,
    ) -> Result<Self, GovernedContextError> {
        let source_id = source_id.into();
        let actor_id = actor_id.into();
        validate_text(&source_id, "sourceId", MAX_SOURCE_ID_BYTES)?;
        validate_text(&actor_id, "actorId", MAX_ACTOR_ID_BYTES)?;
        Ok(Self {
            source_kind,
            source_id,
            actor_id,
        })
    }

    pub fn source_kind(&self) -> ContextSourceKind {
        self.source_kind
    }
}

/// Point-in-time validity of a fragment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextFreshness {
    observed_at: i64,
    expires_at: Option<i64>,
}

impl ContextFreshness {
    pub fn current(observed_at: i64) -> Result<Self, GovernedContextError> {
        Self::build(observed_at, None)
    }

    pub fn expiring(observed_at: i64, expires_at: i64) -> Result<Self, GovernedContextError> {
        Self::build(observed_at, Some(expires_at))
    }

    fn build(observed_at: i64, expires_at: Option<i64>) -> Result<Self, GovernedContextError> {
        if observed_at < 0 || expires_at.is_some_and(|expires_at| expires_at < observed_at) {
            return Err(GovernedContextError::InvalidFreshness);
        }
        Ok(Self {
            observed_at,
            expires_at,
        })
    }
}

/// Per-fragment approximate token budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBudget {
    token_cap: usize,
}

impl ContextBudget {
    pub fn new(token_cap: usize) -> Result<Self, GovernedContextError> {
        if !(MIN_FRAGMENT_TOKENS..=MAX_GOVERNED_CONTEXT_FRAGMENT_TOKENS).contains(&token_cap) {
            return Err(GovernedContextError::InvalidBudget);
        }
        Ok(Self { token_cap })
    }
}

/// Validated input for one governed model-context fragment.
pub struct GovernedContextSpec {
    pub fragment_id: String,
    pub audience: ContextAudience,
    pub provenance: ContextProvenance,
    pub trust: ContextTrust,
    pub sensitivity: ContextSensitivity,
    pub purpose: ContextPurpose,
    pub budget: ContextBudget,
    pub freshness: ContextFreshness,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct GovernedContextManifest {
    fragment_id: String,
    audience: ContextAudience,
    provenance: ContextProvenance,
    trust: ContextTrust,
    sensitivity: ContextSensitivity,
    purpose: ContextPurpose,
    budget: ContextBudget,
    freshness: ContextFreshness,
    truncated_from_tokens: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GovernedContextWire<'a> {
    manifest: &'a GovernedContextManifest,
    content: &'a str,
}

/// Immutable, bounded model-visible context with explicit governance metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GovernedContextFragment {
    manifest: GovernedContextManifest,
    content: String,
    rendered_tokens: usize,
}

impl GovernedContextFragment {
    /// Builds a fragment and deterministically truncates content to its total budget.
    pub fn build(spec: GovernedContextSpec, now: i64) -> Result<Self, GovernedContextError> {
        validate_text(&spec.fragment_id, "fragmentId", MAX_FRAGMENT_ID_BYTES)?;
        if spec.content.trim().is_empty() {
            return Err(GovernedContextError::EmptyContent);
        }
        validate_source_trust(spec.provenance.source_kind, spec.trust)?;
        if spec.sensitivity == ContextSensitivity::Secret {
            return Err(GovernedContextError::SecretNotModelVisible);
        }
        if now < 0
            || spec.freshness.observed_at > now
            || spec
                .freshness
                .expires_at
                .is_some_and(|expires_at| expires_at < now)
        {
            return Err(GovernedContextError::StaleFragment);
        }

        let original_tokens = approx_token_count(&spec.content);
        let mut manifest = GovernedContextManifest {
            fragment_id: spec.fragment_id,
            audience: spec.audience,
            provenance: spec.provenance,
            trust: spec.trust,
            sensitivity: spec.sensitivity,
            purpose: spec.purpose,
            budget: spec.budget,
            freshness: spec.freshness,
            truncated_from_tokens: None,
        };
        let original_content = spec.content;
        let mut content = original_content.clone();
        let mut content_budget = original_content.len();
        for _ in 0..8 {
            let rendered = render_fragment(&manifest, &content)?;
            let rendered_tokens = approx_token_count(&rendered);
            if rendered_tokens <= manifest.budget.token_cap {
                return Ok(Self {
                    manifest,
                    content,
                    rendered_tokens,
                });
            }
            manifest.truncated_from_tokens = Some(original_tokens as u64);
            let empty_render = render_fragment(&manifest, "")?;
            let max_bytes = approx_bytes_for_tokens(manifest.budget.token_cap);
            if empty_render.len() >= max_bytes {
                return Err(GovernedContextError::BudgetTooSmallForManifest);
            }
            let available_bytes = max_bytes - empty_render.len();
            let rendered_content_bytes = rendered.len().saturating_sub(empty_render.len()).max(1);
            let next_budget = content_budget
                .saturating_mul(available_bytes)
                .checked_div(rendered_content_bytes)
                .unwrap_or_default()
                .min(available_bytes);
            content_budget = if next_budget >= content_budget {
                content_budget.saturating_sub(1)
            } else {
                next_budget
            };
            content = truncate_middle_chars(&original_content, content_budget);
        }
        Err(GovernedContextError::BudgetTooSmallForManifest)
    }

    pub fn fragment_id(&self) -> &str {
        &self.manifest.fragment_id
    }

    pub fn audience(&self) -> &ContextAudience {
        &self.manifest.audience
    }

    pub fn source_kind(&self) -> ContextSourceKind {
        self.manifest.provenance.source_kind
    }

    pub fn rendered_tokens(&self) -> usize {
        self.rendered_tokens
    }

    pub fn was_truncated(&self) -> bool {
        self.manifest.truncated_from_tokens.is_some()
    }

    pub(crate) fn additional_context_kind(&self) -> AdditionalContextKind {
        match self.manifest.trust {
            ContextTrust::TrustedApplication => AdditionalContextKind::Application,
            ContextTrust::UntrustedData => AdditionalContextKind::Untrusted,
        }
    }
}

impl ContextualUserFragment for GovernedContextFragment {
    fn role(&self) -> &'static str {
        match self.manifest.trust {
            ContextTrust::TrustedApplication => "developer",
            ContextTrust::UntrustedData => "user",
        }
    }

    fn markers(&self) -> (&'static str, &'static str) {
        Self::type_markers()
    }

    fn type_markers() -> (&'static str, &'static str) {
        (CONTEXT_START_MARKER, CONTEXT_END_MARKER)
    }

    fn body(&self) -> String {
        let wire = GovernedContextWire {
            manifest: &self.manifest,
            content: &self.content,
        };
        match serde_json::to_string(&wire) {
            Ok(body) => body,
            Err(_) => r#"{"error":"governed_context_serialization_failed"}"#.to_string(),
        }
    }
}

/// Closed validation errors for model-visible governed context.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GovernedContextError {
    InvalidField(&'static str),
    EmptyContent,
    InvalidTrustForSource,
    SecretNotModelVisible,
    InvalidFreshness,
    StaleFragment,
    InvalidBudget,
    BudgetTooSmallForManifest,
    TooManyFragments,
    DuplicateFragmentId,
    AudienceMismatch,
    BundleBudgetExceeded,
    TooManyMemoryFragments,
}

impl fmt::Display for GovernedContextError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid governed context: {self:?}")
    }
}

impl std::error::Error for GovernedContextError {}

fn render_fragment(
    manifest: &GovernedContextManifest,
    content: &str,
) -> Result<String, GovernedContextError> {
    let body = serde_json::to_string(&GovernedContextWire { manifest, content })
        .map_err(|_| GovernedContextError::InvalidField("content"))?;
    Ok(format!("{CONTEXT_START_MARKER}{body}{CONTEXT_END_MARKER}"))
}

fn validate_source_trust(
    source_kind: ContextSourceKind,
    trust: ContextTrust,
) -> Result<(), GovernedContextError> {
    if trust == ContextTrust::TrustedApplication && source_kind != ContextSourceKind::Application {
        Err(GovernedContextError::InvalidTrustForSource)
    } else {
        Ok(())
    }
}

fn validate_opaque_id(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), GovernedContextError> {
    validate_text(value, field, max_bytes)?;
    if value
        .chars()
        .any(|character| character.is_whitespace() || matches!(character, '/' | '\\'))
    {
        return Err(GovernedContextError::InvalidField(field));
    }
    Ok(())
}

fn validate_text(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), GovernedContextError> {
    if value.trim().is_empty() || value.len() > max_bytes || value.chars().any(char::is_control) {
        Err(GovernedContextError::InvalidField(field))
    } else {
        Ok(())
    }
}
