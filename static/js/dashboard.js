/* =========================================================================
   대시보드 클라이언트 로직
   - WebSocket(/ws)으로 플릿 스냅샷을 받아 실시간 갱신
   - 카카오맵 위에 차량 마커(배터리 상태별 색상) 표시 + 클릭 시 상세 말풍선
   - KPI 카드, 운행 현황 도넛, 알림 패널 갱신
   - '호출 배차 시뮬레이션' 버튼 → 배정/경로 LLM 모델 실행 후 경로 표시
   ========================================================================= */

const STATUS_KEYS = ["DRIVING", "WAITING", "CHARGING", "MAINTENANCE"];   // 도넛: 운행중 = 손님맞이+목적지이동 합산
const STATUS_LABEL = { DRIVING: "운행중", WAITING: "대기중", CHARGING: "충전중", MAINTENANCE: "점검중" };
const STATUS_COLOR = { DRIVING: "#36b37e", WAITING: "#2f6fed", CHARGING: "#f5b301", MAINTENANCE: "#e5484d" };
// 도넛/범례용 집계: 운행중은 손님맞이중(PICKUP)+목적지이동중(DRIVING)을 합쳐서 센다.
function donutCount(counts, k) {
  return k === "DRIVING" ? (counts.PICKUP || 0) + (counts.DRIVING || 0) : (counts[k] || 0);
}
const STATE_CHIP_COLOR = { PICKUP: "#14b8a6", DRIVING: "#36b37e", WAITING: "#2f6fed", CHARGING: "#f5b301", MAINTENANCE: "#e5484d" };

let map = null;
let overlays = {};      // id -> kakao CustomOverlay
let markerEls = {};     // id -> DOM element
let openVehicleId = null;

/* ----------------------------------------------------- 차량 경로 표시(hover/클릭) */
let routeLine = null;       // 현재 그려진 경로 폴리라인
let routePinnedId = null;   // 클릭으로 고정된 차량 id
let routeHoverId = null;    // 마우스 오버 중인 차량 id

function colorForKind(v) {
  if (v.towing) return "#e5742a";            // 견인 → 정비소
  if (v.status === "CHARGING") return "#f5b301";   // 충전소로
  if (v.status === "PICKUP") return "#14b8a6";     // 손님 맞이
  return "#2f6fed";                          // 목적지 이동
}

// 배터리 잔량 → 차량 이미지(빨강 위험 ≤30 / 노랑 주의 ≤50 / 정상은 원래 남색 차량).
// 대형(SUV)은 형태가 다른 전용 아이콘(루프랙·박스형 차체)을 쓴다.
function carImg(v) {
  const suv = v.car_type === "SUV";
  const b = v.battery;
  if (b <= 30) return suv ? "/static/img/suv_red.png" : "/static/img/car_red.png";
  if (b <= 50) return suv ? "/static/img/suv_yellow.png" : "/static/img/car_yellow.png";
  return suv ? "/static/img/suv.png" : "/static/img/car.png";
}

// 고정(클릭) 차량 우선, 없으면 hover 차량의 경로를 최신 좌표로 다시 그린다.
function refreshRoute() {
  const id = routePinnedId || routeHoverId;
  if (!id || !map) { if (routeLine) routeLine.setMap(null); return; }
  const v = latestById[id];
  const r = (v && v.route) || [];
  if (r.length < 2) { if (routeLine) routeLine.setMap(null); return; }
  const pts = r.map((p) => new kakao.maps.LatLng(p.lat, p.lng));
  if (!routeLine) {
    routeLine = new kakao.maps.Polyline({
      strokeWeight: 6, strokeOpacity: 0.9, strokeStyle: "solid",
    });
  }
  routeLine.setPath(pts);
  routeLine.setOptions({ strokeColor: colorForKind(v) });
  routeLine.setMap(map);
}
let latestById = {};    // id -> vehicle dict (가장 최근 스냅샷)
let donutChart = null;

// --- 부드러운 이동(보간) 상태 ---
// 서버는 갱신 주기(기본 2초)마다 위치를 보내므로, 마커가 순간이동하지 않도록
// 이전 위치→새 위치 사이를 매 프레임 조금씩 이동시켜 부드럽게 보이게 한다.
let posState = {};      // id -> {fromLat,fromLng,curLat,curLng,tgtLat,tgtLng,start,dur,done}
let lastSnapAt = 0;     // 직전 스냅샷 수신 시각(ms)
let glideMs = 2000;     // 이번 보간에 쓸 시간(실제 갱신 간격에 맞춤)

const won = (n) => n.toLocaleString("ko-KR");
const carEmoji = "🚗";

/* ------------------------------------------------------------------ 지도 */
function initMap() {
  if (!window.kakao || !kakao.maps) {
    console.warn("카카오맵 SDK 로드 실패 — 도메인 등록/네트워크 확인 필요");
    return;
  }
  kakao.maps.load(() => {
    const c = window.APP.center;
    map = new kakao.maps.Map(document.getElementById("map"), {
      center: new kakao.maps.LatLng(c.lat, c.lng),
      level: 5,
    });
    kakao.maps.event.addListener(map, "click", closeInfo);
    // 지도를 축소하면 고정 크기 마커가 실제로 수백 m 를 덮어 도로를 벗어난 것처럼 보인다.
    // → 줌 레벨에 맞춰 차량 아이콘 크기를 조절한다.
    kakao.maps.event.addListener(map, "zoom_changed", applyZoomScale);
    applyZoomScale();
  });
}

/* 줌 레벨별 차량 아이콘 크기(px). 레벨이 클수록(축소) 작게. */
/* 줌 레벨별 차량 아이콘 크기(px).
   지도를 축소하면 1px 이 덮는 실제 거리가 급격히 커진다(레벨7 ≈ 16m/px).
   아이콘 크기를 그대로 두면 도로 폭(10~20m)의 수십 배를 덮어, 위치가 정확해도
   차가 하천·건물 위에 있는 것처럼 보인다. → 축소할수록 아주 작게 줄이고,
   레벨 8 이상에서는 '점(dot)' 형태로 바꿔 도로 위에 정확히 얹히도록 한다. */
