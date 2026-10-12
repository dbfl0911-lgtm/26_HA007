"""사고·고장 대응 모델."""

from __future__ import annotations

import math
import random

from . import llm as llmsvc
from .. import area
from ..simulation import fleet, STATUS_WAITING

# 플릿 제휴 보험사 후보(차량별로 고정 배정
_INSURERS = ["삼성화재", "현대해상", "DB손해보험", "KB손해보험"]


def _km(lat1, lng1, lat2, lng2) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _nearest_repair(lat: float, lng: float):
    shops = area.REPAIR_SHOPS or area.DEPOTS
    return min(shops, key=lambda s: _km(lat, lng, s[1], s[2]))


def _replacement(exclude_id: str, lat: float, lng: float):
    """사고 차량을 대체할 가장 가까운 '대기 중' 차량(배터리 충분)."""
    cands = [
        v for v in fleet.vehicles.values()
        if v.id != exclude_id and not v.incident
        and v.status == STATUS_WAITING and v.battery >= 30
    ]
    if not cands:
        return None
    return min(cands, key=lambda v: _km(lat, lng, v.lat, v.lng))


def respond(v, use_llm: bool = True) -> dict:
    """사고 차량 v 에 대한 대응 절차를 생성한다."""
    inc = v.incident or {}
    desc = inc.get("desc", "주행 중 접촉 사고")
    shop = _nearest_repair(v.lat, v.lng)
    shop_km = round(_km(v.lat, v.lng, shop[1], shop[2]), 1)
    repl = _replacement(v.id, v.lat, v.lng)
    repl_km = round(_km(v.lat, v.lng, repl.lat, repl.lng), 1) if repl else None
    insurer = random.Random(v.id).choice(_INSURERS)

    context = {
        "사고차량": {"id": v.id, "번호판": v.plate,
                  "위치": {"lat": round(v.lat, 5), "lng": round(v.lng, 5)}},
        "사고내용": desc,
        "탑승승객/운행": v.passenger or "없음",
        "가까운정비소": {"이름": shop[0], "거리_km": shop_km},
        "대체차량": ({"번호판": repl.plate, "id": repl.id, "거리_km": repl_km}
                  if repl else "인근 가용 차량 없음"),
        "제휴보험사": insurer,
    }

    llm = llmsvc.generate_json(
        system_prompt=(
            "당신은 로보택시 플릿의 '인시던트 대응 에이전트'입니다. 접촉 사고가 발생했습니다. "
            "제공된 정보(사고차량·승객·가까운 정비소·대체차량·제휴 보험사)를 그대로 활용해, "
            "실제 운영에서 수행할 대응 절차를 순서대로 만들어 주세요. "
            "보험 접수, 승객 안전 안내 및 대체차량 인계, 사고차량 정비소 입고(견인), 사고 기록을 "
            "반드시 포함하고, 각 단계 내용은 한국어 한 문장으로 간결하게 쓰세요. "
            "정비소 이름·대체차량 번호판·보험사 이름 등 구체적 값을 문장에 포함하세요."
        ),
        user_payload=context,
        schema_hint='{"steps":[{"label":"단계명(짧게)","text":"수행 내용(한 문장)"}],"summary":"한 줄 요약"}',
    ) if use_llm else None

    engine = "rule"
    steps = None
    if llm and isinstance(llm, dict) and isinstance(llm.get("steps"), list) and llm["steps"]:
        steps = [
            {"label": str(s.get("label", "대응"))[:24], "text": str(s.get("text", "")).strip()[:200]}
            for s in llm["steps"][:6] if s.get("text")
        ]
        if steps:
            engine = llmsvc.provider()

    if not steps:
        # 규칙 기반 폴백
        repl_txt = (f"대체차량 {repl.plate}({repl.id}) 배차 — 약 {repl_km}km, 승객 인계 진행"
                    if repl else "인근 대기 차량 없음 — 재배치 에이전트에 대체차량 요청")
        passenger_txt = (f"승객({v.passenger}) 안전 확인 후 대체차량으로 인계"
                         if v.passenger else "탑승 승객 없음 — 별도 인계 불필요")
        steps = [
            {"label": "사고 접수", "text": f"{v.plate} {desc} 접수 · 현장 안전 조치 및 비상등 작동"},
            {"label": "보험사 접수", "text": f"{insurer}에 사고 접수 · 현장 사진/위치 자동 전송"},
            {"label": "승객 안내", "text": passenger_txt},
            {"label": "대체차량 배차", "text": repl_txt},
            {"label": "정비소 입고", "text": f"{shop[0]}(으)로 견인·이동 · 약 {shop_km}km"},
            {"label": "사고 기록", "text": "사고 타임라인·블랙박스 영상 자동 저장 및 보고서 생성"},
        ]

    return {
        "steps": steps,
        "engine": engine,
        "repair_shop": shop[0],
        "replacement": (repl.plate if repl else None),
        "insurer": insurer,
    }
