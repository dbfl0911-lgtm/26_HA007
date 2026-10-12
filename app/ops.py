"""자율 관제 엔진. 브리핑·이상 감지·사전배치를 주기 실행."""
from __future__ import annotations

import re
import time

from . import area
from .llm import llm
from .simulation import (
    fleet, STATUS_WAITING, STATUS_DRIVING, STATUS_PICKUP,
    STATUS_CHARGING, STATUS_MAINTENANCE,
)

ZONES = list(area.AREA_WEIGHTS.keys())  # 정왕동 / 배곧동 / 거북섬
TOTAL_WEIGHT = sum(area.AREA_WEIGHTS.values())

# 관제 보고체 변환 — 존댓말 종결어미를 명사형으로 바꾼다
_TERSE = [
    (r"해\s*주십시오\.?$", " 요망"), (r"해\s*주세요\.?$", " 요망"),
    (r"하십시오\.?$", " 요망"), (r"하시기\s*바랍니다\.?$", " 요망"),
    (r"바랍니다\.?$", " 요망"), (r"권장합니다\.?$", " 권고"),
    (r"권고합니다\.?$", " 권고"), (r"필요합니다\.?$", " 필요"),
    (r"요구됩니다\.?$", " 필요"), (r"예상됩니다\.?$", " 예상"),
    (r"우려됩니다\.?$", " 우려"), (r"보입니다\.?$", " 보임"),
    (r"있습니다\.?$", " 있음"), (r"없습니다\.?$", " 없음"),
    (r"됩니다\.?$", "됨"), (r"집니다\.?$", "짐"),
    (r"중입니다\.?$", "중"), (r"입니다\.?$", ""), (r"합니다\.?$", ""),
]


def _terse_one(s: str) -> str:
    s = s.strip()
    for pat, rep in _TERSE:
        new = re.sub(pat, rep, s)
        if new != s:
            return re.sub(r"\s{2,}", " ", new).strip()
    return s


def terse(text: str) -> str:
    """존댓말 종결어미를 걷어내고 관제 보고체로 맞춘다. 문장이 여럿이면 ' · '로 잇는다."""
    s = str(text or "").strip()
    parts = [p for p in re.split(r"(?<=다)\.\s+", s) if p.strip()]
    out = [_terse_one(p) for p in parts]
    return " · ".join(x for x in out if x).rstrip(" .·,")