function applyZoomScale() {
  if (!map) return;
  const lv = map.getLevel();
  // 카카오맵 축척(대략 m/px): 3→1, 4→2, 5→4, 6→8, 7→16, 8→32 ...
  // 축소할수록 아이콘 1px 이 덮는 실제 거리가 커져, 차 그림이 도로(폭 10~20m)를 벗어나 보인다.
  // → 레벨 6 부터는 차 그림 대신 '작은 점'으로 바꿔 도로 위에 정확히 얹히게 한다.
  const size = lv <= 2 ? 44 : lv === 3 ? 32 : lv === 4 ? 22 : lv === 5 ? 18
             : lv === 6 ? 10 : lv === 7 ? 8 : lv === 8 ? 7 : 6;
  document.documentElement.style.setProperty("--veh-size", size + "px");
  // 레벨 5+ : 번호 배지·부가 아이콘 숨김(아이콘이 작아 글자가 안 보임)
  document.body.classList.toggle("map-far", lv >= 5);
  // 레벨 6+ : 차량 그림 대신 작은 점으로 표시(도로를 덮지 않도록)
  document.body.classList.toggle("map-dot", lv >= 6);
}

function makeMarkerEl(v) {
  const el = document.createElement("div");
  el.className = "veh-marker";
  el.innerHTML = `
    <div class="veh-body">
      <img class="veh-car" src="/static/img/car.png" alt="차량">
      <span class="veh-num"></span>
      <span class="veh-tow" title="견인 중">🚛</span>
      <span class="veh-repl" title="대체 차량">대체</span>
    </div>
    <div class="veh-info" style="display:none;"></div>`;
  el.querySelector(".veh-body").addEventListener("click", (e) => {
    e.stopPropagation();
    openVehicleId === v.id ? closeInfo() : openInfo(v.id);
  });
  // 마우스를 올리면 그 차량의 현재 경로를 미리 보여준다(클릭 고정이 없을 때만).
  const body = el.querySelector(".veh-body");
  body.addEventListener("mouseenter", () => {
    if (routePinnedId) return;
    routeHoverId = v.id;
    refreshRoute();
  });
  body.addEventListener("mouseleave", () => {
    if (routePinnedId) return;
    routeHoverId = null;
    refreshRoute();
  });
  return el;
}

function ensureMarker(v) {
  if (overlays[v.id]) return;
  const el = makeMarkerEl(v);
  markerEls[v.id] = el;
  overlays[v.id] = new kakao.maps.CustomOverlay({
    position: new kakao.maps.LatLng(v.lat, v.lng),
    content: el,
    xAnchor: 0.5,
    yAnchor: 0.5,
    zIndex: 3,
  });
  overlays[v.id].setMap(map);
  posState[v.id] = {
    fromLat: v.lat, fromLng: v.lng, curLat: v.lat, curLng: v.lng,
    tgtLat: v.lat, tgtLng: v.lng, start: performance.now(), dur: glideMs, done: true,
    route: v.route || [], path: null, cum: null, total: 0,
    routeSeq: v.route_seq,
  };
}

/* ----------------------------------------------------- 충전소(차고지) 마커 */
let depotOverlays = {};
let depotEls = {};
function renderDepots(depots) {
  if (!depots || !map) return;
  depots.forEach((d) => {
    if (!depotOverlays[d.name]) {
      const el = document.createElement("div");
      el.className = "depot-marker";
      el.title = d.name;
      const shortName = d.name.replace("충전 차고지", "충전소");
      el.innerHTML =
        '<div class="depot-icon"><span class="depot-bolt">⚡</span>' +
        '<span class="depot-badge">0</span></div>' +
        '<div class="depot-label"></div>';
      el.querySelector(".depot-label").textContent = shortName;
      depotEls[d.name] = el;
      const ov = new kakao.maps.CustomOverlay({
        position: new kakao.maps.LatLng(d.lat, d.lng),
        content: el, xAnchor: 0.5, yAnchor: 0.5, zIndex: 2,
      });
      ov.setMap(map);
      depotOverlays[d.name] = ov;
    }
    const el = depotEls[d.name];
    el.querySelector(".depot-badge").textContent = d.charging;
    el.classList.toggle("active", d.charging > 0);
  });
}

/* ----------------------------------------------------- 정비센터(수리소) 마커 */
let shopOverlays = {};
let shopEls = {};
function renderShops(shops) {
  if (!shops || !map) return;
  shops.forEach((s) => {
    if (!shopOverlays[s.name]) {
      const el = document.createElement("div");
      el.className = "shop-marker";
      el.title = s.name;
      el.innerHTML =
        '<div class="shop-icon"><span class="shop-wrench">🔧</span>' +
        '<span class="shop-badge">0</span></div>' +
        '<div class="shop-label"></div>';
      el.querySelector(".shop-label").textContent = s.name;
      shopEls[s.name] = el;
      const ov = new kakao.maps.CustomOverlay({
        position: new kakao.maps.LatLng(s.lat, s.lng),
        content: el, xAnchor: 0.5, yAnchor: 0.5, zIndex: 2,
      });
      ov.setMap(map);
      shopOverlays[s.name] = ov;
    }
    const el = shopEls[s.name];
    el.querySelector(".shop-badge").textContent = s.repairing;
    el.classList.toggle("active", s.repairing > 0);
  });
}

/* ----------------------------------------------------- 견인차 마커 */
let towOverlays = {};
function renderTows(tows) {
  if (!map) return;
  const seen = new Set();
  (tows || []).forEach((t) => {
    seen.add(t.id);
    const pos = new kakao.maps.LatLng(t.lat, t.lng);
    if (!towOverlays[t.id]) {
      const el = document.createElement("div");
      el.className = "tow-marker";
      el.innerHTML = `<span class="tow-ico">🚛</span><span class="tow-lbl"></span>`;
      towOverlays[t.id] = { ov: new kakao.maps.CustomOverlay({ position: pos, content: el, zIndex: 8 }), el };
      towOverlays[t.id].ov.setMap(map);
    }
    const o = towOverlays[t.id];
    o.ov.setPosition(pos);
    o.el.querySelector(".tow-lbl").textContent = t.phase === "to_vehicle" ? "출동중" : "견인중";
    o.el.classList.toggle("towing", t.phase === "to_shop");
  });
  Object.keys(towOverlays).forEach((id) => {
    if (!seen.has(id)) { towOverlays[id].ov.setMap(null); delete towOverlays[id]; }
  });
}

/* ----------------------------------------------------- 119 구급차 마커 */
let ambOverlays = {};
function renderAmbulances(list) {
  if (!map) return;
  const seen = new Set();
  (list || []).forEach((a) => {
    seen.add(a.id);
    const pos = new kakao.maps.LatLng(a.lat, a.lng);
    if (!ambOverlays[a.id]) {
      const el = document.createElement("div");
      el.className = "amb-marker";
      el.innerHTML = `<span class="amb-ico">🚑</span><span class="amb-lbl"></span>`;
      ambOverlays[a.id] = { ov: new kakao.maps.CustomOverlay({ position: pos, content: el, zIndex: 9 }), el };
      ambOverlays[a.id].ov.setMap(map);
    }
    const o = ambOverlays[a.id];
    o.ov.setPosition(pos);
    o.el.querySelector(".amb-lbl").textContent =
      a.phase === "to_scene" ? "출동중" : a.phase === "onscene" ? "응급처치" : "이송중";
    o.el.classList.toggle("onscene", a.phase === "onscene");
  });
  Object.keys(ambOverlays).forEach((id) => {
    if (!seen.has(id)) { ambOverlays[id].ov.setMap(null); delete ambOverlays[id]; }
  });
}

