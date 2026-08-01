use super::ContextAudience;
use super::ContextAudienceKind;
use super::ContextSourceKind;
use super::ContextualUserFragment;
use super::GovernedContextError;
use super::GovernedContextFragment;
use crewon_protocol::protocol::AdditionalContextEntry;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

/// Maximum number of governed fragments in one immutable bundle.
pub const MAX_GOVERNED_CONTEXT_FRAGMENTS: usize = 8;
/// Maximum approximate tokens across one governed bundle.
pub const MAX_GOVERNED_CONTEXT_BUNDLE_TOKENS: usize = 4_000;
/// Maximum accepted long-term-memory retrieval fragments in one bundle.
pub const MAX_GOVERNED_MEMORY_FRAGMENTS: usize = 6;

/// Immutable collection that enforces one audience and a finite total budget.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GovernedContextBundle {
    audience: ContextAudience,
    fragments: Vec<GovernedContextFragment>,
}

impl GovernedContextBundle {
    pub fn new(
        audience: ContextAudience,
        fragments: Vec<GovernedContextFragment>,
    ) -> Result<Self, GovernedContextError> {
        if fragments.len() > MAX_GOVERNED_CONTEXT_FRAGMENTS {
            return Err(GovernedContextError::TooManyFragments);
        }
        let mut ids = BTreeSet::new();
        let mut total_tokens = 0usize;
        let mut memory_fragments = 0usize;
        for fragment in &fragments {
            if fragment.audience() != &audience {
                return Err(GovernedContextError::AudienceMismatch);
            }
            if !ids.insert(fragment.fragment_id()) {
                return Err(GovernedContextError::DuplicateFragmentId);
            }
            total_tokens = total_tokens.saturating_add(fragment.rendered_tokens());
            memory_fragments += usize::from(fragment.source_kind() == ContextSourceKind::Memory);
        }
        if total_tokens > MAX_GOVERNED_CONTEXT_BUNDLE_TOKENS {
            return Err(GovernedContextError::BundleBudgetExceeded);
        }
        if memory_fragments > MAX_GOVERNED_MEMORY_FRAGMENTS {
            return Err(GovernedContextError::TooManyMemoryFragments);
        }
        Ok(Self {
            audience,
            fragments,
        })
    }

    /// Adapts the bundle to the existing incremental Core context channel.
    pub fn additional_context_entries(&self) -> BTreeMap<String, AdditionalContextEntry> {
        self.fragments
            .iter()
            .map(|fragment| {
                (
                    stable_fragment_key(&self.audience, fragment.fragment_id()),
                    AdditionalContextEntry {
                        value: fragment.render(),
                        kind: fragment.additional_context_kind(),
                    },
                )
            })
            .collect()
    }
}

fn stable_fragment_key(audience: &ContextAudience, fragment_id: &str) -> String {
    let kind = match audience.kind() {
        ContextAudienceKind::Single => "single",
        ContextAudienceKind::Experts => "experts",
        ContextAudienceKind::OfficeShared => "office-shared",
        ContextAudienceKind::OfficeMemberPrivate => "office-member",
    };
    format!(
        "governed__{kind}__{}__{fragment_id}",
        audience.workspace_binding_id()
    )
}
