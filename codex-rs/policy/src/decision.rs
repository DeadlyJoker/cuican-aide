use crate::AccessDecisionId;
use crate::ActionDigest;
use crate::ActionIntent;
use crate::ActionNonce;
use crate::ApprovalId;
use crate::PolicyActor;
use crate::PolicyModelError;
use crate::SideEffect;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyDenialReason {
    ActionExpired,
    CredentialUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyDenial {
    access_decision_id: AccessDecisionId,
    reason: PolicyDenialReason,
}

impl PolicyDenial {
    pub fn access_decision_id(&self) -> &AccessDecisionId {
        &self.access_decision_id
    }

    pub fn reason(&self) -> PolicyDenialReason {
        self.reason
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalRequirement {
    access_decision_id: AccessDecisionId,
    actor: PolicyActor,
    action_digest: ActionDigest,
    expires_at: i64,
    nonce: ActionNonce,
}

impl ApprovalRequirement {
    pub fn access_decision_id(&self) -> &AccessDecisionId {
        &self.access_decision_id
    }

    pub fn actor(&self) -> &PolicyActor {
        &self.actor
    }

    pub fn action_digest(&self) -> &ActionDigest {
        &self.action_digest
    }

    pub fn expires_at(&self) -> i64 {
        self.expires_at
    }

    pub fn nonce(&self) -> &ActionNonce {
        &self.nonce
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AuthorizationSource {
    ImmediatePolicy,
    ConsumedApproval { approval_id: ApprovalId },
}

/// Capability proving that the exact current action passed the CrewON policy gate.
///
/// This capability is only a local execution gate and audit correlation. A Provider
/// must still enforce its own tenant, space, resource, and delegated-token authorization.
#[derive(Debug, PartialEq, Eq)]
pub struct ExecutionAuthorization {
    access_decision_id: AccessDecisionId,
    action_digest: ActionDigest,
    expires_at: i64,
    source: AuthorizationSource,
}

impl ExecutionAuthorization {
    pub fn access_decision_id(&self) -> &AccessDecisionId {
        &self.access_decision_id
    }

    pub fn action_digest(&self) -> &ActionDigest {
        &self.action_digest
    }

    pub fn approval_id(&self) -> Option<&ApprovalId> {
        match &self.source {
            AuthorizationSource::ImmediatePolicy => None,
            AuthorizationSource::ConsumedApproval { approval_id } => Some(approval_id),
        }
    }

    pub fn verify(
        self,
        current_action: &ActionIntent,
        now: i64,
    ) -> Result<Self, AuthorizationError> {
        if now < 0 || now >= self.expires_at || current_action.is_expired_at(now) {
            return Err(AuthorizationError::Expired);
        }
        if !current_action.credential_is_available_at(now) {
            return Err(AuthorizationError::CredentialUnavailable);
        }
        let current_digest = current_action.digest().map_err(AuthorizationError::Model)?;
        if current_digest != self.action_digest {
            return Err(AuthorizationError::ActionDigestMismatch);
        }
        Ok(self)
    }

    pub(crate) fn from_consumed_approval(
        approval_id: ApprovalId,
        access_decision_id: AccessDecisionId,
        action_digest: ActionDigest,
        expires_at: i64,
    ) -> Self {
        Self {
            access_decision_id,
            action_digest,
            expires_at,
            source: AuthorizationSource::ConsumedApproval { approval_id },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthorizationError {
    Expired,
    CredentialUnavailable,
    ActionDigestMismatch,
    Model(PolicyModelError),
}

#[derive(Debug, PartialEq, Eq)]
pub enum PolicyDecision {
    Allow(ExecutionAuthorization),
    Deny(PolicyDenial),
    ApprovalRequired(ApprovalRequirement),
}

impl PolicyDecision {
    pub fn execution_authorization(&self) -> Option<&ExecutionAuthorization> {
        match self {
            Self::Allow(authorization) => Some(authorization),
            Self::Deny(_) | Self::ApprovalRequired(_) => None,
        }
    }
}

/// Minimal secure policy used before W1-10 composes consumer-specific stricter rules.
pub struct BaselinePolicy;

impl BaselinePolicy {
    pub fn evaluate(
        access_decision_id: AccessDecisionId,
        action: &ActionIntent,
        now: i64,
    ) -> Result<PolicyDecision, PolicyModelError> {
        if action.is_expired_at(now) {
            return Ok(PolicyDecision::Deny(PolicyDenial {
                access_decision_id,
                reason: PolicyDenialReason::ActionExpired,
            }));
        }
        if !action.credential_is_available_at(now) {
            return Ok(PolicyDecision::Deny(PolicyDenial {
                access_decision_id,
                reason: PolicyDenialReason::CredentialUnavailable,
            }));
        }

        let action_digest = action.digest()?;
        if action.side_effect() == SideEffect::ReadOnly {
            Ok(PolicyDecision::Allow(ExecutionAuthorization {
                access_decision_id,
                action_digest,
                expires_at: action.expires_at(),
                source: AuthorizationSource::ImmediatePolicy,
            }))
        } else {
            Ok(PolicyDecision::ApprovalRequired(ApprovalRequirement {
                access_decision_id,
                actor: action.actor().clone(),
                action_digest,
                expires_at: action.expires_at(),
                nonce: action.nonce().clone(),
            }))
        }
    }
}