function updateMarker(v) {
  ensureMarker(v);
  // 위치는 즉시 옮기지 않고 '목표'만 갱신 → 애니메이션 루프가 부드럽게 이동시킨다.
  const p = posState[v.id];
  const el = markerEls[v.id];
  if (p) {
    // 경로가 새로 계산된 경우(목적지 변경·경유지 추가 등)에는 예전 경로를 따라 보간하면
    // 차가 반대 방향으로 되돌아가는 것처럼 보인다. → 보간을 리셋하고 새 위치에서 이어간다.
    if (p.routeSeq !== v.route_seq) {
      p.routeSeq = v.route_seq;
      p.route = v.route || [];
      p.curLat = v.lat; p.curLng = v.lng;
      p.fromLat = v.lat; p.fromLng = v.lng;
      p.tgtLat = v.lat; p.tgtLng = v.lng;
      p.path = null; p.cum = null; p.total = 0;
      p.done = true;
      if (overlays[v.id]) overlays[v.id].setPosition(new kakao.maps.LatLng(v.lat, v.lng));
    } else if (Math.hypot((v.lat - p.curLat) * 111, (v.lng - p.curLng) * 88) > 0.25) {
      // 200m 넘게 튄 경우(스냅·재배치 등) — 보간하지 않고 즉시 새 위치로
      p.route = v.route || [];
      p.curLat = v.lat; p.curLng = v.lng;
      p.tgtLat = v.lat; p.tgtLng = v.lng;
      p.path = null; p.total = 0; p.done = true;
      if (overlays[v.id]) overlays[v.id].setPosition(new kakao.maps.LatLng(v.lat, v.lng));
    } else {
      // 직선으로 건물·하천을 가로지르지 않도록, 직전 스냅샷의 '도로 경로'를 따라 이동시킨다.
      // prevRoute = 이전 위치에서 시작하는 남은 도로 좌표열. 그 위에서 새 위치까지의 구간만 잘라 쓴다.
      const seg = buildSegment(p.route, p.curLat, p.curLng, v.lat, v.lng);
      p.path = seg.path;
      p.cum = seg.cum;
      p.total = seg.total;
      p.route = v.route || [];        // 다음 프레임을 위해 최신 도로 경로 보관
      p.fromLat = p.curLat; p.fromLng = p.curLng;
      p.tgtLat = v.lat; p.tgtLng = v.lng;
      p.start = performance.now(); p.dur = glideMs; p.done = false;
    }
  }
  const car = el.querySelector(".veh-car");
  const img = carImg(v);                        // 배터리 잔량에 따라 차량 색상 변경
  if (car && !car.src.endsWith(img)) car.src = img;
  // 축소(점 모드)에서도 배터리 색이 보이도록 점 색상 지정
  el.style.setProperty("--dot-color",
    v.battery <= 30 ? "#e5484d" : v.battery <= 50 ? "#f5b301" : "#1b1f33");
  const num = el.querySelector(".veh-num");
  // 번호 배지: RT-007 → "07", SUV-01 → "SUV", RPL-01 → "대체"
  num.textContent = v.id.startsWith("SUV") ? "SUV"
                  : v.id.startsWith("RPL") ? "대체"
                  : v.id.replace("RT-", "");
  num.style.background = "#1b1f33";             // 번호 배지는 중립색(배터리는 차량 색으로 표시)
  el.classList.toggle("alert", !!v.incident);  // 사고/고장 시 빨간 강조
  el.classList.toggle("towing", !!v.towing);   // 견인 중 → 견인차 아이콘
  el.classList.toggle("replacement", !!v.is_replacement);  // 대체 차량 배지
  el.classList.toggle("suv", v.car_type === "SUV");        // 대형(SUV) — 아이콘 크게
  if (openVehicleId === v.id) renderInfo(v);
}

// 매 프레임 마커를 목표 위치로 조금씩 이동(선형 보간)시켜 부드럽게 표시한다.
/* 직전 위치 → 새 위치 구간을, 도로 경로(route) 위의 점들을 경유하도록 만든다.
   route 가 없으면 두 점을 직선으로 잇는다(대기 차량 등 이동이 거의 없는 경우). */
function buildSegment(route, fromLat, fromLng, toLat, toLng) {
  const d2 = (aLat, aLng, bLat, bLng) => {
    const x = (bLng - aLng) * 0.79;             // 위도 37도 부근 경도 보정
    const y = bLat - aLat;
    return x * x + y * y;
  };
  let path = [[fromLat, fromLng]];
  if (route && route.length > 1) {
    // route 는 '새 위치'에서 시작하는 남은 경로. 직전 위치와 새 위치 사이의 도로 점들을 찾는다.
    // 직전 route(=이전 스냅샷 기준)에서 새 위치와 가장 가까운 점까지를 경유점으로 사용.
    let best = 0, bestD = Infinity;
    for (let i = 0; i < route.length; i++) {
      const d = d2(route[i].lat, route[i].lng, toLat, toLng);
      if (d < bestD) { bestD = d; best = i; }
    }
    for (let i = 1; i < best; i++) path.push([route[i].lat, route[i].lng]);
  }
  path.push([toLat, toLng]);

  // 누적 거리
  const cum = [0];
  for (let i = 1; i < path.length; i++) {
    const dx = (path[i][1] - path[i - 1][1]) * 0.79;
    const dy = path[i][0] - path[i - 1][0];
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  return { path, cum, total: cum[cum.length - 1] };
}

/* 경로 위에서 진행률 t(0~1)에 해당하는 좌표와 진행 방향을 구한다. */
function pointOnPath(p, t) {
  const { path, cum, total } = p;
  if (!path || path.length < 2 || !total) {
    return { lat: p.tgtLat, lng: p.tgtLng, bearing: null };
  }
  const target = total * t;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < target) i++;
  const segLen = cum[i] - cum[i - 1] || 1e-9;
  const r = Math.max(0, Math.min(1, (target - cum[i - 1]) / segLen));
  const a = path[i - 1], b = path[i];
  const lat = a[0] + (b[0] - a[0]) * r;
  const lng = a[1] + (b[1] - a[1]) * r;
  const bearing = (Math.atan2((b[1] - a[1]) * 0.79, b[0] - a[0]) * 180) / Math.PI;
  return { lat, lng, bearing };
}

