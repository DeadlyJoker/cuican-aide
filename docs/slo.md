# Crewon 服务级别目标 (SLO)

> 本文档定义 Crewon 核心服务的可观测性指标和 SLO。所有指标通过 Prometheus 采集，Grafana 展示。

## 1. 服务分级

| 等级 | 服务 | 描述 | SLO 目标 |
|------|------|------|----------|
| P0 | Control API | 核心控制接口 (thread/run/turn) | 99.9% |
| P0 | App Server | AI 推理服务 | 99.9% |
| P1 | Runtime Worker | 运行时任务执行 | 99.5% |
| P1 | Device Gateway | 设备网关 | 99.5% |
| P2 | Desktop Updater | 桌面客户端更新 | 99.0% |

## 2. 四大黄金信号

### 2.1 延迟 (Latency)

| 指标 | 目标 | 告警阈值 | 备注 |
|------|------|----------|------|
| `control_api_request_duration_seconds{p99}` | < 500ms | > 1s | 不含流式响应 |
| `app_server_response_duration_seconds{p99}` | < 30s | > 60s | 首 token 时间 |
| `runtime_worker_task_duration_seconds{p99}` | < 10s | > 30s | 单次任务执行 |

### 2.2 错误率 (Error Rate)

| 指标 | 目标 | 告警阈值 | 备注 |
|------|------|----------|------|
| `control_api_error_rate` | < 0.1% | > 0.5% | HTTP 5xx 比例 |
| `app_server_error_rate` | < 0.5% | > 1% | 推理失败比例 |
| `runtime_worker_error_rate` | < 1% | > 2% | 任务执行失败比例 |

### 2.3 流量 (Traffic)

| 指标 | 用途 |
|------|------|
| `control_api_requests_per_second` | 容量规划 |
| `active_threads` | 并发负载 |
| `active_runs` | 运行中任务 |

### 2.4 饱和度 (Saturation)

| 指标 | 目标 | 告警阈值 |
|------|------|----------|
| `postgres_connection_pool_usage` | < 70% | > 85% |
| `postgres_disk_usage` | < 80% | > 90% |
| `redis_memory_usage` | < 70% | > 85% |
| `cpu_usage` | < 60% | > 80% |
| `memory_usage` | < 70% | > 85% |

## 3. 自定义业务指标

| 指标 | 目标 | 说明 |
|------|------|------|
| `run_completion_rate` | > 95% | 用户发起的 run 成功完成比例 |
| `turn_latency_p95` | < 5s | 单 turn 响应时间 |
| `scheduler_admission_wait_seconds` | < 1s | 调度器准入等待时间 |
| `outbox_settlement_lag_seconds` | < 5s | 出箱结算延迟 |

## 4. 错误预算

| 服务 | SLO | 年错误预算 |
|------|-----|-----------|
| Control API | 99.9% | 8.76 小时 |
| App Server | 99.9% | 8.76 小时 |
| Runtime Worker | 99.5% | 43.8 小时 |
| Device Gateway | 99.5% | 43.8 小时 |

## 5. 告警规则 (PromQL 示例)

```promql
# Control API 错误率 > 0.5% (5m)
sum(rate(http_requests_total{job="control-api",status=~"5.."}[5m]))
  /
sum(rate(http_requests_total{job="control-api"}[5m])) > 0.005

# P99 延迟 > 1s (5m)
histogram_quantile(0.99,
  sum(rate(http_request_duration_seconds_bucket{job="control-api"}[5m])) by (le)
) > 1

# PostgreSQL 连接池 > 85%
postgres_connection_pool_active / postgres_connection_pool_max > 0.85
```

## 6. 仪表盘 (Grafana)

- **Overview**: 全局服务健康状态
- **Control API**: 请求延迟、错误率、QPS
- **App Server**: 推理延迟、token 吞吐量、模型可用性
- **Runtime Worker**: 任务队列深度、执行时间、失败率
- **PostgreSQL**: 连接数、查询延迟、锁等待、复制延迟
- **Infrastructure**: CPU/内存/磁盘/网络

## 7. 演练计划

| 演练类型 | 频率 | 目标 |
|----------|------|------|
| 备份恢复演练 | 每月 | RTO < 30min, RPO < 5min |
| 故障切换演练 | 每季度 | 主从切换 < 60s |
| 容量压力测试 | 每半年 | 验证 2x 峰值承载能力 |
| 混沌工程 | 每季度 | 随机注入网络/节点故障 |
