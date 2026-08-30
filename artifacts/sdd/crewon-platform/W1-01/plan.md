# W1-01 实施计划

1. 完成 transport/auth/session 可信来源 Discovery。
2. 先接入 TestAppServer Harness，证明 identity/read 和类型缺失。
3. 新增 protocol v2 identity DTO 与 experimental identity/read。
4. 新增 platform_control RequestIdentity connection/session derivation。
5. 最小接线 ConnectionOrigin、initialize declared metadata 和 request trace。
6. 运行 targeted protocol/app-server tests，生成 schema，审查 breaking surfaces。
7. scoped fix，最后 just fmt；完整 workspace just test 保持等待用户授权。