function animateMarkers() {
  const now = performance.now();
  for (const id in posState) {
    const p = posState[id];
    if (p.done || !overlays[id]) continue;
    const t = p.dur > 0 ? Math.min(1, (now - p.start) / p.dur) : 1;
    const q = pointOnPath(p, t);                // 도로 경로를 따라 이동(직선 관통 방지)
    p.curLat = q.lat; p.curLng = q.lng;
    overlays[id].setPosition(new kakao.maps.LatLng(p.curLat, p.curLng));
    // 진행 방향으로 차량 이미지 회전
    if (q.bearing !== null && markerEls[id]) {
      const car = markerEls[id].querySelector(".veh-car");
      if (car) car.style.transform = `translate(-50%, -50%) rotate(${q.bearing + 90}deg)`;
    }
    if (t >= 1) p.done = true;   // 목표 도달 → 정지(불필요한 갱신 방지)
  }
  requestAnimationFrame(animateMarkers);
}

function openInfo(id) {
  closeInfo();
  openVehicleId = id;
  // 정보 말풍선이 다른 차량 마커에 가려지지 않도록 이 마커를 맨 위로 올린다.
  if (overlays[id] && overlays[id].setZIndex) overlays[id].setZIndex(1000);
  const v = latestById[id];
  if (v) renderInfo(v);
  routePinnedId = id;          // 클릭 → 경로 고정 표시
  routeHoverId = null;
  refreshRoute();
}

function closeInfo() {
  if (openVehicleId && markerEls[openVehicleId]) {
    const info = markerEls[openVehicleId].querySelector(".veh-info");
    if (info) info.style.display = "none";
    if (overlays[openVehicleId] && overlays[openVehicleId].setZIndex) {
      overlays[openVehicleId].setZIndex(3);   // 원래 z-index 로 복귀
    }
  }
  openVehicleId = null;
  routePinnedId = null;        // 경로 고정 해제
  refreshRoute();
}

function renderInfo(v) {
  const el = markerEls[v.id];
  if (!el) return;
  const info = el.querySelector(".veh-info");
  const chip = STATE_CHIP_COLOR[v.status];
  const note = v.incident
    ? `<div class="note">⚠ ${v.incident.desc}</div>`
    : (v.note ? `<div class="note" style="color:#8a90a2">${v.note}</div>` : "");
  // 현재 행선지(목적지) — 상태별로 다름: 손님맞이=픽업지, 운행=목적지, 충전=충전소, 견인=정비소
  let destLabel = "행선지";
  if (v.status === "PICKUP") destLabel = "손님 위치";
  else if (v.status === "CHARGING") destLabel = "충전소";
  else if (v.status === "MAINTENANCE") destLabel = v.towing ? "견인 목적지" : "정비소";
  const destRow = v.dest_name
    ? `<div class="row"><span>${destLabel}</span><b>${v.dest_name}</b></div>` : "";
  const routeHint = (v.route && v.route.length >= 2)
    ? `<div class="route-hint">🗺️ 현재 경로를 지도에 표시 중</div>` : "";
  info.innerHTML = `
    <h4>${carEmoji} ${v.plate}
      <span class="state-chip" style="background:${chip}">${v.status_label}</span></h4>
    <div class="row"><span>배터리</span><b>${v.battery}%</b></div>
    <div class="row"><span>차량 번호</span><b>${v.id}</b></div>
    ${destRow}
    <div class="row"><span>운행</span><b>${v.passenger || "—"}</b></div>
    ${routeHint}
    ${note}
    <a class="mon-btn" href="/monitor/${v.id}">차량 모니터링 →</a>`;
  info.style.display = "block";
}

/* --------------------------------------------------------------- 도넛/KPI */
function initDonut() {
  const ctx = document.getElementById("donut").getContext("2d");
  donutChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: STATUS_KEYS.map((k) => STATUS_LABEL[k]),
      datasets: [{
        data: [0, 0, 0, 0],
        backgroundColor: STATUS_KEYS.map((k) => STATUS_COLOR[k]),
        borderWidth: 0,
      }],
    },
    options: {
      cutout: "72%",
      plugins: { legend: { display: false }, tooltip: { enabled: true } },
      animation: { duration: 300 },
    },
  });
}

function updateDonut(kpis) {
  const counts = kpis.status_counts;
  donutChart.data.datasets[0].data = STATUS_KEYS.map((k) => donutCount(counts, k));
  donutChart.update("none");
  // 도넛 중심 = 전체 차량 수(모든 상태 합계). 조각은 운행중/대기중/충전중/점검중으로 분해.
  document.getElementById("donut-num").textContent =
    Object.values(counts).reduce((a, b) => a + (b || 0), 0);

  const legend = document.getElementById("legend");
  legend.innerHTML = STATUS_KEYS.map((k) => `
    <div class="legend-item">
      <span class="sw" style="background:${STATUS_COLOR[k]}"></span>
      <span class="nm">${STATUS_LABEL[k]}</span>
      <span class="ct">${donutCount(counts, k)}대</span>
    </div>`).join("");
}

function deltaHtml(d, isMoney) {
  const up = d.diff >= 0;
  const arrow = up ? "▲" : "▼";
  const val = isMoney ? won(Math.abs(d.diff)) + "원" : Math.abs(d.diff);
  const sign = up ? "+" : "-";
  return `<span class="delta ${up ? "up" : "down"}">${arrow} ${sign}${val}
    (${Math.abs(d.pct)}%)<span class="vs">전일 대비</span></span>`;
}

function updateKpis(kpis) {
  document.getElementById("kpi-trips").textContent = won(kpis.trips_today);
  document.getElementById("kpi-rev").textContent = won(kpis.revenue_today);
  document.getElementById("kpi-reg").textContent = kpis.registered;
  document.getElementById("kpi-act").textContent = kpis.active;
  document.getElementById("kpi-trips-d").outerHTML = deltaHtml(kpis.deltas.trips, false).replace("delta ", "delta ").replace("<span class=\"delta", "<span id=\"kpi-trips-d\" class=\"delta");
  document.getElementById("kpi-rev-d").outerHTML = deltaHtml(kpis.deltas.revenue, true).replace("<span class=\"delta", "<span id=\"kpi-rev-d\" class=\"delta");
  document.getElementById("kpi-reg-d").outerHTML = deltaHtml(kpis.deltas.registered, false).replace("<span class=\"delta", "<span id=\"kpi-reg-d\" class=\"delta");
  document.getElementById("kpi-act-d").outerHTML = deltaHtml(kpis.deltas.active, false).replace("<span class=\"delta", "<span id=\"kpi-act-d\" class=\"delta");
}

