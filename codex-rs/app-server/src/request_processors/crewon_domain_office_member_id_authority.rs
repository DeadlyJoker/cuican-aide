use std::collections::HashMap;
use std::collections::HashSet;

use crewon_app_server_protocol::JSONRPCErrorError;
use serde_json::Value as JsonValue;
use uuid::Uuid;

use crate::error_code::internal_error;
use crate::error_code::invalid_params;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum OfficeMemberIdentityWrite {
    InitializeNewRecord,
    PreserveExisting,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MemberRecordOrigin {
    Persisted,
    Proposed,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum StableMemberOwner {
    AgentId(String),
    Name(String),
}

enum MemberIdResolution {
    Canonical(String),
    LegacyBackfill(String),
}

pub(super) fn prepare_write(
    latest: Option<&JsonValue>,
    proposed: &mut JsonValue,
    write: OfficeMemberIdentityWrite,
) -> Result<(), JSONRPCErrorError> {
    if write == OfficeMemberIdentityWrite::InitializeNewRecord && latest.is_none() {
        return assign_initial_member_ids(proposed);
    }

    validate_existing_write(latest, proposed)
}

fn assign_initial_member_ids(proposed: &mut JsonValue) -> Result<(), JSONRPCErrorError> {
    let Some(members_value) = proposed
        .get_mut("workspace")
        .and_then(|workspace| workspace.get_mut("members"))
    else {
        return Ok(());
    };
    let members = members_value
        .as_array_mut()
        .ok_or_else(|| invalid_params("workspace.members must be an array"))?;
    for member in members {
        let member = member
            .as_object_mut()
            .ok_or_else(|| invalid_params("workspace members must be objects"))?;
        member.remove("memberId");
        member.remove("member_id");
        member.insert(
            "memberId".to_string(),
            JsonValue::String(Uuid::now_v7().to_string()),
        );
    }
    Ok(())
}

fn validate_existing_write(
    latest: Option<&JsonValue>,
    proposed: &mut JsonValue,
) -> Result<(), JSONRPCErrorError> {
    let mut canonical_owners = HashMap::new();
    let mut canonical_member_ids_by_owner = HashMap::<StableMemberOwner, Option<String>>::new();
    let mut legacy_members_by_owner = HashMap::<StableMemberOwner, usize>::new();
    if let Some(members) = latest
        .and_then(|config| config.get("workspace"))
        .and_then(|workspace| workspace.get("members"))
        .and_then(JsonValue::as_array)
    {
        for member in members {
            if !member.is_object() {
                return Err(internal_error(
                    "persisted Office workspace members must be objects",
                ));
            }
            let member_id = aliased_string(
                member,
                "memberId",
                "member_id",
                "memberId",
                MemberRecordOrigin::Persisted,
            )?;
            let agent_id = aliased_string(
                member,
                "agentId",
                "agent_id",
                "agentId",
                MemberRecordOrigin::Persisted,
            )?;
            let stable_owner =
                stable_member_owner(member, agent_id.as_deref(), MemberRecordOrigin::Persisted)?;
            let Some(member_id) = member_id else {
                let stable_owner = stable_owner.ok_or_else(|| {
                    internal_error(
                        "persisted legacy Office member without memberId has no stable owner",
                    )
                })?;
                *legacy_members_by_owner.entry(stable_owner).or_default() += 1;
                continue;
            };
            if canonical_owners
                .insert(member_id.clone(), agent_id.clone())
                .is_some()
            {
                return Err(internal_error(
                    "persisted Office memberId ownership is ambiguous",
                ));
            }
            if let Some(stable_owner) = stable_owner {
                canonical_member_ids_by_owner
                    .entry(stable_owner)
                    .and_modify(|member_id| *member_id = None)
                    .or_insert(Some(member_id));
            }
        }
    }

    let Some(proposed_members_value) = proposed
        .get_mut("workspace")
        .and_then(|workspace| workspace.get_mut("members"))
    else {
        return Ok(());
    };
    let proposed_members = proposed_members_value
        .as_array_mut()
        .ok_or_else(|| invalid_params("workspace.members must be an array"))?;
    let mut proposed_member_ids = HashSet::new();
    let mut backfilled_owners = HashSet::new();
    for member in proposed_members {
        if !member.is_object() {
            return Err(invalid_params("workspace members must be objects"));
        }
        let agent_id = aliased_string(
            member,
            "agentId",
            "agent_id",
            "agentId",
            MemberRecordOrigin::Proposed,
        )?;
        let stable_owner =
            stable_member_owner(member, agent_id.as_deref(), MemberRecordOrigin::Proposed)?;
        let member_id_resolution = match aliased_string(
            member,
            "memberId",
            "member_id",
            "memberId",
            MemberRecordOrigin::Proposed,
        )? {
            Some(member_id) => MemberIdResolution::Canonical(member_id),
            None => backfill_or_restore_member_id(
                stable_owner,
                &canonical_member_ids_by_owner,
                &legacy_members_by_owner,
                &mut backfilled_owners,
            )?,
        };
        let member_id = match &member_id_resolution {
            MemberIdResolution::Canonical(member_id)
            | MemberIdResolution::LegacyBackfill(member_id) => member_id.clone(),
        };
        if !proposed_member_ids.insert(member_id.clone()) {
            return Err(invalid_params("workspace memberId values must be distinct"));
        }
        if let MemberIdResolution::Canonical(_) = member_id_resolution {
            let Some(canonical_owner) = canonical_owners.get(&member_id) else {
                return Err(invalid_params(
                    "workspace memberId values are server-owned; use office/member/add to add a member identity",
                ));
            };
            if canonical_owner != &agent_id {
                return Err(invalid_params(
                    "workspace memberId cannot be rebound to another agent",
                ));
            }
        }
        let member = member
            .as_object_mut()
            .ok_or_else(|| internal_error("validated Office member lost its object shape"))?;
        member.remove("member_id");
        member.insert("memberId".to_string(), JsonValue::String(member_id));
    }
    Ok(())
}

fn backfill_or_restore_member_id(
    stable_owner: Option<StableMemberOwner>,
    canonical_member_ids_by_owner: &HashMap<StableMemberOwner, Option<String>>,
    legacy_members_by_owner: &HashMap<StableMemberOwner, usize>,
    backfilled_owners: &mut HashSet<StableMemberOwner>,
) -> Result<MemberIdResolution, JSONRPCErrorError> {
    let stable_owner = stable_owner.ok_or_else(|| {
        invalid_params(
            "workspace memberId values are server-owned; use office/member/add to add a member identity",
        )
    })?;
    if !backfilled_owners.insert(stable_owner.clone()) {
        return Err(invalid_params(
            "workspace members without memberId must have distinct stable owners",
        ));
    }
    match (
        canonical_member_ids_by_owner.get(&stable_owner),
        legacy_members_by_owner.get(&stable_owner).copied(),
    ) {
        (Some(Some(member_id)), None) => Ok(MemberIdResolution::Canonical(member_id.clone())),
        (None, Some(1)) => Ok(MemberIdResolution::LegacyBackfill(
            Uuid::now_v7().to_string(),
        )),
        (Some(_), Some(_)) | (Some(None), None) | (None, Some(_)) => Err(invalid_params(
            "persisted Office members do not have a unique stable owner for memberId backfill",
        )),
        (None, None) => Err(invalid_params(
            "workspace memberId values are server-owned; use office/member/add to add a member identity",
        )),
    }
}

fn stable_member_owner(
    member: &JsonValue,
    agent_id: Option<&str>,
    origin: MemberRecordOrigin,
) -> Result<Option<StableMemberOwner>, JSONRPCErrorError> {
    if let Some(agent_id) = agent_id {
        return Ok(Some(StableMemberOwner::AgentId(agent_id.to_string())));
    }
    let Some(name) = member.get("name") else {
        return Ok(None);
    };
    let name = name.as_str().ok_or_else(|| {
        member_value_error(origin, "Office member name must be a string".to_string())
    })?;
    if name.is_empty() {
        return Ok(None);
    }
    Ok(Some(StableMemberOwner::Name(name.to_string())))
}

fn aliased_string(
    value: &JsonValue,
    canonical_key: &str,
    legacy_key: &str,
    label: &str,
    origin: MemberRecordOrigin,
) -> Result<Option<String>, JSONRPCErrorError> {
    let read = |key: &str| match value.get(key) {
        Some(value) => value
            .as_str()
            .map(|value| Some(value.to_string()))
            .ok_or_else(|| {
                member_value_error(origin, format!("Office member {label} must be a string"))
            }),
        None => Ok(None),
    };
    let canonical = read(canonical_key)?;
    let legacy = read(legacy_key)?;
    if canonical.is_some() && legacy.is_some() && canonical != legacy {
        return Err(member_value_error(
            origin,
            format!("Office member {label} aliases must match"),
        ));
    }
    Ok(canonical.or(legacy))
}

fn member_value_error(origin: MemberRecordOrigin, message: String) -> JSONRPCErrorError {
    match origin {
        MemberRecordOrigin::Persisted => internal_error(message),
        MemberRecordOrigin::Proposed => invalid_params(message),
    }
}

#[cfg(test)]
#[path = "crewon_domain_office_member_id_authority_tests.rs"]
mod tests;
