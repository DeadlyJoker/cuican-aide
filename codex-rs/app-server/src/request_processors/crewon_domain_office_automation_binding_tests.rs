use crewon_app_server_protocol::OfficeAutomationBinding;
use crewon_app_server_protocol::OfficeAutomationBindingApprovalMode;
use crewon_app_server_protocol::OfficeAutomationBindingDispatchMode;
use crewon_app_server_protocol::OfficeAutomationBindingPolicy;
use crewon_app_server_protocol::OfficeAutomationBindingRiskLevel;
use crewon_app_server_protocol::OfficeAutomationBindingStatus;
use pretty_assertions::assert_eq;
use serde_json::json;

use super::BINDING_VERSION;
use super::automation_binding_title;
use super::binding_allows_auto_dispatch;
use super::binding_path::AUTOMATION_IDENTITY_PREFIX;
use super::bindings;
use super::preserve_canonical_bindings;

fn binding(policy: OfficeAutomationBindingPolicy) -> OfficeAutomationBinding {
    OfficeAutomationBinding {
        binding_version: BINDING_VERSION,
        binding_id: "nightly-smoke".to_string(),
        automation_file_path: "/tmp/workspace/.crewon/automations/nightly.json".to_string(),
        automation_identity: format!("{AUTOMATION_IDENTITY_PREFIX}{}", "a".repeat(64)),
        automation_title: "Nightly smoke".to_string(),
        policy,
        created_at: 1_700_000_000,
        updated_at: 1_700_000_000,
    }
}

fn policy(
    dispatch_mode: OfficeAutomationBindingDispatchMode,
    risk_level: OfficeAutomationBindingRiskLevel,
    approval_mode: OfficeAutomationBindingApprovalMode,
    status: OfficeAutomationBindingStatus,
) -> OfficeAutomationBindingPolicy {
    OfficeAutomationBindingPolicy {
        dispatch_mode,
        risk_level,
        approval_mode,
        status,
    }
}

#[test]
fn ordinary_save_preserves_omitted_server_owned_bindings() {
    let expected = binding(policy(
        OfficeAutomationBindingDispatchMode::Auto,
        OfficeAutomationBindingRiskLevel::Low,
        OfficeAutomationBindingApprovalMode::NotRequired,
        OfficeAutomationBindingStatus::Enabled,
    ));
    let latest = json!({
        "workspace": {
            "automationBindings": [expected],
        }
    });
    let mut proposed = json!({"workspace": {"goal": "updated"}});

    assert!(
        preserve_canonical_bindings(Some(&latest), &mut proposed)
            .expect("preserve canonical bindings")
    );
    assert_eq!(bindings(&proposed).expect("parse bindings"), vec![expected]);
}

#[test]
fn ordinary_save_rejects_changed_or_forged_bindings() {
    let canonical = binding(policy(
        OfficeAutomationBindingDispatchMode::Manual,
        OfficeAutomationBindingRiskLevel::High,
        OfficeAutomationBindingApprovalMode::Required,
        OfficeAutomationBindingStatus::Enabled,
    ));
    let latest = json!({
        "workspace": {
            "automationBindings": [canonical],
        }
    });
    let mut changed = canonical;
    changed.policy.dispatch_mode = OfficeAutomationBindingDispatchMode::Auto;
    changed.policy.risk_level = OfficeAutomationBindingRiskLevel::Low;
    changed.policy.approval_mode = OfficeAutomationBindingApprovalMode::NotRequired;
    let mut proposed = json!({
        "workspace": {
            "automationBindings": [changed],
        }
    });

    let error = preserve_canonical_bindings(Some(&latest), &mut proposed)
        .expect_err("client authority widening must fail");
    assert!(error.message.contains("server-owned"));

    let mut forged_create = json!({
        "workspace": {
            "automationBindings": latest["workspace"]["automationBindings"].clone(),
        }
    });
    let error = preserve_canonical_bindings(None, &mut forged_create)
        .expect_err("new Office cannot forge bindings");
    assert!(error.message.contains("server-owned"));
}

#[test]
fn auto_dispatch_requires_every_server_policy_gate() {
    let allowed = binding(policy(
        OfficeAutomationBindingDispatchMode::Auto,
        OfficeAutomationBindingRiskLevel::Medium,
        OfficeAutomationBindingApprovalMode::NotRequired,
        OfficeAutomationBindingStatus::Enabled,
    ));
    assert!(binding_allows_auto_dispatch(&allowed));

    for blocked in [
        policy(
            OfficeAutomationBindingDispatchMode::Manual,
            OfficeAutomationBindingRiskLevel::Low,
            OfficeAutomationBindingApprovalMode::NotRequired,
            OfficeAutomationBindingStatus::Enabled,
        ),
        policy(
            OfficeAutomationBindingDispatchMode::Auto,
            OfficeAutomationBindingRiskLevel::High,
            OfficeAutomationBindingApprovalMode::NotRequired,
            OfficeAutomationBindingStatus::Enabled,
        ),
        policy(
            OfficeAutomationBindingDispatchMode::Auto,
            OfficeAutomationBindingRiskLevel::Low,
            OfficeAutomationBindingApprovalMode::Required,
            OfficeAutomationBindingStatus::Enabled,
        ),
        policy(
            OfficeAutomationBindingDispatchMode::Auto,
            OfficeAutomationBindingRiskLevel::Low,
            OfficeAutomationBindingApprovalMode::NotRequired,
            OfficeAutomationBindingStatus::Disabled,
        ),
    ] {
        assert!(!binding_allows_auto_dispatch(&binding(blocked)));
    }
}

#[test]
fn automation_binding_title_is_printable_before_persistence() {
    assert_eq!(
        automation_binding_title(&json!({"title": "  nightly\u{0} smoke\n  "})),
        "nightly smoke"
    );
    assert_eq!(
        automation_binding_title(&json!({"title": "\u{0}"})),
        "Automation"
    );
    assert_eq!(
        automation_binding_title(&json!({"title": "nightly \u{0}"})),
        "nightly"
    );
}