/* --------------------------------------------------------------- 알림 */
function updateAlerts(alerts) {
  // 배터리
  const bEl = document.getElementById("battery-alerts");
  if (!alerts.battery.length) {
    bEl.innerHTML = `<div class="empty-hint">임계치 도달 차량 없음</div>`;
  } else {
    bEl.innerHTML = alerts.battery.slice(0, 6).map((a) => {
      const cls = a.state === "DANGER" ? "danger" : "caution";
      return `<div class="alert-row" onclick="location.href='/monitor/${a.vehicle_id}'" style="cursor:pointer">
        <div class="ico ${cls}">🔋</div>
        <div class="meta"><div class="t">${a.plate}</div>
          <div class="s">${a.label} · ${a.vehicle_id}</div></div>
        <div class="val" style="color:${a.state === "DANGER" ? "#e5484d" : "#b07d00"}">${a.battery}%</div>
      </div>`;
    }).join("");
  }
  // 사고/방전
  const iEl = document.getElementById("incident-alerts");
  if (!alerts.incident.length) {
    iEl.innerHTML = `<div class="empty-hint">사고·방전 차량 없음</div>`;
  } else {
    iEl.innerHTML = alerts.incident.slice(0, 6).map((a) => {
      const cls = a.type === "ACCIDENT" ? "accident" : "breakdown";
      const ico = a.type === "ACCIDENT" ? "🚨" : "🪫";
      return `<div class="alert-row" onclick="location.href='/monitor/${a.vehicle_id}'" style="cursor:pointer">
        <div class="ico ${cls}">${ico}</div>
        <div class="meta"><div class="t">${a.plate} · ${a.label}</div>
          <div class="s">${a.desc}</div></div>
        <div class="val" style="color:#e5484d">대응</div>
      </div>`;
    }).join("");
  }
  // 이벤트 피드
  const feed = document.getElementById("event-feed");
  feed.innerHTML = alerts.events.slice(0, 20).map((e) =>
    `<div class="event-line ${e.level}"><span class="dot2"></span>
      <span style="color:#aeb4c2">${e.ts.slice(11)}</span> ${e.text}</div>`
  ).join("");
}

/* --------------------------------------------------------------- 스냅샷 */
function applySnapshot(snap) {
  document.getElementById("last-ts").textContent = snap.ts;
  // 실제 갱신 간격을 재서 보간 시간으로 사용 → 다음 갱신이 올 때 자연스럽게 이어짐
  const now = performance.now();
  if (lastSnapAt) glideMs = Math.min(4000, Math.max(500, now - lastSnapAt));
  lastSnapAt = now;
  latestById = {};
  snap.vehicles.forEach((v) => { latestById[v.id] = v; });
  if (map) snap.vehicles.forEach(updateMarker);
  if (map) renderDepots(snap.depots);
  if (map) renderShops(snap.shops);
  if (map) renderTows(snap.tows);
  if (map) renderAmbulances(snap.ambulances);
  if (map) refreshRoute();      // 표시 중인 경로를 최신 위치로 갱신
  updateKpis(snap.kpis);
  updateDonut(snap.kpis);
  updateAlerts(snap.alerts);
  watchAccidents(snap.alerts && snap.alerts.incident);
  renderDemand(snap.clock);
  renderBriefs(snap.briefs);
  renderHeat(snap.demand_map);
  renderBalance(snap.demand_map, snap.repos);
}

/* ── 수요 히트맵 — 현재 시간대 핫스팟을 지도에 반투명 원으로 표시 ── */
let heatOn = false, heatOverlays = [];
function toggleHeat() {
  heatOn = !heatOn;
  const btn = document.getElementById("heat-btn");
  if (btn) btn.classList.toggle("on", heatOn);
  if (!heatOn) { heatOverlays.forEach((o) => o.setMap(null)); heatOverlays = []; }
}
function renderHeat(dmap) {
  if (!map || !heatOn) return;
  heatOverlays.forEach((o) => o.setMap(null));
  heatOverlays = [];
  (dmap || []).forEach((s) => {
    // 수요 강도(level)에 따라 원 크기·진하기 결정, 부족하면 빨강 계열로 강조
    const short = s.gap <= -1.0;
    const color = short ? "#e5484d" : "#f5a524";
    const c = new kakao.maps.Circle({
      center: new kakao.maps.LatLng(s.lat, s.lng),
      radius: 220 + s.level * 620,
      strokeWeight: 2, strokeColor: color, strokeOpacity: 0.65, strokeStyle: "solid",
      fillColor: color, fillOpacity: 0.10 + s.level * 0.22,
    });
    c.setMap(map);
    heatOverlays.push(c);

    const el = document.createElement("div");
    el.className = "heat-tag" + (short ? " short" : "");
    el.innerHTML = `${s.name}<span>수요 ${s.demand} · 공급 ${s.supply}</span>`;
    const ov = new kakao.maps.CustomOverlay({
      position: new kakao.maps.LatLng(s.lat, s.lng), content: el, yAnchor: 1.6, zIndex: 3,
    });
    ov.setMap(map);
    heatOverlays.push(ov);
  });
}

/* ── 수요·공급 균형 + 재배치 성과 지표 ── */
function renderBalance(dmap, repos) {
  const block = document.getElementById("ai-balance-block");
  const box = document.getElementById("ai-balance");
  if (!block || !box) return;
  if (!dmap || !dmap.length) { block.style.display = "none"; return; }
  block.style.display = "";
  // 불균형 구역을 먼저, 적정 구역은 뒤로 — 접은 상태에서도 중요한 것부터 보이게
  const sorted = dmap.slice().sort((a, b) => {
    const w = (s) => (s.status === "부족" ? 0 : s.status === "과잉" ? 1 : 2);
    return w(a) - w(b) || Math.abs(b.gap) - Math.abs(a.gap);
  });
  const off = sorted.filter((s) => s.status !== "적정").length;
  const cnt = document.getElementById("ai-balance-cnt");
  if (cnt) cnt.textContent = off ? `불균형 ${off}` : "적정";
  const rows = sorted.slice(0, 4).map((s) => {
    const cls = s.status === "부족" ? "short" : s.status === "과잉" ? "over" : "ok";
    const sign = s.gap > 0 ? "+" : "";
    return `<div class="bal-item"><span class="bal-name">${s.name}</span>
      <span class="bal-num">수요 ${s.demand} / 공급 ${s.supply}</span>
      <span class="bal-tag ${cls}">${s.status} ${sign}${s.gap}</span></div>`;
  }).join("");
  let perf = "";
  if (repos && repos.after_min != null) {
    perf = `<div class="bal-perf">재배치 효과 · 평균 접근 <b>${repos.before_min}분</b> →
      <b class="good">${repos.after_min}분</b>
      <span class="bal-saved">▼ ${repos.saved_min}분 단축</span>
      <span class="bal-sub">누적 ${repos.repositioned}대 재배치 · 핫스팟 반경 대기 ${repos.covered}/${repos.idle}대</span></div>`;
  }
  box.innerHTML = rows + perf;
}

