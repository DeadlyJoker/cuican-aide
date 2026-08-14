# 企业微信登录配置

CrewON 客户端只读取 `GET /api/v1/auth/wecom/config` 并据此把登录按钮渲染为可用或禁用。
配置本身全部在 Agent Platform 后端，客户端没有任何可配项。

未配置时该接口返回：

```json
{
  "enabled": false,
  "provider": "wecom",
  "label": "企业微信",
  "reason": "需要配置企业 ID、应用 AgentId、Secret、可信回调地址和 CrewON Web 地址"
}
```

按钮随之显示为「企业微信（配置后启用）」。这是设计行为，不是故障。

## 后端需要的变量

在 Agent Platform 的部署环境（生产为 `/opt/cuican/agent-platform/.env.deploy`）中设置。
六项缺一不可：任何一项为空，后端都会返回上面的未配置响应。

| 变量                 | 说明                                         |
| -------------------- | -------------------------------------------- |
| `WECOM_SSO_ENABLED`  | 总开关，取 `1` / `true` / `yes` / `on` 之一  |
| `WECOM_CORP_ID`      | 企业 ID（CorpId）                            |
| `WECOM_AGENT_ID`     | 自建应用的 AgentId                           |
| `WECOM_APP_SECRET`   | 应用 Secret（旧名 `WECOM_SECRET` 仍兼容）    |
| `WECOM_REDIRECT_URI` | 企业微信回调地址，须与管理后台登记的完全一致 |
| `WECOM_FRONTEND_URL` | 登录完成后跳回的 CrewON Web 地址             |

`WECOM_API_URL` 与 `WECOM_LOGIN_URL` 有默认值，一般不用设。

两个 URL 受校验限制：只接受 `https`，或 host 为 `127.0.0.1` / `localhost` 的 `http`。
其他 `http` 地址会被判为未配置。

## 取值来源

`CORP_ID`、`AGENT_ID`、`APP_SECRET` 需要在企业微信管理后台申请，仓库里无法生成：

1. 企业微信管理后台 → 我的企业 → 企业信息，取 **企业 ID**。
2. 应用管理 → 自建 → 创建应用，取 **AgentId** 与 **Secret**。
3. 该应用 → 网页授权及 JS-SDK，把 `WECOM_FRONTEND_URL` 的域名登记为可信域名。
4. 该应用 → 企业微信授权登录，把 `WECOM_REDIRECT_URI` 登记为回调域。

回调地址两侧必须逐字符一致，否则企业微信会拒绝授权。

## 相关接口

后端路由定义在 Agent Platform 的 `backend/app/api/v1/crewon_wecom.py`：

- `GET /api/v1/auth/wecom/config` — 公开，客户端据此渲染按钮
- `GET /api/v1/auth/wecom/authorize` — 发起授权跳转
- `GET /api/v1/auth/wecom/callback` — 企业微信回调
- `POST /api/v1/auth/wecom/exchange` — 用 ticket 换取会话

## 与 principal session 的区别

企业微信登录走 `/api/v1/auth/*`，与 `CREWON_PRINCIPAL_SESSION_ENABLED` 那套
`identity/v1` 信任链是两件独立的事。后者是 app-server 的运行时凭证交换，需要一组
被身份服务认可的签名密钥；关闭它不影响企业微信登录。
