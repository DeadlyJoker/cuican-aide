use crewon_app_server_protocol::CrewonDomainConfigRecord;
use pretty_assertions::assert_eq;
use serde_json::json;

use super::rebind_config;
use super::rebind_records;
use super::repair_candidate;

#[test]
fn repair_only_rebinds_the_exact_thread() {
    let mut config = json!({
        "workspace": {
            "members": [
                {
                    "agentId": "agent-reviewer",
                    "name": "Reviewer",
                    "threadId": "stale-thread"
                },
                {
                    "agentId": "agent-writer",
                    "name": "Writer",
                    "runtime": { "threadId": "writer-thread" }
                }
            ],
            "activity": {
                "runs": [{
                    "delegationRoutes": [
                        {
                            "agentId": "agent-reviewer",
                            "threadId": "stale-thread",
                            "target": "stale-thread"
                        },
                        {
                            "agentId": "agent-writer",
                            "threadId": "writer-thread",
                            "target": "writer-thread"
                        },
                        {
                            "member": "Reviewer",
                            "threadId": "stale-thread",
                            "target": "stale-thread"
                        }
                    ],
                    "delegations": [
                        {
                            "member": "Reviewer",
                            "threadId": "stale-thread",
                            "status": "pending"
                        },
                        {
                            "member": "Reviewer",
                            "threadId": "stale-thread",
                            "turnId": "started-turn",
                            "status": "running"
                        }
                    ]
                }]
            }
        }
    });

    let records = vec![
        CrewonDomainConfigRecord {
            file_path: "/workspace/.crewon/offices/target.json".to_string(),
            saved_at: "2026-07-12T00:00:00Z".to_string(),
            config: config.clone(),
        },
        CrewonDomainConfigRecord {
            file_path: "/workspace/.crewon/offices/unrelated.json".to_string(),
            saved_at: "2026-07-12T00:00:00Z".to_string(),
            config: json!({
                "workspace": {
                    "members": [{
                        "agentId": "agent-unrelated",
                        "runtime": { "threadId": "stale-thread" }
                    }]
                }
            }),
        },
    ];
    let candidate_agent = |file_path| {
        repair_candidate(&records, file_path, "stale-thread").map(|candidate| candidate.agent_id)
    };
    assert_eq!(
        [
            candidate_agent("/workspace/.crewon/offices/target.json"),
            candidate_agent("/workspace/.crewon/offices/unrelated.json"),
        ],
        [
            Some("agent-reviewer".to_string()),
            Some("agent-unrelated".to_string()),
        ]
    );
    let original_records = records.clone();
    let updates = rebind_records(
        &records,
        "/workspace/.crewon/offices/target.json",
        "stale-thread",
        "replacement-thread",
        "agent-reviewer",
    );
    assert_eq!(records, original_records);
    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0].0, 0);

    assert!(rebind_config(
        &mut config,
        "stale-thread",
        "replacement-thread",
        "agent-reviewer",
    ));

    let members = config["workspace"]["members"].as_array().unwrap();
    assert_eq!(
        [
            members[0]["runtime"]["threadId"].as_str(),
            members[1]["runtime"]["threadId"].as_str(),
        ],
        [Some("replacement-thread"), Some("writer-thread")]
    );
    assert_eq!(
        members[0]["runtime"]["agentProfile"],
        "name=Reviewer; role=Office collaboration"
    );
    assert_eq!(
        members[0]["runtime"]["agentProfileSource"],
        "officeMemberRepair"
    );
    assert_eq!(members[0]["runtime"]["runtimeVersion"], 2);
    assert_eq!(members[0]["runtime"]["sessionScope"], "office");
    let run = &config["workspace"]["activity"]["runs"][0];
    let routes = run["delegationRoutes"].as_array().unwrap();
    assert_eq!(
        [
            routes[0]["target"].as_str(),
            routes[1]["target"].as_str(),
            routes[2]["target"].as_str(),
        ],
        [
            Some("replacement-thread"),
            Some("writer-thread"),
            Some("replacement-thread")
        ]
    );
    assert_eq!(
        run["delegations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|delegation| delegation["threadId"].as_str())
            .collect::<Vec<_>>(),
        vec![Some("replacement-thread"), Some("stale-thread")]
    );
    let mut conflicting = records[0].config.clone();
    conflicting["workspace"]["activity"]["runs"][0]["delegationRoutes"][2]["member"] =
        json!("Writer");
    let original = conflicting.clone();
    assert!(!rebind_config(
        &mut conflicting,
        "stale-thread",
        "replacement-thread",
        "agent-reviewer",
    ));
    assert_eq!(conflicting, original);
}

