# W1-02 实施计划

1. 完成 cwd/teamCwd、Thread/Office/Knowledge、permission roots、Config 与 transport capability Discovery。
2. 固定 session-scoped 生命周期、server root catalog、WorkspaceRef/binding 和路径安全不变量。
3. 先新增 protocol/TestAppServer/unit Harness，证明 workspace API 与 Registry 缺失。
4. 新增 app-server v2 workspace DTO 与 experimental <code>workspace/list</code>/<code>workspace/bind</code>。
5. 在 <code>platform_control/workspace</code> 实现 bounded session Registry、canonical root catalog、availability 和安全路径解析。
6. 最小接线 RequestIdentity/session、Config roots、installation/environment；不修改现有 Thread/Office/Knowledge consumers。
7. 生成 schema，运行 protocol/app-server targeted tests，审查路径、权限、持久化、breaking surface 和变更规模。
8. scoped fix，最后 <code>just fmt</code>；workspace 完整 <code>just test</code> 保持等待用户授权。

