use crate::AccessDecisionId;
use crate::ActionDigest;
use crate::ActionIntent;
use crate::ActionNonce;
use crate::ApprovalRequirement;
use crate::ExecutionAuthorization;
use crate::PolicyActor;
use crate::PolicyModelError;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de;
use serde::de::SeqAccess;
use serde::de::Visitor;
use std::collections::BTreeMap;
use std::fmt;
use std::marker::PhantomData;

const MAX_APPROVAL_ID_BYTES: usize = 256;
pub const MAX_APPROVAL_RECORDS: usize = 4_096;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ApprovalId(String);

impl ApprovalId {
    pub fn new(value: impl Into<String>) -> Result<Self, ApprovalError> {
        let value = value.into();
        if value.is_empty()
            || value.len() > MAX_APPROVAL_ID_BYTES
            || value.chars().any(char::is_control)
            || value
                .chars()
                .any(|character| character.is_whitespace() || matches!(character, '/' | '\\'))
        {
            return Err(ApprovalError::InvalidApprovalId);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for ApprovalId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied,
    Expired,
    Consumed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    Approve,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalRecord {
    approval_id: ApprovalId,
    access_decision_id: AccessDecisionId,
    actor: PolicyActor,
    action_digest: ActionDigest,
    status: ApprovalStatus,
    expires_at: i64,
    nonce: ActionNonce,
    requested_at: i64,
    decided_at: Option<i64>,
    consumed_at: Option<i64>,
}

impl ApprovalRecord {
    pub fn approval_id(&self) -> &ApprovalId {
        &self.approval_id
    }

    pub fn access_decision_id(&self) -> &AccessDecisionId {
        &self.access_decision_id
    }

    pub fn action_digest(&self) -> &ActionDigest {
        &self.action_digest
    }

    pub fn status(&self) -> ApprovalStatus {
        self.status
    }

    fn matches_requirement(&self, requirement: &ApprovalRequirement) -> bool {
        self.access_decision_id == *requirement.access_decision_id()
            && self.actor == *requirement.actor()
            && self.action_digest == *requirement.action_digest()
            && self.expires_at == requirement.expires_at()
            && self.nonce == *requirement.nonce()
    }

    fn expire_at(&mut self, now: i64) -> bool {
        if now >= self.expires_at
            && matches!(
                self.status,
                ApprovalStatus::Pending | ApprovalStatus::Approved
            )
        {
            self.status = ApprovalStatus::Expired;
            self.decided_at = Some(now);
            true
        } else {
            self.status == ApprovalStatus::Expired
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalLedgerSnapshot {
    records: Vec<ApprovalRecord>,
}

impl<'de> Deserialize<'de> for ApprovalLedgerSnapshot {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            records: BoundedApprovalRecords,
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            records: wire.records.0,
        })
    }
}

struct BoundedApprovalRecords(Vec<ApprovalRecord>);

impl<'de> Deserialize<'de> for BoundedApprovalRecords {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct RecordsVisitor(PhantomData<ApprovalRecord>);

        impl<'de> Visitor<'de> for RecordsVisitor {
            type Value = BoundedApprovalRecords;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(formatter, "at most {MAX_APPROVAL_RECORDS} approval records")
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let capacity = sequence
                    .size_hint()
                    .unwrap_or_default()
                    .min(MAX_APPROVAL_RECORDS);
                let mut records = Vec::with_capacity(capacity);
                while let Some(record) = sequence.next_element()? {
                    if records.len() == MAX_APPROVAL_RECORDS {
                        return Err(de::Error::invalid_length(
                            MAX_APPROVAL_RECORDS.saturating_add(1),
                            &self,
                        ));
                    }
                    records.push(record);
                }
                Ok(BoundedApprovalRecords(records))
            }
        }

        deserializer.deserialize_seq(RecordsVisitor(PhantomData))
    }
}

#[derive(Debug, Default)]
pub struct ApprovalLedger {
    records: BTreeMap<ApprovalId, ApprovalRecord>,
    nonce_owners: BTreeMap<ActionNonce, ApprovalId>,
}

impl ApprovalLedger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn request(
        &mut self,
        approval_id: ApprovalId,
        requirement: ApprovalRequirement,
        now: i64,
    ) -> Result<ApprovalRecord, ApprovalError> {
        if now < 0 || now >= requirement.expires_at() {
            return Err(ApprovalError::Expired);
        }
        if let Some(existing) = self.records.get_mut(&approval_id) {
            if existing.expire_at(now) {
                return Err(ApprovalError::Expired);
            }
            return if existing.matches_requirement(&requirement) {
                Ok(existing.clone())
            } else {
                Err(ApprovalError::ApprovalIdConflict)
            };
        }
        if self.records.len() >= MAX_APPROVAL_RECORDS {
            return Err(ApprovalError::RecordLimitExceeded);
        }
        if self.nonce_owners.contains_key(requirement.nonce()) {
            return Err(ApprovalError::NonceReplay);
        }

        let record = ApprovalRecord {
            approval_id: approval_id.clone(),
            access_decision_id: requirement.access_decision_id().clone(),
            actor: requirement.actor().clone(),
            action_digest: requirement.action_digest().clone(),
            status: ApprovalStatus::Pending,
            expires_at: requirement.expires_at(),
            nonce: requirement.nonce().clone(),
            requested_at: now,
            decided_at: None,
            consumed_at: None,
        };
        self.nonce_owners
            .insert(record.nonce.clone(), approval_id.clone());
        self.records.insert(approval_id, record.clone());
        Ok(record)
    }

