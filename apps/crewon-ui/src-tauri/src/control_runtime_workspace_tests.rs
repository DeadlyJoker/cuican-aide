use super::project_workspace_ready;

#[test]
fn readiness_projection_binds_exact_nonsecret_authority() {
    assert_eq!(
        project_workspace_ready(
            b"CrewON Workspace Runtime ready:http://127.0.0.1:43126:runtime-1",
            "runtime-1"
        ),
        Some("http://127.0.0.1:43126".to_string())
    );
}

#[test]
fn readiness_projection_rejects_wrong_binding() {
    assert_eq!(
        project_workspace_ready(
            b"CrewON Workspace Runtime ready:http://127.0.0.1:43126:runtime-old",
            "runtime-1"
        ),
        None
    );
}
