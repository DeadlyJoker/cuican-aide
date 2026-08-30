# Crewon 生产部署指南

> 本文档描述 Crewon 多租户生产环境的部署拓扑和配置。当前为模板状态，需根据实际基础设施调整。

## 1. 部署拓扑

```
┌─────────────────────────────────────────────────────────────┐
│                        Load Balancer                         │
│                    (TLS termination)                          │
└──────────────────────┬──────────────────────────────────────┘
                       │
       ┌───────────────┼───────────────┐
       │               │               │
┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
│ Control API │ │ Control API │ │ Control API │
│   (P0)      │ │   (P0)      │ │   (P0)      │
└──────┬──────┘ └──────┬──────┘ └──────┬──────┘
       │               │               │
       └───────────────┼───────────────┘
                       │
       ┌───────────────┼───────────────┐
       │               │               │
┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
│ App Server  │ │ App Server  │ │ App Server  │
│   (P0)      │ │   (P0)      │ │   (P0)      │
└──────┬──────┘ └──────┬──────┘ └──────┬──────┘
       │               │               │
       └───────────────┼───────────────┘
                       │
       ┌───────────────┼───────────────┐
       │               │               │
┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
│ Runtime     │ │ Runtime     │ │ Runtime     │
│ Worker (P1) │ │ Worker (P1) │ │ Worker (P1) │
└──────┬──────┘ └──────┬──────┘ └──────┬──────┘
       │               │               │
       └───────────────┼───────────────┘
                       │
       ┌───────────────┼───────────────┐
       │               │               │
┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
│  PostgreSQL │ │  PostgreSQL │ │   Redis     │
│   (Primary) │ │  (Replica)  │ │  (Cache)    │
└─────────────┘ └─────────────┘ └─────────────┘
```

## 2. 环境变量配置

### 2.1 Control API

```bash
# 基础
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# 数据库
DATABASE_URL=postgresql://crewon:PASSWORD@postgres-primary:5432/crewon
DATABASE_POOL_SIZE=20

# Redis (session/cache)
REDIS_URL=redis://redis:6379

# 多租户
TENANT_ISOLATION_MODE=strict  # strict | shared
DEFAULT_TENANT_ID=default

# 安全
JWT_SECRET=REPLACE_WITH_256BIT_SECRET
SESSION_TIMEOUT_SECONDS=3600

# 模型提供商
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

### 2.2 App Server

```bash
CREWON_CONTROL_API_URL=http://control-api:3000
CREWON_APP_SERVER_PORT=3001
CREWON_MODEL_PROVIDER=openai
CREWON_MAX_CONCURRENT_RUNS=10
```

### 2.3 Runtime Worker

```bash
CREWON_CONTROL_API_URL=http://control-api:3000
CREWON_WORKER_QUEUE_NAME=default
CREWON_WORKER_CONCURRENCY=5
```

## 3. Docker Compose (开发/测试)

```yaml
# docker-compose.yml (示例)
version: "3.8"

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: crewon
      POSTGRES_PASSWORD: crewon
      POSTGRES_DB: crewon
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    command: >
      postgres
      -c wal_level=replica
      -c max_wal_senders=3
      -c max_replication_slots=3

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  control-api:
    build: ./apps/control-api
    environment:
      DATABASE_URL: postgresql://crewon:crewon@postgres:5432/crewon
      REDIS_URL: redis://redis:6379
    depends_on:
      - postgres
      - redis
    ports:
      - "3000:3000"

  runtime-worker:
    build: ./apps/runtime-worker
    environment:
      CREWON_CONTROL_API_URL: http://control-api:3000
    depends_on:
      - control-api

volumes:
  postgres_data:
```

## 4. Kubernetes (生产)

### 4.1 Namespace 隔离

```yaml
# 按租户隔离 (可选)
apiVersion: v1
kind: Namespace
metadata:
  name: crewon-tenant-a
  labels:
    tenant-id: tenant-a
```

### 4.2 关键配置

- **HPA**: Control API `minReplicas=3, maxReplicas=20`, targetCPU=60%
- **PodDisruptionBudget**: `minAvailable=2` for Control API
- **Resource Limits**:
  - Control API: `cpu: 2, memory: 4Gi`
  - App Server: `cpu: 4, memory: 8Gi` (GPU node)
  - Runtime Worker: `cpu: 1, memory: 2Gi`
- **NetworkPolicy**: 仅允许 Control API → PostgreSQL, Runtime Worker → Control API

## 5. 灾备策略

| RTO | RPO | 策略 |
|-----|-----|------|
| < 30min | < 5min | PostgreSQL 流复制 + WAL 归档 + 定期基准备份 |
| < 4h | < 1h | 跨区域副本 + 自动化故障切换 (patroni) |

### 5.1 PostgreSQL 高可用

```bash
# 使用 patroni + etcd 实现自动故障切换
# primary 故障时，patroni 自动 promote replica

# 验证复制状态
psql -c "SELECT client_addr, state, sync_state FROM pg_stat_replication;"
```

## 6. 监控接入

```bash
# Prometheus 采集端点
/control-api/metrics   # HTTP 指标
/runtime-worker/metrics
/postgres/metrics      # postgres_exporter
/redis/metrics         # redis_exporter

# 健康检查
/control-api/health    # HTTP 200 + JSON 状态
/runtime-worker/health
```

## 7. 安全检查清单

- [ ] TLS 1.3 仅启用强密码套件
- [ ] PostgreSQL SSL 连接强制
- [ ] Redis AUTH 认证
- [ ] JWT secret 定期轮换
- [ ] 容器镜像安全扫描 (trivy/snyk)
- [ ] 网络策略限制 Pod 间通信
- [ ] 审计日志持久化到独立存储
- [ ] 生产环境关闭 debug/trace 日志
