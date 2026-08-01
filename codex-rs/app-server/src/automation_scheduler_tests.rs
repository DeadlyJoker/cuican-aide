use pretty_assertions::assert_eq;
use serde_json::json;

use super::automation_is_due;
use super::claim_next_run;

#[test]
fn recurring_schedule_catches_up_once_and_advances_from_planned_time() {
    let config = json!({
        "title": "Daily summary",
        "enabled": true,
        "status": "enabled",
        "trigger": {
            "type": "schedule",
            "scheduleType": "daily",
            "nextRunAt": 100,
            "intervalSeconds": 60
        }
    });

    assert!(automation_is_due(&config, /*now*/ 220));
    let (scheduled_at, claimed) =
        claim_next_run(config, /*now*/ 220).expect("schedule should be claimed");

    assert_eq!(scheduled_at, 100);
    assert_eq!(claimed["trigger"]["lastScheduledAt"], 100);
    assert_eq!(claimed["trigger"]["nextRunAt"], 280);
    assert_eq!(claimed["enabled"], true);
}

#[test]
fn one_time_schedule_disables_itself_after_claim() {
    let config = json!({
        "title": "One time report",
        "enabled": true,
        "status": "enabled",
        "trigger": {
            "type": "schedule",
            "scheduleType": "once",
            "nextRunAt": 100
        }
    });

    let (_, claimed) = claim_next_run(config, /*now*/ 100).expect("schedule should be claimed");

    assert_eq!(claimed["trigger"]["nextRunAt"], serde_json::Value::Null);
    assert_eq!(claimed["enabled"], false);
    assert_eq!(claimed["status"], "disabled");
    assert!(!automation_is_due(&claimed, /*now*/ 101));
}
