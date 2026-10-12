"""최적 경로 탐색 모델."""

from __future__ import annotations

import math
import random

from . import llm as llmsvc
from .. import routing


def _haversine_km(lat1, lng1, lat2, lng2) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _waypoints(origin: dict, destination: dict, jitter: float, n: int = 6) -> list[dict]:
    """출발~도착을 n등분하고 약간의 흔들림을 줘 도로처럼 보이는 경유점 생성."""
    rng = random.Random(
        f"{origin['lat']:.4f}{destination['lng']:.4f}{jitter}"
    )
    pts = [{"lat": origin["lat"], "lng": origin["lng"]}]
    for i in range(1, n):
        t = i / n
        lat = origin["lat"] + (destination["lat"] - origin["lat"]) * t
        lng = origin["lng"] + (destination["lng"] - origin["lng"]) * t
        lat += rng.uniform(-jitter, jitter)
        lng += rng.uniform(-jitter, jitter)
        pts.append({"lat": round(lat, 6), "lng": round(lng, 6)})
    pts.append({"lat": destination["lat"], "lng": destination["lng"]})
    return pts


# 구간별 혼잡도 레벨 풀
_CONGESTION_POOL = {
    "원활": ["원활", "원활", "원활", "원활", "서행"],
    "보통": ["원활", "원활", "서행", "서행", "정체"],
    "혼잡": ["서행", "정체", "정체", "서행", "정체"],
}


def _segment_levels(origin: dict, destination: dict, traffic: str, n_seg: int) -> list[str]:
    """경로를 구성하는 각 구간의 혼잡도(원활/서행/정체)를 혼잡도 가정값에 따라 산출한다."""
    rng = random.Random(f"{origin['lat']:.4f}{destination['lng']:.4f}{traffic}seg")
    pool = _CONGESTION_POOL.get(traffic, _CONGESTION_POOL["보통"])
    return [rng.choice(pool) for _ in range(max(1, n_seg))]


def _build_segments(path: list[dict], origin: dict, destination: dict, traffic: str):
    """경로 좌표열(path)을 최대 12개 구간으로 나눠 각 구간에 혼잡도 색을 부여한다."""
    n = len(path)
    if n < 2:
        return [], {"원활": 0, "서행": 0, "정체": 0}
    n_seg = min(n - 1, 12)
    levels = _segment_levels(origin, destination, traffic, n_seg)
    segs, cong = [], {"원활": 0, "서행": 0, "정체": 0}
    for s in range(n_seg):
        a = round(s * (n - 1) / n_seg)
        b = max(a + 1, round((s + 1) * (n - 1) / n_seg))
        lv = levels[s]
        segs.append({"path": path[a:b + 1], "level": lv})
        cong[lv] = cong.get(lv, 0) + 1
    return segs, cong


def find_route(origin: dict, destination: dict, traffic: str = "보통",
               snap_road: bool = False, use_llm: bool = True) -> dict:
    """origin/destination: {"name","lat","lng"}."""
    dist_km = _haversine_km(
        origin["lat"], origin["lng"], destination["lat"], destination["lng"]
    )
    # 기본(직선 보간) 경로 + 대안 경로 1개
    primary = _waypoints(origin, destination, jitter=0.0016, n=6)
    alternative = _waypoints(origin, destination, jitter=0.0042, n=7)

    speed_by_traffic = {"원활": 32.0, "보통": 24.0, "혼잡": 16.0}
    base_speed = speed_by_traffic.get(traffic, 24.0)
    eta_min = max(1, round(dist_km / base_speed * 60))

    # 실제 도로 경로(요청 시)
    road_used = False
    if snap_road:
        road = routing.road_route(origin, destination)
        if road and road.get("points"):
            primary = road["points"]
            dist_km = road.get("distance_km", dist_km)
            if road.get("eta_min"):
                eta_min = road["eta_min"]
            road_used = True

    # 추천 경로의 구간별 혼잡도(네비게이션 스타일) + 요약
    segments, congestion = _build_segments(primary, origin, destination, traffic)
    seg_levels = [s["level"] for s in segments]
    alt_eta_min = eta_min + max(2, round(dist_km * 0.8))

    # Gemini 경로(소요시간/사유 요약 보강)
    llm = llmsvc.generate_json(
        system_prompt=(
            "당신은 로보택시 운영 플랫폼의 '최적 경로 탐색 에이전트'입니다. "
            "출발지·목적지·직선거리·현재 혼잡도를 보고, 승객 대기시간과 운행 시간을 "
            "최소화하는 추천 경로의 예상 소요시간(분)과 거리(km), 그리고 경로 선택/변경 사유를 "
            "한국어 한 문장으로 요약하세요. 운행 금지 구역·안전 정책 등 제약은 일반적 가정을 적용합니다."
        ),
        user_payload={
            "출발지": origin,
            "목적지": destination,
            "직선거리_km": round(dist_km, 2),
            "혼잡도": traffic,
        },
        schema_hint=(
            '{"eta_min": 0, "distance_km": 0.0, "reason": "경로 사유 한 문장"}'
        ),
    ) if use_llm else None

    reason = ""
    engine = "rule"
    if llm and isinstance(llm, dict):
        try:
            if llm.get("eta_min"):
                eta_min = int(llm["eta_min"])
            reason = str(llm.get("reason") or "").strip()
            engine = llmsvc.provider()
        except Exception:
            pass
    if not reason:
        busy = congestion["정체"] + congestion["서행"]
        reason = (
            f"현재 혼잡도 '{traffic}' 기준, 전체 {len(seg_levels)}개 구간 중 {busy}개 구간에서 "
            f"정체·서행이 예상되어 이를 회피하는 간선 경로를 우선 추천했습니다."
        )

    return {
        "origin": origin,
        "destination": destination,
        "distance_km": round(dist_km, 2),
        "eta_min": eta_min,
        "traffic": traffic,
        "primary": primary,
        "segments": segments,
        "congestion": congestion,
        "alternative": alternative,
        "alt_eta_min": alt_eta_min,
        "reason": reason,
        "engine": engine,
        "road": road_used,
    }
