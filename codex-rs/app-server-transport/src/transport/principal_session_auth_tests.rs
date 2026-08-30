use std::collections::HashMap;

use pretty_assertions::assert_eq;

use super::PrincipalSessionRs256AuthConfig;
use crate::TransportAuthenticatedPrincipalSource;
use crate::TransportAuthentication;
use crate::TransportPrincipalBinding;

const PUBLIC_KEY: &str = r#"-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1qQF2MqTrGAMDm7wXbjJ
P5sWqGA83tAGUs2ksy7iJXLJdhCg4AtwGm4SFl4f6kxhCSzlN1QdXuZjvRT2wZZi
GUi9xUE28rf4WLrTxSnwqLuTy5knMP08yC0t/0YU/FGPZMcWb14hG05IvZr8UbmR
aVagxSR8H4rSIymRoVwwmFSrqz068XrWGSYNIfLEASyo5GdAaqmk1JALINHgYGQJ
VxMxtwcvDxoVKmC7eltUNymMNBZhsv4E8sx9YNLpBoEibznfEpDU/DGzrM5eZCsQ
zaqbhBOlGd427ifud/Nnd9cPqzgCUc23+0FXSPfpbgksCXAwAmD0OFjQWrgqVdKL
6QIDAQAB
-----END PUBLIC KEY-----"#;

const TOKEN: &str = "eyJhbGciOiJSUzI1NiIsImtpZCI6ImtleS0xIiwidHlwIjoiY3Jld29uLXByaW5jaXBhbC1zZXNzaW9uK2p3dCJ9.eyJpc3MiOiJhZ2VudC1wbGF0Zm9ybSIsImF1ZCI6ImNyZXdvbi1hcHAtc2VydmVyIiwic3ViIjoidXNlcjo0MiIsImFjdG9ySWQiOiJwcmluY2lwYWw6NmY3OTAwZWFlZDMyMThiNGMxNTI0OWNhZDEyOWVkOTZiZjFiZGU0ZDA1MjRmYTRiNmZhZDFiYTMyNWU4ZWYzZiIsInRlbmFudElkIjoiNyIsInNwYWNlSWQiOiIxMSIsInNvdXJjZUJpbmRpbmdJZCI6IjAxOWY2ZjAwLTAwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDAwMSIsInNvdXJjZVJldmlzaW9uIjoxLCJqdGkiOiIwMTlmNmYwMC0wMDAwLTcwMDAtODAwMC0wMDAwMDAwMDAwMDIiLCJpYXQiOjE4MDAwMDAwMDAsImV4cCI6MTgwMDAwMzYwMH0.TgnaDcU0oyBlnXGgRg2s-IpDekw3bSIE5gAFw8nE4sw-5SJuln0soXbh2dZP7WlmhH4Q_9U25kW5zxtCdhmtBLeg8p50aLUdxOUxuCOBwlTvOnbz1yqFgvyhbByvKCT6bxnq1-bbjq1EL7e69wQbdONDLNmJP3zdG_4q1IsEsA1stUK3jkHPOnY1XybyAs78Rhhph1kqzPXjmcAEdBH9DWQvWM_VSbOBDbscgCGT_1J_OF6PTv8Q-z5QumI2wPK3LUlfLBkGXJ8-59nfyOoHmPiDHwjve6PjsHNadE-EDiq54CO8ZSS12_AtUewBfBF2HiYhztkHhHWoN0sS71OjQg";

#[test]
fn verifies_exact_rs256_principal_session_and_binding_metadata() {
    let config = config("key-1");
    let authentication = config
        .verify(TOKEN, /*now*/ 1_800_000_001)
        .expect("principal session");
    let TransportAuthentication::AuthenticatedPrincipal(principal) = authentication else {
        panic!("expected authenticated principal");
    };
    assert_eq!(
        principal.source(),
        TransportAuthenticatedPrincipalSource::WebSocketPrincipalSessionRs256
    );
    assert_eq!(principal.subject(), "user:42");
    assert_eq!(principal.tenant_id(), "7");
    assert_eq!(principal.space_id(), "11");
    assert_eq!(
        principal.binding(),
        &TransportPrincipalBinding::AgentPlatform {
            actor_id: "principal:6f7900eaed3218b4c15249cad129ed96bf1bde4d0524fa4b6fad1ba325e8ef3f"
                .to_string(),
            source_binding_id: "019f6f00-0000-7000-8000-000000000001".to_string(),
            source_revision: 1,
        }
    );
    assert!(!format!("{principal:?}").contains("019f6f00"));
}

#[test]
fn rejects_unknown_key_tampering_expiry_and_invalid_keysets() {
    assert!(config("another-key").verify(TOKEN, 1_800_000_001).is_err());
    assert!(
        config("key-1")
            .verify(&format!("{TOKEN}x"), 1_800_000_001)
            .is_err()
    );
    assert!(config("key-1").verify(TOKEN, 1_800_003_600).is_err());
    assert!(PrincipalSessionRs256AuthConfig::new(HashMap::new(), 30).is_err());
    assert!(
        PrincipalSessionRs256AuthConfig::new(
            HashMap::from([("key-1".to_string(), PUBLIC_KEY.to_string())]),
            301,
        )
        .is_err()
    );
    assert!(!format!("{:?}", config("key-1")).contains("BEGIN PUBLIC KEY"));
}

fn config(key_id: &str) -> PrincipalSessionRs256AuthConfig {
    PrincipalSessionRs256AuthConfig::new(
        HashMap::from([(key_id.to_string(), PUBLIC_KEY.to_string())]),
        30,
    )
    .expect("valid keyset")
}