/* 재배치 브리핑(자동/관리자) — AI 관제 브리핑 카드에 최근 내역 표시 */
function renderBriefs(briefs) {
  const block = document.getElementById("ai-brief-block");
  const box = document.getElementById("ai-rebal");
  if (!block || !box) return;
  if (!briefs || !briefs.length) { block.style.display = "none"; return; }
  block.style.display = "";
  const cnt = document.getElementById("ai-rebal-cnt");
  if (cnt) cnt.textContent = `${briefs.length}건`;
  box.innerHTML = briefs.slice(0, 4).map((b) => {
    const tag = b.kind === "manual"
      ? '<span class="rb-tag manual">관리자</span>'
      : '<span class="rb-tag auto">자동</span>';
    return `<div class="rb-item"><span class="rb-time">${b.time}</span> ${tag}<span>${b.text}</span></div>`;
  }).join("");
}

let demandBuilt = false;
function renderDemand(clock) {
  if (!clock) return;
  const clk = document.getElementById("sim-clock");
  const badge = document.getElementById("demand-badge");
  const chart = document.getElementById("demand-chart");
  if (!clk || !badge || !chart) return;
  clk.textContent = (clock.day_name ? clock.day_name + " " : "") + clock.sim_time;
  const modeEl = document.getElementById("sim-mode");
  if (modeEl) {
    modeEl.textContent = clock.realtime ? "🕒 실시간"
      : clock.paused ? "⏸ 고정"
      : (clock.scale && clock.scale !== 1 ? "⏩ ×" + clock.scale : "▶ 진행중");
  }
  const tag = clock.party_night ? "회식·유흥 성수기" : clock.demand_tag;
  badge.textContent = "수요 " + clock.demand_label + (tag ? " · " + tag : "");
  // 수요 단계별 색(0~4)
  const lv = clock.demand >= 0.8 ? 4 : clock.demand >= 0.55 ? 3 : clock.demand >= 0.35 ? 2 : clock.demand >= 0.2 ? 1 : 0;
  badge.className = "demand-badge lv" + lv;

  // 운행 비율 게이지 — 현재 운행중 비율(막대) vs 수요 기준 목표(눈금)
  const fill = document.getElementById("ratio-fill");
  if (fill && typeof clock.active_pct === "number") {
    const now = clock.active_pct, goal = clock.target_pct;
    fill.style.width = Math.min(100, now) + "%";
    fill.className = "ratio-fill lv" + lv;
    document.getElementById("ratio-now").textContent = now + "%";
    document.getElementById("ratio-goal").textContent = goal + "%";
    const tgt = document.getElementById("ratio-target");
    if (tgt) tgt.style.left = Math.min(100, goal) + "%";
  }
  // 막대(24시간)는 처음 한 번만 생성, 이후엔 현재 시각만 강조 이동
  if (!demandBuilt && Array.isArray(clock.curve)) {
    chart.innerHTML = clock.curve.map((v, h) =>
      `<div class="dbar" data-h="${h}" style="height:${Math.max(6, Math.round(v * 100))}%" title="${h}시 수요 ${Math.round(v * 100)}%"></div>`
    ).join("");
    demandBuilt = true;
  }
  chart.querySelectorAll(".dbar").forEach((b) =>
    b.classList.toggle("now", Number(b.dataset.h) === clock.hour));
}

/* --------------------------------------------------------------- WebSocket */
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    try { applySnapshot(JSON.parse(ev.data)); } catch (e) { console.error(e); }
  };
  ws.onclose = () => {
    document.getElementById("last-ts").textContent = "재연결 중…";
    setTimeout(connectWS, 2000);
  };
  // keep-alive
  setInterval(() => { if (ws.readyState === 1) ws.send("ping"); }, 25000);
}

/* --------------------------------------------------------------- 시뮬레이션 */
function showToast(html) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.style.cssText = "position:fixed;right:22px;bottom:22px;max-width:360px;background:#0a0e27;color:#fff;padding:14px 16px;border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.35);font-size:13px;z-index:200;line-height:1.5";
    document.body.appendChild(t);
  }
  t.innerHTML = html;
  t.style.display = "block";
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.display = "none"; }, 9000);
}

/* 집중배치 결과 패널 — 어떤 택시가 배치됐는지 목록으로 표시 */
function showSurgePanel(res) {
  const panel = document.getElementById("surge-panel");
  if (!panel) return;
  document.getElementById("sp-title").textContent = `📍 ${res.point} 집중배치 · ${res.count}대`;
  document.getElementById("sp-reason").textContent = res.reason || "";
  const list = document.getElementById("sp-list");
  const vs = res.vehicles || [];
  list.innerHTML = vs.length
    ? vs.map((v, i) => `<div class="sp-row" data-vid="${v.id}">
        <span class="sp-no">${i + 1}</span>
        <span class="sp-plate">${v.plate}${v.car_type === "SUV" ? ' <b class="sp-suv">SUV</b>' : ""}</span>
        <span class="sp-meta">${v.distance_km}km · 약 ${v.eta_min}분</span>
        <span class="sp-batt">🔋${v.battery}%</span>
      </div>`).join("")
    : `<div class="sp-empty">배치된 차량이 없습니다.</div>`;
  // 목록에서 차량을 클릭하면 지도에서 해당 차량으로 이동
  list.querySelectorAll(".sp-row").forEach((row) =>
    row.addEventListener("click", () => {
      const v = latestById[row.dataset.vid];
      if (v && map) { map.setCenter(new kakao.maps.LatLng(v.lat, v.lng)); openInfo(row.dataset.vid); }
    }));
  panel.hidden = false;
}

/* 배치된 택시 마커를 잠시 강조 표시 */
let surgeHighlightIds = [];
function highlightSurged(vehicles) {
  surgeHighlightIds.forEach((id) => markerEls[id] && markerEls[id].classList.remove("surged"));
  surgeHighlightIds = (vehicles || []).map((v) => v.id);
  surgeHighlightIds.forEach((id) => markerEls[id] && markerEls[id].classList.add("surged"));
  setTimeout(() => {
    surgeHighlightIds.forEach((id) => markerEls[id] && markerEls[id].classList.remove("surged"));
    surgeHighlightIds = [];
  }, 20000);   // 20초 후 강조 해제
}

