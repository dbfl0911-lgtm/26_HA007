"""카카오모빌리티 길찾기 API 래퍼."""

from __future__ import annotations

import json
import queue
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from .config import settings

_API = "https://apis-navi.kakaomobility.com/v1/directions"
_cache: dict[tuple, dict] = {}  # 성공 결과만 캐시
_warned = False  # 키/호출 오류 경고를 한 번만 출력
_prefetch_q: "queue.Queue[tuple]" = queue.Queue()
_seen: set[tuple] = set()  # 이미 요청(예정)된 지점쌍
_worker_started = False


def available() -> bool:
    """길찾기 사용 가능 여부(REST 키 존재)."""
    return bool(getattr(settings, "kakao_rest_key", ""))


def _key(origin: dict, destination: dict, priority: str = "RECOMMEND", avoid: str = "") -> tuple:
    return (
        round(origin["lat"], 5), round(origin["lng"], 5),
        round(destination["lat"], 5), round(destination["lng"], 5),
        priority, avoid,
    )


def cached_route(origin: dict, destination: dict,
                 priority: str = "RECOMMEND", avoid: str = "") -> dict | None:
    """네트워크 호출 없이 캐시에 있는 도로 경로만 즉시 반환(없으면 None)."""
    return _cache.get(_key(origin, destination, priority, avoid))


def prefetch(origin: dict, destination: dict,
             priority: str = "RECOMMEND", avoid: str = "") -> None:
    """도로 경로를 백그라운드에서 미리 받아 캐시에 채우도록 예약(논블로킹)."""
    if not available():
        return
    k = _key(origin, destination, priority, avoid)
    if k in _cache or k in _seen:
        return
    _seen.add(k)
    _prefetch_q.put((origin, destination, priority, avoid))


def road_route(origin: dict, destination: dict,
               priority: str = "RECOMMEND", avoid: str = "") -> dict | None:
    """출발지→목적지의 실제 도로 경로(동기 호출, 캐시 우선)."""
    global _warned
    if not available():
        return None

    k = _key(origin, destination, priority, avoid)
    if k in _cache:
        return _cache[k]

    try:
        query = {
            "origin": f'{origin["lng"]},{origin["lat"]}',  # 주의: 경도,위도 순서
            "destination": f'{destination["lng"]},{destination["lat"]}',
            "priority": priority,
        }
        if avoid:
            query["avoid"] = avoid  # 예: toll(유료도로) 회피
        params = urllib.parse.urlencode(query)
        req = urllib.request.Request(
            f"{_API}?{params}",
            headers={
                "Authorization": f'KakaoAK {settings.kakao_rest_key}',
                "Content-Type": "application/json",
            },
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=4) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        routes = data.get("routes") or []
        if not routes or routes[0].get("result_code") not in (0, None):
            msg = routes[0].get("result_msg") if routes else "no routes"
            if not _warned:
                print(f"[routing] 경로 탐색 결과 없음 → 직선 경로로 폴백: {msg}")
                _warned = True
            return None

        r0 = routes[0]
        pts: list[dict] = []
        for sec in r0.get("sections", []):
            for road in sec.get("roads", []):
                vx = road.get("vertexes", [])
                for i in range(0, len(vx) - 1, 2):
                    pts.append({"lng": vx[i], "lat": vx[i + 1]})
        if len(pts) < 2:
            return None

        summary = r0.get("summary", {})
        fare = (summary.get("fare") or {}).get("taxi")
        result = {
            "points": pts,
            "distance_km": round(summary.get("distance", 0) / 1000.0, 2),
            "eta_min": max(1, round(summary.get("duration", 0) / 60.0)),
            "taxi_fare": int(fare) if fare else None,
        }
        _cache[k] = result
        return result

    except urllib.error.HTTPError as exc:
        # 401/403=키 권한, 400=요청/쿼터
        if not _warned:
            body = ""
            try:
                body = exc.read().decode("utf-8")[:200]
            except Exception:
                pass
            print(f"[routing] 길찾기 HTTP {exc.code} → 직선 경로로 폴백. "
                  f"{'(401/403: REST 키 권한/도메인/IP 설정 확인) ' if exc.code in (401, 403) else ''}"
                  f"응답: {body}")
            _warned = True
        return None
    except Exception as exc:
        if not _warned:
            print(f"[routing] 길찾기 호출 실패 → 직선 경로로 폴백합니다. (원인: {exc})")
            _warned = True
        return None


def route_options(origin: dict, destination: dict) -> dict:
    """고객 앱 경로 선택용."""
    recommend = road_route(origin, destination, priority="RECOMMEND")
    free = road_route(origin, destination, priority="RECOMMEND", avoid="toll")
    return {"recommend": recommend, "free": free}


def _worker() -> None:
    """예약된 지점쌍을 천천히 받아 캐시에 채운다(연속호출 제한 회피용 throttle)."""
    while True:
        origin, destination, priority, avoid = _prefetch_q.get()
        ok = False
        try:
            ok = bool(road_route(origin, destination, priority, avoid))
        except Exception:
            ok = False
        if not ok:
            # 실패 시 _seen 에서 빼서 재시도 가능하게
            _seen.discard(_key(origin, destination, priority, avoid))
        time.sleep(0.25)  # 호출 간격 (버스트 방지)


def start_worker() -> None:
    """백그라운드 프리페치 워커 시작(앱 시작 시 1회)."""
    global _worker_started
    if _worker_started or not available():
        return
    _worker_started = True
    threading.Thread(target=_worker, daemon=True, name="route-prefetch").start()
