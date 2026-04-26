"""幂等存储层：用于避免重复创建外部任务。"""

from __future__ import annotations

import hashlib
import os
import sqlite3
from datetime import datetime
from pathlib import Path


class IdempotencyStore:
    """基于 SQLite 的轻量幂等记录存储。"""

    def __init__(self, db_path: str | None = None):
        raw_path = db_path or os.getenv(
            "IDEMPOTENCY_DB_PATH", "data/idempotency.db"
        )
        self.db_path = Path(raw_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path.as_posix())
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS action_sync_map (
                    idempotency_key TEXT PRIMARY KEY,
                    meeting_id TEXT NOT NULL,
                    assignee TEXT NOT NULL,
                    task TEXT NOT NULL,
                    deadline TEXT NOT NULL,
                    jira_issue_key TEXT,
                    feishu_task_id TEXT,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )

    @staticmethod
    def build_action_key(
        meeting_id: str,
        assignee: str,
        task: str,
        deadline: str,
    ) -> str:
        """生成稳定幂等键（同会议同任务返回同 key）。"""
        normalized = "|".join(
            [
                meeting_id.strip().lower(),
                " ".join(assignee.strip().lower().split()),
                " ".join(task.strip().lower().split()),
                (deadline or "none").strip().lower(),
            ]
        )
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

    def get(self, idempotency_key: str) -> dict | None:
        """读取幂等记录。"""
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT idempotency_key, jira_issue_key, feishu_task_id, status
                FROM action_sync_map
                WHERE idempotency_key = ?
                """,
                (idempotency_key,),
            ).fetchone()
        return dict(row) if row else None

    def reserve(
        self,
        idempotency_key: str,
        meeting_id: str,
        assignee: str,
        task: str,
        deadline: str,
    ) -> bool:
        """
        预占一条记录。

        Returns:
            True: 当前调用成功抢占（首次写入）
            False: 记录已存在
        """
        now = datetime.utcnow().isoformat()
        with self._connect() as conn:
            cur = conn.execute(
                """
                INSERT OR IGNORE INTO action_sync_map (
                    idempotency_key, meeting_id, assignee, task, deadline,
                    status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
                """,
                (
                    idempotency_key,
                    meeting_id,
                    assignee,
                    task,
                    deadline or "",
                    now,
                    now,
                ),
            )
            return cur.rowcount > 0

    def save_result(
        self,
        idempotency_key: str,
        jira_issue_key: str | None,
        feishu_task_id: str | None,
        status: str = "synced",
    ) -> None:
        """保存外部系统同步结果。"""
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE action_sync_map
                SET jira_issue_key = COALESCE(?, jira_issue_key),
                    feishu_task_id = COALESCE(?, feishu_task_id),
                    status = ?,
                    updated_at = ?
                WHERE idempotency_key = ?
                """,
                (
                    jira_issue_key,
                    feishu_task_id,
                    status,
                    datetime.utcnow().isoformat(),
                    idempotency_key,
                ),
            )