/* 대기 택시를 특정 지점(정왕역/한국공대)으로 집중 배치 — 배치 대수는 현재 수요·시간대 근거로 자동 산정 */async function surgeTo(point) {
  const id = point === "정왕역" ? "surge-jw" : "surge-od";
  const btn = document.getElementById(id);
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "배치 중…";
  try {
    const r = await fetch("/api/console/surge", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ point }),
    });
    const res = await r.json();
    if (res.ok && res.count > 0) {
      showToast(`<b>📍 ${res.point} 집중배치</b><br><b>${res.count}대</b> 사전배치 이동 시작<br><span style="opacity:.85">${res.reason}</span>`);
      showSurgePanel(res);
      highlightSurged(res.vehicles);
    } else if (res.ok) {
      showToast(`<b>📍 ${res.point} 집중배치</b><br><span style="opacity:.85">${res.reason || "이동 가능한 대기 차량이 없습니다."}</span>`);
      showSurgePanel(res);
    } else {
      showToast(`<b>집중배치 실패</b><br>${res.msg || "처리할 수 없습니다."}`);
    }
  } catch (e) {
    showToast("집중배치 중 오류가 발생했습니다.");
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

/* --------------------------------------------------------------- 도로 혼잡도 */
// 카카오맵 실시간 교통정보(TRAFFIC) 오버레이를 켜고 끈다 — 네비게이션처럼
// 도로별 혼잡도(원활/서행/정체)가 색으로 표시된다.
let trafficOn = false;
let trafficPrevLevel = null;
function toggleTraffic() {
  const btn = document.getElementById("traffic-btn");
  const legend = document.getElementById("traffic-legend");
  if (!map || !window.kakao || !kakao.maps) {
    showToast("지도가 아직 준비되지 않았습니다. 잠시 후 다시 시도하세요.");
    return;
  }
  trafficOn = !trafficOn;
  if (trafficOn) {
    map.addOverlayMapTypeId(kakao.maps.MapTypeId.TRAFFIC);
    btn.classList.add("on");
    if (legend) legend.style.display = "flex";
    // 교통정보는 어느 정도 확대해야 색이 보이므로, 켤 때 자동으로 확대해 준다.
    trafficPrevLevel = map.getLevel();
    if (map.getLevel() > 5) map.setLevel(5, { animate: true });
    showToast(
      "🚦 <b>도로 혼잡도 표시 ON</b><br>" +
      "도로 위 색이 실시간 교통 상황이에요. (초록=원활 / 주황=서행 / 빨강=정체)<br>" +
      "<span style='opacity:.8'>지도를 더 확대하면 골목 도로까지 보입니다.</span>"
    );
  } else {
    map.removeOverlayMapTypeId(kakao.maps.MapTypeId.TRAFFIC);
    btn.classList.remove("on");
    if (legend) legend.style.display = "none";
    if (trafficPrevLevel != null) {
      map.setLevel(trafficPrevLevel, { animate: true });
      trafficPrevLevel = null;
    }
  }
}

/* ----------------------------------------------------- 상담사 연결(고객 ↔ 관제사) */
let supRoom = null;          // 현재 열려 있는 상담 세션 id
let supSeen = 0;             // 이미 그린 메시지 수

async function supGet(url) { const r = await fetch(url); return r.json(); }
async function supPost(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body) });
  return r.json();
}

async function refreshSupport() {
  try {
    const d = await supGet("/api/support/rooms");
    const rooms = d.rooms || [];
    const waiting = rooms.filter((r) => r.status === "waiting").length;
    const badge = document.getElementById("sup-count");
    badge.textContent = rooms.length;
    badge.classList.toggle("on", waiting > 0);
    document.getElementById("sup-card").classList.toggle("alerting", waiting > 0);

    if (!supRoom) {
      const box = document.getElementById("sup-list");
      if (!rooms.length) {
        box.innerHTML = '<div class="sup-empty">대기 중인 상담이 없습니다.</div>';
      } else {
        box.innerHTML = rooms.map((r) => `
          <button class="sup-item ${r.status}" data-sid="${r.session}">
            <span class="sup-dot"></span>
            <span class="sup-main">
              <b>${r.vehicle ? r.vehicle + " 탑승 고객" : "고객"}</b>
              <span class="sup-last">${r.last || "상담 요청"}</span>
            </span>
            ${r.unread ? `<span class="sup-un">${r.unread}</span>` : ""}
            <span class="sup-wait">${r.status === "waiting" ? r.waited_sec + "초 대기" : "상담중"}</span>
          </button>`).join("");
        box.querySelectorAll(".sup-item").forEach((b) =>
          b.addEventListener("click", () => openSupRoom(b.dataset.sid)));
      }
    } else {
      await pollSupRoom();
    }
  } catch (e) { /* 로그인 전 등 — 무시 */ }
}

async function openSupRoom(sid) {
  supRoom = sid; supSeen = 0;
  document.getElementById("sup-list").hidden = true;
  document.getElementById("sup-room").hidden = false;
  document.getElementById("sup-log").innerHTML = "";
  await supPost("/api/support/accept", { session: sid });
  await pollSupRoom(true);
}

async function pollSupRoom(force) {
  if (!supRoom) return;
  const d = await supGet("/api/support/history?session=" + encodeURIComponent(supRoom));
  if (!d.ok) return;
  document.getElementById("sup-who").textContent = (d.vehicle ? d.vehicle + " 탑승 고객" : "고객");
  document.getElementById("sup-meta").textContent =
    (d.dest ? "→ " + d.dest + " · " : "") + (d.status === "active" ? "상담 중" : "대기");
  const log = document.getElementById("sup-log");
  const msgs = d.messages || [];
  if (force) { log.innerHTML = ""; supSeen = 0; }
  msgs.slice(supSeen).forEach((m) => {
    const el = document.createElement("div");
    el.className = "sup-msg " + (m.who === "admin" ? "me" : m.who === "user" ? "you" : "sys");
    el.innerHTML = `<span>${m.text}</span><i>${m.time}</i>`;
    log.appendChild(el);
  });
  supSeen = msgs.length;
  log.scrollTop = log.scrollHeight;
}

async function sendSupport() {
  const el = document.getElementById("sup-text");
  const text = el.value.trim();
  if (!text || !supRoom) return;
  el.value = "";
  await supPost("/api/support/reply", { session: supRoom, text });
  await pollSupRoom();
}

function closeSupRoom() {
  supRoom = null;
  document.getElementById("sup-room").hidden = true;
  document.getElementById("sup-list").hidden = false;
  refreshSupport();
}