#[test]
fn repair_rejects_route_only_and_divergent_thread_bindings() {
    let record = |config| CrewonDomainConfigRecord {
        file_path: "office.json".to_string(),
        saved_at: "2026-07-12T00:00:00Z".to_string(),
        config,
    };
    let route_only = vec![record(json!({
        "workspace": {
            "members": [],
            "activity": {
                "runs": [{
                    "delegationRoutes": [{
                        "agentId": "agent-reviewer",
                        "threadId": "stale-thread",
                        "target": "stale-thread"
                    }]
                }]
            }
        }
    }))];
    assert_eq!(
        repair_candidate(&route_only, "office.json", "stale-thread"),
        None
    );

    let divergent_member = vec![record(json!({
        "workspace": {
            "members": [{
                "agentId": "agent-reviewer",
                "threadId": "different-thread",
                "runtime": { "threadId": "stale-thread" }
            }]
        }
    }))];
    assert_eq!(
        repair_candidate(&divergent_member, "office.json", "stale-thread"),
        None
    );

    let mut divergent_route = json!({
        "workspace": {
            "members": [{
                "agentId": "agent-reviewer",
                "name": "Reviewer",
                "runtime": { "threadId": "stale-thread" }
            }],
            "activity": {
                "runs": [{
                    "delegationRoutes": [{
                        "member": "Reviewer",
                        "threadId": "different-thread",
                        "target": "stale-thread"
                    }]
                }]
            }
        }
    });
    let original = divergent_route.clone();
    assert!(!rebind_config(
        &mut divergent_route,
        "stale-thread",
        "replacement-thread",
        "agent-reviewer",
    ));
    assert_eq!(divergent_route, original);
}

#[test]
fn repair_respects_persisted_authority_bounds() {
    let mut members = (0..16)
        .map(|index| {
            json!({
                "agentId": format!("repaired-agent-{index}"),
                "runtime": {
                    "threadId": format!("replacement-thread-{index}"),
                    "sessionScope": "office",
                    "runtimeVersion": 2,
                    "repairSourceThreadId": format!("missing-thread-{index}"),
                    "agentProfileSource": "officeMemberRepair"
                }
            })
        })
        .collect::<Vec<_>>();
    members.push(json!({
        "agentId": "agent-over-limit",
        "runtime": { "threadId": "stale-over-limit" }
    }));
    let bounded = vec![CrewonDomainConfigRecord {
        file_path: "office.json".to_string(),
        saved_at: "2026-07-12T00:00:00Z".to_string(),
        config: json!({ "workspace": { "members": members } }),
    }];
    assert_eq!(
        repair_candidate(&bounded, "office.json", "stale-over-limit"),
        None
    );

    let oversized_agent_id = "a".repeat(/*n*/ 129);
    let oversized = vec![CrewonDomainConfigRecord {
        file_path: "office.json".to_string(),
        saved_at: "2026-07-12T00:00:00Z".to_string(),
        config: json!({
            "workspace": {
                "members": [{
                    "agentId": oversized_agent_id,
                    "runtime": { "threadId": "stale-long-agent" }
                }]
            }
        }),
    }];
    assert_eq!(
        repair_candidate(&oversized, "office.json", "stale-long-agent"),
        None
    );

    let duplicate_agent = vec![CrewonDomainConfigRecord {
        file_path: "office.json".to_string(),
        saved_at: "2026-07-12T00:00:00Z".to_string(),
        config: json!({
            "workspace": {
                "members": [{
                    "agentId": "agent-duplicate",
                    "runtime": { "threadId": "stale-duplicate-one" }
                }, {
                    "agentId": "agent-duplicate",
                    "runtime": { "threadId": "stale-duplicate-two" }
                }]
            }
        }),
    }];
    assert_eq!(
        repair_candidate(&duplicate_agent, "office.json", "stale-duplicate-one"),
        None
    );
}
