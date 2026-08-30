#!/usr/bin/env bash
set -euo pipefail

# PostgreSQL 备份脚本
# 支持全量逻辑备份 (pg_dump) 和物理备份基准备份
#
# 用法:
#   ./backup-postgres.sh full                    # 全量逻辑备份
#   ./backup-postgres.sh base                    # 物理基准备份 (需停服或连续归档模式)
#   ./backup-postgres.sh wal                     # 强制 WAL 切换并归档
#   BACKUP_DIR=/var/backups/crewon ./backup-postgres.sh full
#
# 环境变量:
#   PGHOST        PostgreSQL 主机 (默认: localhost)
#   PGPORT        PostgreSQL 端口 (默认: 5432)
#   PGUSER        PostgreSQL 用户 (默认: crewon)
#   PGPASSWORD    PostgreSQL 密码
#   PGDATABASE    数据库名 (默认: crewon)
#   BACKUP_DIR    备份目录 (默认: ./backups)
#   RETAIN_DAYS   保留天数 (默认: 30)

PGHOST=${PGHOST:-localhost}
PGPORT=${PGPORT:-5432}
PGUSER=${PGUSER:-crewon}
PGDATABASE=${PGDATABASE:-crewon}
BACKUP_DIR=${BACKUP_DIR:-$(cd "$(dirname "$0")/../.." && pwd)/backups}
RETAIN_DAYS=${RETAIN_DAYS:-30}
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p "$BACKUP_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

check_connection() {
  if ! pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1; then
    log "ERROR: PostgreSQL is not ready at $PGHOST:$PGPORT"
    exit 1
  fi
  log "PostgreSQL connection OK ($PGHOST:$PGPORT)"
}

backup_full() {
  local out="$BACKUP_DIR/${PGDATABASE}_full_${TIMESTAMP}.sql.gz"
  log "Starting full logical backup -> $out"
  pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    --no-owner --no-privileges --clean --if-exists \
    | gzip > "$out"
  local size
  size=$(du -h "$out" | cut -f1)
  log "Full backup completed: $size"
}

backup_base() {
  local base_dir="$BACKUP_DIR/base_${TIMESTAMP}"
  log "Starting physical base backup -> $base_dir"
  mkdir -p "$base_dir"
  pg_basebackup -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" \
    -D "$base_dir" -Ft -z -P -X fetch
  local size
  size=$(du -sh "$base_dir" | cut -f1)
  log "Physical base backup completed: $size"
}

backup_wal_switch() {
  log "Forcing WAL switch and archiving"
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    -c "SELECT pg_switch_wal();" >/dev/null
  log "WAL switch triggered"
}

cleanup_old() {
  log "Cleaning up backups older than $RETAIN_DAYS days"
  find "$BACKUP_DIR" -maxdepth 1 -type f -name "*.sql.gz" -mtime +"$RETAIN_DAYS" -delete
  find "$BACKUP_DIR" -maxdepth 1 -type d -name "base_*" -mtime +"$RETAIN_DAYS" -exec rm -rf {} +
  log "Cleanup completed"
}

main() {
  local cmd=${1:-full}
  check_connection

  case "$cmd" in
    full)
      backup_full
      ;;
    base)
      backup_base
      ;;
    wal)
      backup_wal_switch
      ;;
    *)
      echo "Usage: $0 {full|base|wal}"
      exit 1
      ;;
  esac

  cleanup_old
}

main "$@"