    pub fn decide(
        &mut self,
        approval_id: &ApprovalId,
        actor: &PolicyActor,
        action_digest: ActionDigest,
        decision: ApprovalDecision,
        now: i64,
    ) -> Result<ApprovalRecord, ApprovalError> {
        let record = self
            .records
            .get_mut(approval_id)
            .ok_or(ApprovalError::NotFound)?;
        if record.actor != *actor {
            return Err(ApprovalError::OwnerMismatch);
        }
        if record.action_digest != action_digest {
            return Err(ApprovalError::ActionDigestMismatch);
        }
        if now < 0 || record.expire_at(now) {
            return Err(ApprovalError::Expired);
        }

        let desired = match decision {
            ApprovalDecision::Approve => ApprovalStatus::Approved,
            ApprovalDecision::Deny => ApprovalStatus::Denied,
        };
        match record.status {
            ApprovalStatus::Pending => {
                record.status = desired;
                record.decided_at = Some(now);
                Ok(record.clone())
            }
            status if status == desired => Ok(record.clone()),
            ApprovalStatus::Approved | ApprovalStatus::Denied => {
                Err(ApprovalError::ConflictingDecision)
            }
            ApprovalStatus::Consumed => Err(ApprovalError::AlreadyConsumed),
            ApprovalStatus::Expired => Err(ApprovalError::Expired),
        }
    }

    pub fn consume(
        &mut self,
        approval_id: &ApprovalId,
        actor: &PolicyActor,
        current_action: &ActionIntent,
        now: i64,
    ) -> Result<ExecutionAuthorization, ApprovalError> {
        let record = self
            .records
            .get_mut(approval_id)
            .ok_or(ApprovalError::NotFound)?;
        if record.actor != *actor || current_action.actor() != actor {
            return Err(ApprovalError::OwnerMismatch);
        }
        if now < 0 || record.expire_at(now) || current_action.is_expired_at(now) {
            return Err(ApprovalError::Expired);
        }
        match record.status {
            ApprovalStatus::Approved => {}
            ApprovalStatus::Pending => return Err(ApprovalError::NotApproved),
            ApprovalStatus::Denied => return Err(ApprovalError::Denied),
            ApprovalStatus::Expired => return Err(ApprovalError::Expired),
            ApprovalStatus::Consumed => return Err(ApprovalError::AlreadyConsumed),
        }
        if !current_action.credential_is_available_at(now) {
            return Err(ApprovalError::CredentialUnavailable);
        }
        let current_digest = current_action.digest()?;
        if current_digest != record.action_digest {
            return Err(ApprovalError::ActionDigestMismatch);
        }

        record.status = ApprovalStatus::Consumed;
        record.consumed_at = Some(now);
        Ok(ExecutionAuthorization::from_consumed_approval(
            record.approval_id.clone(),
            record.access_decision_id.clone(),
            record.action_digest.clone(),
            record.expires_at,
        ))
    }

    pub fn record(&self, approval_id: &ApprovalId) -> Option<&ApprovalRecord> {
        self.records.get(approval_id)
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn snapshot(&self) -> ApprovalLedgerSnapshot {
        ApprovalLedgerSnapshot {
            records: self.records.values().cloned().collect(),
        }
    }

    pub fn restore(snapshot: ApprovalLedgerSnapshot) -> Result<Self, ApprovalError> {
        if snapshot.records.len() > MAX_APPROVAL_RECORDS {
            return Err(ApprovalError::RecordLimitExceeded);
        }
        let mut ledger = Self::new();
        for record in snapshot.records {
            validate_record_shape(&record)?;
            if ledger.records.contains_key(&record.approval_id) {
                return Err(ApprovalError::InvalidSnapshot);
            }
            if ledger.nonce_owners.contains_key(&record.nonce) {
                return Err(ApprovalError::NonceReplay);
            }
            ledger
                .nonce_owners
                .insert(record.nonce.clone(), record.approval_id.clone());
            ledger.records.insert(record.approval_id.clone(), record);
        }
        Ok(ledger)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalError {
    InvalidApprovalId,
    NotFound,
    ApprovalIdConflict,
    NonceReplay,
    OwnerMismatch,
    ActionDigestMismatch,
    CredentialUnavailable,
    NotApproved,
    Denied,
    Expired,
    ConflictingDecision,
    AlreadyConsumed,
    RecordLimitExceeded,
    InvalidSnapshot,
    Model(PolicyModelError),
}

impl From<PolicyModelError> for ApprovalError {
    fn from(error: PolicyModelError) -> Self {
        Self::Model(error)
    }
}

impl fmt::Display for ApprovalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "approval rejected: {self:?}")
    }
}

impl std::error::Error for ApprovalError {}

fn validate_record_shape(record: &ApprovalRecord) -> Result<(), ApprovalError> {
    if record.requested_at < 0 || record.expires_at <= record.requested_at {
        return Err(ApprovalError::InvalidSnapshot);
    }
    let valid =
        match record.status {
            ApprovalStatus::Pending => record.decided_at.is_none() && record.consumed_at.is_none(),
            ApprovalStatus::Approved | ApprovalStatus::Denied => {
                record.decided_at.is_some_and(|decided_at| {
                    decided_at >= record.requested_at && decided_at < record.expires_at
                }) && record.consumed_at.is_none()
            }
            ApprovalStatus::Expired => {
                record
                    .decided_at
                    .is_some_and(|decided_at| decided_at >= record.expires_at)
                    && record.consumed_at.is_none()
            }
            ApprovalStatus::Consumed => record.decided_at.zip(record.consumed_at).is_some_and(
                |(decided_at, consumed_at)| {
                    decided_at >= record.requested_at
                        && consumed_at >= decided_at
                        && consumed_at < record.expires_at
                },
            ),
        };
    if valid {
        Ok(())
    } else {
        Err(ApprovalError::InvalidSnapshot)
    }
}
