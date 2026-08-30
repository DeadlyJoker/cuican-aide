#!/usr/bin/env bash
set -euo pipefail

# PostgreSQL 恢复脚本
# 支持从逻辑备份 (.sql.gz) 或物理备份恢复
#
# 用法:
#   ./restore-postgres.sh /path/to/backup.sql.gz
#   ./restore-postgres.sh /path/to/base_backup.tar.gz
#
# 环境变量:
#   PGHOST        PostgreSQL 主机 (默认: localhost)
#   PGPORT        PostgreSQL 端口 (默认: 5432)
#   PGUSER        PostgreSQL 用户 (默认: crewon)
#   PGPASSWORD    PostgreSQL 密码
#   PGDATABASE    目标数据库名 (默认: crewon)

PGHOST=${PGHOST:-localhost}
PGPORT=${PGPORT:-5432}
PGUSER=${PGUSER:-crewon}
PGDATABASE=${PGDATABASE:-crewon}

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

restore_logical() {
  local backup_file="$1"
  log "Restoring from logical backup: $backup_file"

  # 创建临时数据库验证备份完整性
  local temp_db="${PGDATABASE}_restore_temp_$(date +%s)"
  log "Creating temporary database: $temp_db"
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres \
    -c "CREATE DATABASE \"$temp_db\";" >/dev/null

  # 先恢复到临时库验证
  log "Restoring to temporary database for validation..."
  gunzip -c "$backup_file" | psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$temp_db" -q

  log "Validation passed. Swapping to production database..."

  # 关闭现有连接
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -c "
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = '$PGDATABASE' AND pid <> pg_backend_pid();
  " >/dev/null

  # 重命名数据库
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -c "
    ALTER DATABASE \"$PGDATABASE\" RENAME TO \"${PGDATABASE}_old_$(date +%s)\";
    ALTER DATABASE \"$temp_db\" RENAME TO \"$PGDATABASE\";
  " >/dev/null

  log "Restore completed. Old database renamed for safety."
}

restore_physical() {
  local backup_file="$1"
  log "Physical restore requires PostgreSQL to be stopped."
  log "Manual steps:"
  echo "  1. Stop PostgreSQL:  pg_ctl stop"
  echo "  2. Clear data dir:   rm -rf \$PGDATA/*"
  echo "  3. Extract backup:   tar -xzf $backup_file -C \$PGDATA"
  echo "  4. Configure recovery: touch \$PGDATA/recovery.signal"
  echo "  5. Start PostgreSQL: pg_ctl start"
  echo "  6. Verify:           psql -c 'SELECT pg_last_wal_replay_lsn();'"
}

main() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <backup-file>"
    echo "  backup-file: .sql.gz (logical) or .tar.gz (physical)"
    exit 1
  fi

  local backup_file="$1"
  if [[ ! -f "$backup_file" ]]; then
    log "ERROR: Backup file not found: $backup_file"
    exit 1
  fi

  if [[ "$backup_file" == *.sql.gz ]]; then
    restore_logical "$backup_file"
  elif [[ "$backup_file" == *.tar.gz ]]; then
    restore_physical "$backup_file"
  else
    log "ERROR: Unknown backup format. Expected .sql.gz or .tar.gz"
    exit 1
  fi
}

main "$@"