class AutoOps:
    def __init__(self) -> None:
        self.state = {"ts": None, "summary": "AI 관제 준비 중…", "recommendations": [],
                      "anomalies": [], "actions": [], "zones": [], "engine": "rule"}
        self._last_rebalance = 0.0

    # 구역별 지표
    def zone_metrics(self) -> dict:
        m = {z: {"zone": z, "total": 0, "idle": 0, "active": 0, "charging": 0,
                 "maint": 0, "low_batt": 0, "weight": area.AREA_WEIGHTS[z]}
             for z in ZONES}
        for v in fleet.vehicles.values():
            z = v.home_area if v.home_area in m else ZONES[0]
            d = m[z]
            d["total"] += 1
            if v.status == STATUS_WAITING:
                d["idle"] += 1
            elif v.status in (STATUS_DRIVING, STATUS_PICKUP):
                d["active"] += 1
            elif v.status == STATUS_CHARGING:
                d["charging"] += 1
            elif v.status == STATUS_MAINTENANCE:
                d["maint"] += 1
            if v.status != STATUS_CHARGING and v.battery <= 30:
                d["low_batt"] += 1
        return m

    # 이상 감지(D)
    def detect_anomalies(self, m: dict, demand: float) -> list:
        out = []
        total_low = sum(z["low_batt"] for z in m.values())
        total_maint = sum(z["maint"] for z in m.values())
        total_charging = sum(z["charging"] for z in m.values())
        n = max(1, len(fleet.vehicles))
        if total_maint >= 2:
            out.append({"level": "danger", "title": "사고·고장 다수",
                        "detail": f"{total_maint}대 정비 대응 중 · 복귀 일정 점검 요망"})
        if total_low >= 3:
            out.append({"level": "warn", "title": "배터리 부족",
                        "detail": f"{total_low}대 30% 이하 · 충전 배정 요망"})
        for z in m.values():
            zone_demand = demand * z["weight"] / TOTAL_WEIGHT * n
            if z["total"] > 0 and z["idle"] == 0 and zone_demand > 0.6:
                out.append({"level": "warn", "title": f"{z['zone']} 대기 차량 없음",
                            "detail": "즉시 배차 불가 · 인근 유휴차 투입 요망"})
        if total_charging >= 4:
            out.append({"level": "info", "title": "충전 집중",
                        "detail": f"{total_charging}대 동시 충전 · 가용 대수 일시 감소"})
        return out

    # 사전배치(C)
    def rebalance(self, m: dict) -> list:
        """수급 불균형 시 유휴차 1대를 부족 구역으로 사전배치(쿨다운 25초)."""
        actions = []
        now = time.time()
        if now - self._last_rebalance < 25:
            return actions
        total_idle = sum(z["idle"] for z in m.values())
        if total_idle < 2:
            return actions
        deficits = {}
        for z in m.values():
            target = total_idle * z["weight"] / TOTAL_WEIGHT
            deficits[z["zone"]] = target - z["idle"]  # +부족 / -여유
        need = max(deficits, key=deficits.get)
        surplus = min(deficits, key=deficits.get)
        if need != surplus and deficits[need] >= 1.0 and deficits[surplus] <= -1.0:
            cand = next((v for v in fleet.vehicles.values()
                         if v.home_area == surplus and v.status == STATUS_WAITING
                         and not v.incident and v.battery > 35), None)
            if cand:
                res = fleet.reposition(cand.id, need)
                if res.get("ok"):
                    self._last_rebalance = now
                    msg = f"{surplus} 유휴차 {cand.plate} → {need} 사전배치 · 수요 대비 부족"
                    fleet._log("info", cand.id, f"[AI 사전배치] {msg}")
                    actions.append({"text": msg, "from": surplus, "to": need, "plate": cand.plate})
        return actions

    # 브리핑(A)
    def _fallback_summary(self, m, clock, anomalies, actions):
        tot = sum(z["total"] for z in m.values())
        idle = sum(z["idle"] for z in m.values())
        active = sum(z["active"] for z in m.values())
        charging = sum(z["charging"] for z in m.values())
        maint = sum(z["maint"] for z in m.values())
        s = (f"운행 {active} · 대기 {idle} · 충전 {charging} · 정비 {maint} / 총 {tot}대 · "
             f"수요 {clock['demand_label']} {clock['demand_pct']}%")
        recs = [a["text"] for a in actions]
        recs += [f"{a['title']} · {a['detail']}" for a in anomalies]
        if not recs:
            recs = ["특이사항 없음 · 정상 운영"]
        return s, recs[:4]

    def _llm_briefing(self, m, clock, anomalies, actions):
        if not llm.available():
            return None
        payload = {
            "시각": clock["sim_time"],
            "수요": f"{clock['demand_label']}({clock['demand_pct']}%)",
            "구역별": {z["zone"]: {"대기": z["idle"], "운행": z["active"],
                                "충전": z["charging"], "정비": z["maint"],
                                "배터리부족": z["low_batt"]} for z in m.values()},
            "이상징후": [f"{a['title']}: {a['detail']}" for a in anomalies],
            "자동수행조치": [a["text"] for a in actions],
        }
        system = (
            "너는 로보택시 관제 AI다. 실시간 지표를 보고 상황을 요약하고 "
            "관리자가 볼 권장 조치를 1~3개 낸다.\n"
            "문체 규칙(반드시 지킬 것):\n"
            "- 존댓말 종결어미 금지. '입니다', '합니다', '하십시오', '해주세요', '바랍니다' 쓰지 마라.\n"
            "- 명사형으로 끝낸다. 예: '대기 시간 축소 요망', '충전 배정 필요', "
            "'정왕동 유휴차 2대 투입 권고', '충전 집중 · 가용 대수 감소'.\n"
            "- 항목 하나는 공백 포함 30자 이내.\n"
            "- summary 는 한 줄, 45자 이내. 숫자 위주로 적는다.\n"
            "- 이미 자동 수행한 조치는 권장 조치에 다시 쓰지 않는다.\n"
            "JSON만 출력."
        )
        hint = ('{"summary": "한 줄 요약 45자 이내", '
                '"recommendations": ["조치1 30자 이내", "조치2 30자 이내"]}')
        try:
            res = llm.generate_json(system, payload, hint)
        except Exception:
            res = None
        if not res or not res.get("summary"):
            return None
        recs = res.get("recommendations") or []
        # 모델이 규칙을 어겨도 화면 어투가 흔들리지 않게 한 번 더 다듬는다
        return terse(res["summary"]), [terse(r) for r in recs if str(r).strip()][:4]

    # 실행
    def run(self) -> dict:
        m = self.zone_metrics()
        clock = fleet.clock_state()
        demand = clock.get("demand", 0.0)
        anomalies = self.detect_anomalies(m, demand)
        actions = self.rebalance(m)
        brief = self._llm_briefing(m, clock, anomalies, actions)
        if brief is None:
            summary, recs = self._fallback_summary(m, clock, anomalies, actions)
            engine = "rule"
        else:
            summary, recs = brief
            engine = "ai"
        self.state = {
            "ts": clock["sim_time"], "summary": summary, "recommendations": recs,
            "anomalies": anomalies, "actions": actions,
            "zones": [{"zone": z["zone"], "idle": z["idle"], "active": z["active"],
                       "charging": z["charging"], "maint": z["maint"], "total": z["total"],
                       "weight": z["weight"]} for z in m.values()],
            "engine": engine,
        }
        return self.state


ops = AutoOps()