/* ----------------------------------------------------- AI 관제 브리핑(자율 관제) */
async function refreshOps() {
  try {
    const r = await fetch("/api/ops");
    if (!r.ok) return;
    const s = await r.json();
    document.getElementById("ai-summary").textContent = s.summary || "-";
    const eng = document.getElementById("ai-engine");
    eng.textContent = s.engine === "ai" ? "AI" : "규칙";
    eng.className = "ai-badge" + (s.engine === "ai" ? " on" : "");
    document.getElementById("ai-ts").textContent = s.ts || "";
    const recs = s.recommendations || [];
    const recsBlock = document.getElementById("ai-recs-block");
    if (recs.length) {
      document.getElementById("ai-recs").innerHTML =
        recs.map((r) => `<div class="ai-item">• ${r}</div>`).join("");
      recsBlock.style.display = "block";
    } else recsBlock.style.display = "none";
    const anoms = s.anomalies || [];
    const anomBlock = document.getElementById("ai-anom-block");
    if (anoms.length) {
      document.getElementById("ai-anomalies").innerHTML =
        anoms.map((a) => `<div class="ai-anom ${a.level}"><b>${a.title}</b> · ${a.detail}</div>`).join("");
      anomBlock.style.display = "block";
    } else anomBlock.style.display = "none";
  } catch (e) { /* 무시 */ }
}

/* ----------------------------------------------------- 정보창 접기/펴기 */
const FOLD_KEY = "robita_fold";
// 길어서 기본으로 접어두는 항목
const FOLD_DEFAULT = { balance: true, rebal: true, log: true };

function foldState() {
  try { return JSON.parse(localStorage.getItem(FOLD_KEY) || "{}"); } catch (e) { return {}; }
}
function foldSave(st) {
  try { localStorage.setItem(FOLD_KEY, JSON.stringify(st)); } catch (e) { /* 무시 */ }
}

function initFolds() {
  const st = foldState();
  document.querySelectorAll("[data-fold]").forEach((el) => {
    const key = el.dataset.fold;
    el.classList.toggle("folded", key in st ? !!st[key] : !!FOLD_DEFAULT[key]);
    const handle = el.querySelector(":scope > .card-title > .fold-btn")
                || el.querySelector(":scope > .fold-head");
    if (!handle) return;
    handle.addEventListener("click", (e) => {
      e.stopPropagation();
      const folded = !el.classList.contains("folded");
      el.classList.toggle("folded", folded);
      const s = foldState();
      s[key] = folded;
      foldSave(s);
    });
  });
}

/* ----------------------------------------------------- 사고 발생 팝업 */
let accSeen = null;      // null = 첫 스냅샷 전(기존 사고는 팝업 띄우지 않음)
let accQueue = [];       // 아직 안 보여준 사고
let accCurrent = null;

function watchAccidents(incidents) {
  const live = (incidents || []).filter((a) => a.type === "ACCIDENT");
  const liveIds = new Set(live.map((a) => a.vehicle_id));
  if (accSeen === null) { accSeen = liveIds; return; }   // 첫 로드는 기억만
  live.forEach((a) => {
    if (!accSeen.has(a.vehicle_id)) accQueue.push(a);
  });
  accSeen = liveIds;     // 복구된 차량은 잊어서, 다시 사고 나면 또 알린다
  if (!accCurrent) showAccident();
  else accMoreBadge();   // 보는 중에 또 났으면 '외 N건'만 갱신
}

function accMoreBadge() {
  const more = document.getElementById("acc-more");
  if (!more) return;
  more.hidden = accQueue.length === 0;
  more.textContent = accQueue.length ? `대기 중인 사고 ${accQueue.length}건` : "";
}

function showAccident() {
  const pop = document.getElementById("acc-pop");
  const a = accQueue.shift();
  if (!a) { accCurrent = null; if (pop) pop.hidden = true; return; }
  accCurrent = a;
  if (!pop) return;
  document.getElementById("acc-line1").textContent =
    `${a.plate} 차량에 사고가 발생했습니다.`;
  accMoreBadge();
  pop.hidden = false;
}

function dismissAccident() {
  accCurrent = null;
  showAccident();     // 밀린 사고가 있으면 이어서 표시
}

function gotoAccident() {
  const a = accCurrent;
  dismissAccident();
  if (!a || !map) return;
  const v = latestById[a.vehicle_id];
  if (!v) return;
  map.setCenter(new kakao.maps.LatLng(v.lat, v.lng));
  if (map.getLevel() > 3) map.setLevel(3, { animate: true });
  openInfo(a.vehicle_id);
}

/* --------------------------------------------------------------- 시작 */
// 외부 CDN(차트·지도) 하나가 막혀도 나머지 화면은 살아 있도록 단계별로 감싼다
function step(name, fn) {
  try { fn(); } catch (e) { console.warn(`[dashboard] ${name} 초기화 실패:`, e); }
}

window.addEventListener("DOMContentLoaded", () => {
  step("도넛", initDonut);
  step("지도", initMap);
  step("접기", initFolds);
  step("사고 팝업", () => {
    document.getElementById("acc-close").addEventListener("click", dismissAccident);
    document.getElementById("acc-go").addEventListener("click", gotoAccident);
    // 바깥 어두운 곳 클릭 / ESC 로도 닫기
    document.getElementById("acc-pop").addEventListener("click", (e) => {
      if (e.target.id === "acc-pop") dismissAccident();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && accCurrent) dismissAccident();
    });
  });
  step("실시간 연결", () => {
    connectWS();
    requestAnimationFrame(animateMarkers);   // 마커 부드러운 이동 루프 시작
  });
  step("지도 버튼", () => {
    document.getElementById("traffic-btn").addEventListener("click", toggleTraffic);
    document.getElementById("heat-btn").addEventListener("click", toggleHeat);
    document.getElementById("sp-close").addEventListener("click", () => {
      document.getElementById("surge-panel").hidden = true;
    });
    document.getElementById("surge-jw").addEventListener("click", () => surgeTo("정왕역"));
    document.getElementById("surge-od").addEventListener("click", () => surgeTo("한국공학대학교"));
  });
  step("관제 브리핑", () => {
    refreshOps();
    setInterval(refreshOps, 8000);           // AI 관제 브리핑 주기 갱신
  });
  step("상담사 연결", () => {
    document.getElementById("sup-send").addEventListener("click", sendSupport);
    document.getElementById("sup-text").addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendSupport();
    });
    document.getElementById("sup-back").addEventListener("click", closeSupRoom);
    document.getElementById("sup-end").addEventListener("click", async () => {
      if (supRoom) { await supPost("/api/support/end", { session: supRoom }); closeSupRoom(); }
    });
    refreshSupport();
    setInterval(refreshSupport, 2000);       // 상담 요청·메시지 갱신
  });
});
