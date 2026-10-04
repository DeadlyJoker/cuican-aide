# Native 插件积分环境隔离

桌面宿主沿用 [Worker 的独立财务配置](./installed-plugin-credit-worker.md)，不另建身份、钱包、价格或结算协议。启动时捕获原 `CREWON_PLUGIN_CREDIT_SETTLEMENT_CONFIG_PATH` 指向的当前用户所有、单链接、0600 普通文件，以及其中两个明确的 token 环境变量引用。文件和配置校验失败则拒绝启动；没有声明路径时不读取财务文件，也不按 token 名称前缀猜测要删除的变量。

原 RuntimeSupervisor 在最终 spawn 边界投影环境。只有当前 Runtime Worker 恢复捕获的路径和 token；Control、prepare、release、历史 Worker 与历史 Control 不被动继承这些字段。模型目录探测和独立 management 启动也使用共享环境投影。原工作区命令、Git 和 Windows 清退子进程清理相同明确字段；Windows 清退使用启动前已清理的环境，不因后续配置 pin 失效而妨碍原进程清退。

财务 token 引用不能占用操作系统、Node、Electron 或其他 CrewON 协议保留字段。这是 Native 新增约束，不能表述为原 Worker parser 已有的限制。`CREWON_FINANCIAL_*` 专属名称及其他合法、未保留名称仍按配置精确处理；未声明的普通变量保持原值。

捕获凭据在当前 owner 内不可变，不持续监控 Main 的环境变量。每次投影及最终 spawn 前核验原文件；文件 pin 失败或最终 overlay 冲突永久撤回该 owner，恢复原值也不能复用。配置没有 watcher，因此不能承诺文件变化即时终止已经运行的 Worker。关闭在原子进程退场后释放捕获；原 SIGTERM/SIGKILL 生命周期保持，强制 OS 退出不证明 Worker 的所有财务 HTTP 已优雅结束。

原未配置 provider 的入口仍只启动 management Control，或在没有 runtime resources 时返回；不会为结算新增常驻 Worker。环境隔离限制被动继承，不是插件沙箱：Main 仍持有显式部署凭据，相同 UID 可读取已知私有文件，当前 Worker 内可信 Node 插件仍能读取自身环境并发起子进程。原模型凭据机制仍可显式选择 Main 的环境变量；若把财务引用选为模型凭据，该值仍可能经 probe stdin 交付。部署必须分别配置模型与财务凭据，不能把环境 scrub 声称为任意输入下的秘密隔离。

验证使用明确的文件、凭据和子进程夹具，覆盖最终 Supervisor、原模型目录函数、management 与工作区启动。真实个人身份、资金、价格、失败规则和 HTTPS 财务服务仍需独立配置并验收；该投影本身不授予财务权限或供应商执行能力。实际结果以[实施进度](./incremental-extension-progress.md)为准。
