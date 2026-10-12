"""회원가입·로그인 처리."""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import sqlite3
from datetime import datetime

from .config import settings

_PBKDF2_ROUNDS = 200_000


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(settings.db_path)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """테이블 생성 + 기본 관리자 계정 시드."""
    conn = _connect()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                email      TEXT UNIQUE NOT NULL,
                name       TEXT NOT NULL,
                role       TEXT NOT NULL DEFAULT 'operator',
                pw_hash    TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.commit()
        # 처음 실행 시 바로 로그인할 수 있도록 기본 관리자 계정 생성
        cur = conn.execute("SELECT COUNT(*) AS c FROM users")
        if cur.fetchone()["c"] == 0:
            _insert_user(
                conn,
                email="admin@robotaxi.local",
                name="관제 관리자",
                password="admin1234",
                role="admin",
            )
            conn.commit()
    finally:
        conn.close()


def _hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ROUNDS)
    return f"pbkdf2_sha256${_PBKDF2_ROUNDS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, rounds, salt_hex, hash_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        salt = bytes.fromhex(salt_hex)
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, int(rounds)
        )
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


def _insert_user(conn, email, name, password, role="operator"):
    conn.execute(
        "INSERT INTO users (email, name, role, pw_hash, created_at) VALUES (?,?,?,?,?)",
        (
            email.lower().strip(),
            name.strip(),
            role,
            _hash_password(password),
            datetime.now().isoformat(timespec="seconds"),
        ),
    )


def create_user(email: str, name: str, password: str) -> tuple[bool, str]:
    """회원가입. (성공여부, 메시지) 반환."""
    email = (email or "").lower().strip()
    name = (name or "").strip()
    if "@" not in email or "." not in email:
        return False, "올바른 이메일 형식이 아닙니다."
    if len(password or "") < 6:
        return False, "비밀번호는 6자 이상이어야 합니다."
    if not name:
        return False, "이름을 입력해 주세요."
    conn = _connect()
    try:
        if conn.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
            return False, "이미 등록된 이메일입니다."
        _insert_user(conn, email, name, password)
        conn.commit()
        return True, "회원가입이 완료되었습니다. 로그인해 주세요."
    finally:
        conn.close()


def authenticate(email: str, password: str) -> dict | None:
    email = (email or "").lower().strip()
    conn = _connect()
    try:
        row = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        if row and verify_password(password, row["pw_hash"]):
            return {
                "id": row["id"],
                "email": row["email"],
                "name": row["name"],
                "role": row["role"],
            }
        return None
    finally:
        conn.close()


def get_user(user_id: int) -> dict | None:
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT id, email, name, role FROM users WHERE id=?", (user_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()
