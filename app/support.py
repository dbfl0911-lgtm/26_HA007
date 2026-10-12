"""상담사 연결. 고객 앱과 관리자 대시보드 간 채팅."""
from __future__ import annotations

import time
from datetime import datetime

from .simulation import fleet, KST


def _hm() -> str:
    return datetime.now(KST).strftime("%H:%M")


class SupportService:
    def __init__(self) -> None:
        # session_id -> 상담 세션 정보
        self.rooms: dict[str, dict] = {}

    # 공통
    def _room(self, sid: str) -> dict:
        r = self.rooms.get(sid)
        if not r:
            r = {"session": sid, "status": "waiting",  # waiting → active → closed
                 "messages": [], "created": time.time(),
                 "unread_admin": 0, "unread_user": 0,
                 "vehicle": None, "dest": None, "agent": None}
            self.rooms[sid] = r
        return r

    def _add(self, r: dict, who: str, text: str) -> dict:
        m = {"who": who, "text": text, "time": _hm(), "ts": time.time()}
        r["messages"].append(m)
        del r["messages"][:-200]
        if who == "user":
            r["unread_admin"] += 1
        elif who == "admin":
            r["unread_user"] += 1
        return m

    # 고객 측
    def request(self, sid: str, context: dict | None = None) -> dict:
        """고객이 '상담사연결'을 누름 → 상담 요청 생성."""
        r = self._room(sid)
        if r["status"] == "closed":
            r["status"] = "waiting"
            r["messages"] = []
            r["unread_admin"] = r["unread_user"] = 0
        if r["status"] == "waiting" and not r["messages"]:
            self._add(r, "system", "상담사 연결을 요청했습니다.")
        ctx = context or {}
        r["vehicle"] = ctx.get("plate") or r["vehicle"]
        r["dest"] = ctx.get("dest") or r["dest"]
        return {"ok": True, "status": r["status"],
                "reply": "상담사를 연결 중입니다. 잠시만 기다려 주세요."}

    def user_send(self, sid: str, text: str) -> dict:
        r = self._room(sid)
        if r["status"] == "closed":
            return {"ok": False, "msg": "상담이 종료되었습니다."}
        self._add(r, "user", text)
        return {"ok": True, "status": r["status"]}

    def user_poll(self, sid: str, after: float = 0.0) -> dict:
        """고객 앱이 주기적으로 호출."""
        r = self.rooms.get(sid)
        if not r:
            return {"active": False, "status": "none", "messages": []}
        msgs = [m for m in r["messages"] if m["ts"] > after and m["who"] != "user"]
        r["unread_user"] = 0
        return {"active": r["status"] != "closed", "status": r["status"],
                "agent": r["agent"], "messages": msgs,
                "last_ts": r["messages"][-1]["ts"] if r["messages"] else 0.0}

    def user_close(self, sid: str) -> dict:
        r = self.rooms.get(sid)
        if r:
            self._add(r, "system", "고객이 상담을 종료했습니다.")
            r["status"] = "closed"
        return {"ok": True}

    # 관리자 측
    def rooms_list(self) -> list[dict]:
        """대시보드 목록."""
        out = []
        for r in self.rooms.values():
            if r["status"] == "closed":
                continue
            last = r["messages"][-1]["text"] if r["messages"] else ""
            out.append({
                "session": r["session"], "status": r["status"],
                "unread": r["unread_admin"], "last": last[:40],
                "vehicle": r["vehicle"], "dest": r["dest"],
                "waited_sec": int(time.time() - r["created"]),
            })
        out.sort(key=lambda x: (x["status"] != "waiting", -x["unread"]))
        return out

    def accept(self, sid: str, agent: str = "관제사") -> dict:
        r = self.rooms.get(sid)
        if not r:
            return {"ok": False, "msg": "상담 요청이 없습니다."}
        if r["status"] == "waiting":
            r["status"] = "active"
            r["agent"] = agent
            self._add(r, "system", "상담사가 연결되었습니다.")
        return {"ok": True, "status": r["status"]}

    def admin_send(self, sid: str, text: str, agent: str = "관제사") -> dict:
        r = self.rooms.get(sid)
        if not r:
            return {"ok": False, "msg": "상담 요청이 없습니다."}
        if r["status"] == "waiting":
            self.accept(sid, agent)
        self._add(r, "admin", text)
        return {"ok": True}

    def admin_history(self, sid: str) -> dict:
        r = self.rooms.get(sid)
        if not r:
            return {"ok": False, "messages": []}
        r["unread_admin"] = 0
        return {"ok": True, "status": r["status"], "agent": r["agent"],
                "vehicle": r["vehicle"], "dest": r["dest"],
                "messages": r["messages"]}

    def admin_close(self, sid: str) -> dict:
        r = self.rooms.get(sid)
        if r:
            self._add(r, "system", "상담사가 상담을 종료했습니다.")
            r["status"] = "closed"
        return {"ok": True}

    def waiting_count(self) -> int:
        return sum(1 for r in self.rooms.values() if r["status"] == "waiting")


support = SupportService()
