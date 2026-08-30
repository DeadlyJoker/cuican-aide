#!/usr/bin/env bash
set -euo pipefail

# Crewon 混沌工程演练脚本
# 在开发/测试环境中模拟故障注入，验证系统恢复能力
#
# 用法:
#   ./chaos-drill.sh network-delay    # 模拟网络延迟
#   ./chaos-drill.sh postgres-kill    # 模拟 PostgreSQL 主节点故障
#   ./chaos-drill.sh disk-full        # 模拟磁盘空间耗尽
#   ./chaos-drill.sh memory-pressure  # 模拟内存压力
#   ./chaos-drill.sh cpu-saturation   # 模拟 CPU 饱和
#
# 环境变量:
#   PGHOST        PostgreSQL 主机 (默认: localhost)
#   PGPORT        PostgreSQL 端口 (默认: 5432)
#   PGUSER        PostgreSQL 用户 (默认: crewon)
#   CONTROL_API_URL  Control API 地址 (默认: http://localhost:3000)
#   DURATION_SECONDS  故障持续时间 (默认: 60)

PGHOST=${PGHOST:-localhost}
PGPORT=${PGPORT:-5432}
PGUSER=${PGUSER:-crewon}
CONTROL_API_URL=${CONTROL_API_URL:-http://localhost:3000}
DURATION_SECONDS=${DURATION_SECONDS:-60}

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

drill_network_delay() {
  log "Injecting network delay: 200ms ± 50ms for $DURATION_SECONDS seconds"
  if command -v tc >/dev/null 2>&1; then
    sudo tc qdisc add dev lo root netem delay 200ms 50ms
    sleep "$DURATION_SECONDS"
    sudo tc qdisc del dev lo root netem
    log "Network delay removed"
  else
    log "WARNING: tc not available. Install iproute2 to run network delay drill."
    exit 1
  fi
}

drill_postgres_kill() {
  log "Simulating PostgreSQL primary failure"
  local pid
  pid=$(pgrep -f "postgres.*-D.*data" | head -1)
  if [[ -z "$pid" ]]; then
    log "WARNING: PostgreSQL process not found"
    exit 1
  fi

  log "Killing PostgreSQL pid $pid for $DURATION_SECONDS seconds"
  kill -STOP "$pid"
  sleep "$DURATION_SECONDS"
  kill -CONT "$pid"
  log "PostgreSQL resumed"

  log "Checking replication lag..."
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres \
    -c "SELECT client_addr, state, pg_size_pretty(pg_wal_lsn_diff(sent_lsn, flush_lsn)) AS lag FROM pg_stat_replication;" 2>/dev/null || log "Replication check failed (expected if no replica)"
}

drill_disk_full() {
  log "Simulating disk full condition"
  local temp_file="/tmp/chaos-drill-disk-fill-$$"
  dd if=/dev/zero of="$temp_file" bs=1M count=1024 status=none
  log "Created 1GB temp file to reduce available space"
  sleep "$DURATION_SECONDS"
  rm -f "$temp_file"
  log "Temp file removed, disk space restored"
}

drill_memory_pressure() {
  log "Simulating memory pressure"
  local stress_cmd
  if command -v stress >/dev/null 2>&1; then
    stress --vm 4 --vm-bytes 256M --timeout "${DURATION_SECONDS}s"
  elif command -v stress-ng >/dev/null 2>&1; then
    stress-ng --vm 4 --vm-bytes 256M --timeout "${DURATION_SECONDS}s"
  else
    log "WARNING: stress/stress-ng not available. Install to run memory pressure drill."
    exit 1
  fi
  log "Memory pressure drill completed"
}

drill_cpu_saturation() {
  log "Simulating CPU saturation"
  local stress_cmd
  if command -v stress >/dev/null 2>&1; then
    stress --cpu $(nproc) --timeout "${DURATION_SECONDS}s"
  elif command -v stress-ng >/dev/null 2>&1; then
    stress-ng --cpu $(nproc) --timeout "${DURATION_SECONDS}s"
  else
    log "WARNING: stress/stress-ng not available. Install to run CPU saturation drill."
    exit 1
  fi
  log "CPU saturation drill completed"
}

measure_health() {
  log "Measuring system health..."
  local http_status
  http_status=$(curl -s -o /dev/null -w "%{http_code}" "$CONTROL_API_URL/health" 2>/dev/null || echo "000")
  log "Control API health: HTTP $http_status"

  local pg_ready
  pg_ready=$(pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1 && echo "yes" || echo "no")
  log "PostgreSQL ready: $pg_ready"
}

main() {
  local cmd=${1:-help}

  case "$cmd" in
    network-delay)
      measure_health
      drill_network_delay
      measure_health
      ;;
    postgres-kill)
      measure_health
      drill_postgres_kill
      measure_health
      ;;
    disk-full)
      measure_health
      drill_disk_full
      measure_health
      ;;
    memory-pressure)
      measure_health
      drill_memory_pressure
      measure_health
      ;;
    cpu-saturation)
      measure_health
      drill_cpu_saturation
      measure_health
      ;;
    *)
      echo "Usage: $0 {network-delay|postgres-kill|disk-full|memory-pressure|cpu-saturation}"
      echo ""
      echo "  network-delay     Add 200ms delay to loopback interface"
      echo "  postgres-kill     STOP/CONT PostgreSQL primary process"
      echo "  disk-full         Consume 1GB disk space temporarily"
      echo "  memory-pressure   Spawn memory-hungry processes"
      echo "  cpu-saturation    Saturate all CPU cores"
      echo ""
      echo "Environment variables:"
      echo "  DURATION_SECONDS  Fault duration (default: 60)"
      echo "  CONTROL_API_URL   Health check endpoint (default: http://localhost:3000)"
      exit 1
      ;;
  esac
}

main "$@"
