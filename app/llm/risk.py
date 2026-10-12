"""위험 분석 모델."""

from __future__ import annotations

from . import llm as llmsvc
from ..simulation import Vehicle


def _grade(score: int) -> str:
    if score >= 75:
        return "위험"
    if score >= 45:
        return "주의"
    return "양호"


def _build_signals(v: Vehicle) -> dict:
    """차량 상태로부터 위험 분석에 쓸 신호를 구성(데모용 합성 지표 포함)."""
    # 합성 센서 지표
    temp = 28 + (100 - v.battery) * 0.15
    vibration = round(0.2 + (100 - v.cleanliness) * 0.01, 2)
    return {
        "vehicle_id": v.id,
        "plate": v.plate,
        "battery": round(v.battery, 1),
        "battery_state": v.battery_state,
        "status": v.status,
        "speed_kmh": round(v.speed, 0),
        "cleanliness": round(v.cleanliness, 0),
        "rating": v.rating,
        "estimated_temp_c": round(temp, 1),
        "vibration_g": vibration,
        "active_incident": v.incident,
    }


def _rule_based(signals: dict) -> dict:
    score = 8
    factors = []
    if signals["active_incident"]:
        kind = signals["active_incident"]["type"]
        if kind == "ACCIDENT":
            score += 70
            factors.append("진행 중 사고 이벤트")
            fault = "사고 — 차체/센서 점검 필요"
        else:
            score += 55
            factors.append("배터리 방전/고장 이벤트")
            fault = "방전 — 견인 및 충전 필요"
    else:
        fault = "특이 고장 징후 없음"

    if signals["battery_state"] == "DANGER":
        score += 25
        factors.append(f"배터리 위험({signals['battery']}%)")
    elif signals["battery_state"] == "CAUTION":
        score += 12
        factors.append(f"배터리 주의({signals['battery']}%)")

    if signals["estimated_temp_c"] >= 42:
        score += 12
        factors.append(f"배터리 온도 상승({signals['estimated_temp_c']}℃)")
    if signals["vibration_g"] >= 0.6:
        score += 10
        factors.append(f"진동 이상({signals['vibration_g']}G)")
    if signals["cleanliness"] <= 45:
        score += 5
        factors.append("청결 점수 저하")

    score = min(100, score)
    grade = _grade(score)
    immediate = score >= 75
    if immediate:
        recommend = "즉시 운행 제한 후 정비 전환 / 필요 시 견인·대체차 배차"
    elif score >= 45:
        recommend = "예방 점검 일정 등록, 다음 충전 시 정비 항목 확인"
    else:
        recommend = "정상 운행 유지, 주기 모니터링"

    return {
        "score": score,
        "grade": grade,
        "fault_type": fault,
        "immediate_action": immediate,
        "recommendation": recommend,
        "factors": factors or ["주요 위험 요인 없음"],
        "engine": "rule",
    }


def analyze(v: Vehicle, use_llm: bool = True) -> dict:
    signals = _build_signals(v)

    llm = llmsvc.generate_json(
        system_prompt=(
            "당신은 로보택시 운영 플랫폼의 '위험 분석 에이전트'입니다. "
            "차량의 센서·주행·상태 지표와 사고/고장 이벤트를 종합해 사고·고장·운행중단 "
            "가능성을 평가합니다. 위험 점수(0~100 정수), 등급(양호/주의/위험), 예상 고장/사고 유형, "
            "즉시 조치 필요 여부(boolean), 권고 조치(한국어 한 문장), 핵심 위험요인 목록을 산출하세요."
        ),
        user_payload={"signals": signals},
        schema_hint=(
            '{"score": 0, "grade": "양호|주의|위험", "fault_type": "문자열", '
            '"immediate_action": true, "recommendation": "문장", '
            '"factors": ["요인1","요인2"]}'
        ),
    ) if use_llm else None

    if llm and isinstance(llm, dict) and "score" in llm:
        try:
            score = int(max(0, min(100, int(llm["score"]))))
            result = {
                "score": score,
                "grade": str(llm.get("grade") or _grade(score)),
                "fault_type": str(llm.get("fault_type") or "분석 결과"),
                "immediate_action": bool(llm.get("immediate_action")),
                "recommendation": str(llm.get("recommendation") or ""),
                "factors": list(llm.get("factors") or []) or ["주요 위험 요인 없음"],
                "engine": llmsvc.provider(),
            }
            result["signals"] = signals
            return result
        except Exception:
            pass

    result = _rule_based(signals)
    result["signals"] = signals
    return result
