/* =========================================================================
   택시 호출 페이지
   - /api/places 로 지역 내 주요 지점을 받아 출발지/목적지 드롭다운 구성
   - 드롭다운 또는 지도 클릭으로 출발지·목적지를 지정
   - '호출하기' → POST /api/simulate/call (배정 모델 + 경로 모델 실행)
     → 추천 경로 폴리라인 + 출발/도착/배정 차량 마커 표시 + 결과 카드 렌더
   ========================================================================= */

let callMap = null;
let places = [];
const byName = {};            // name -> {name,lat,lng}

let origin = null;            // {name,lat,lng}
let destination = null;       // {name,lat,lng}
let pickMode = "origin";      // 지도 클릭이 지정할 대상

let oOverlay = null, dOverlay = null, vehOverlay = null, routeSegs = [];
const won = (n) => Number(n).toLocaleString("ko-KR");

// 구간별 혼잡도 색(네비게이션 스타일): 원활(녹색)/서행(주황)/정체(빨강)
const CONGEST_COLOR = { "원활": "#2db400", "서행": "#f5a623", "정체": "#e5484d" };
function segCongestion(traffic, i, seed) {
  const x = Math.abs(Math.sin((i + 1) * 12.9898 + seed * 4.1337)) % 1;
  // 전체 혼잡도에 따라 정체 비중을 다르게: [원활임계, 서행임계]
  const w = traffic === "혼잡" ? [0.18, 0.32] : traffic === "원활" ? [0.72, 0.20] : [0.46, 0.34];
  if (x < w[0]) return "원활";
  if (x < w[0] + w[1]) return "서행";
  return "정체";
}

/* --------------------------------------------------------- 도로 혼잡도 */
// 카카오맵 실시간 교통정보(TRAFFIC) 오버레이 토글 — 도로별 혼잡도가 색으로 표시
let trafficOn = false;
let trafficPrevLevel = null;
function toggleTraffic() {
  const btn = document.getElementById("traffic-btn");
  if (!callMap || !window.kakao || !kakao.maps) return;
  trafficOn = !trafficOn;
  if (trafficOn) {
    callMap.addOverlayMapTypeId(kakao.maps.MapTypeId.TRAFFIC);
    btn.classList.add("on");
    trafficPrevLevel = callMap.getLevel();
    if (callMap.getLevel() > 5) callMap.setLevel(5, { animate: true });
  } else {
    callMap.removeOverlayMapTypeId(kakao.maps.MapTypeId.TRAFFIC);
    btn.classList.remove("on");
    if (trafficPrevLevel != null) { callMap.setLevel(trafficPrevLevel, { animate: true }); trafficPrevLevel = null; }
  }
}

/* ---------------------------------------------------------------- 지도 */
function initMap() {
  if (!window.kakao || !kakao.maps) {
    document.getElementById("call-map").innerHTML =
      `<div class="empty-hint" style="padding:16px">카카오맵 SDK 로드 실패 — 도메인 등록/네트워크를 확인하세요.</div>`;
    return;
  }
  kakao.maps.load(() => {
    const c = window.APP.center;
    callMap = new kakao.maps.Map(document.getElementById("call-map"), {
      center: new kakao.maps.LatLng(c.lat, c.lng),
      level: 5,
    });
    kakao.maps.event.addListener(callMap, "click", (e) => {
      const ll = e.latLng;
      const pt = { name: "지도 지정 지점", lat: ll.getLat(), lng: ll.getLng() };
      if (pickMode === "origin") {
        setOrigin(pt, true);
        setPickMode("dest");           // 출발지 찍으면 다음은 목적지
      } else {
        setDestination(pt, true);
      }
    });
  });
}

function pin(text, color) {
  const el = document.createElement("div");
  el.className = "veh-marker";
  el.innerHTML = `<div class="veh-pill" style="background:${color}">${text}</div>`;
  return el;
}

function setOriginMarker() {
  if (!callMap || !origin) return;
  const pos = new kakao.maps.LatLng(origin.lat, origin.lng);
  if (!oOverlay) {
    oOverlay = new kakao.maps.CustomOverlay({ position: pos, content: pin("출발", "#0a0e27"), yAnchor: 1.2, zIndex: 6 });
    oOverlay.setMap(callMap);
  } else { oOverlay.setContent(pin("출발", "#0a0e27")); oOverlay.setPosition(pos); }
  fitView();
}
function setDestMarker() {
  if (!callMap || !destination) return;
  const pos = new kakao.maps.LatLng(destination.lat, destination.lng);
  if (!dOverlay) {
    dOverlay = new kakao.maps.CustomOverlay({ position: pos, content: pin("도착", "#e5484d"), yAnchor: 1.2, zIndex: 6 });
    dOverlay.setMap(callMap);
  } else { dOverlay.setContent(pin("도착", "#e5484d")); dOverlay.setPosition(pos); }
  fitView();
}

function fitView() {
  if (!callMap) return;
  const pts = [];
  if (origin) pts.push(new kakao.maps.LatLng(origin.lat, origin.lng));
  if (destination) pts.push(new kakao.maps.LatLng(destination.lat, destination.lng));
  if (pts.length === 1) { callMap.setCenter(pts[0]); }
  else if (pts.length === 2) {
    const b = new kakao.maps.LatLngBounds();
    pts.forEach((p) => b.extend(p));
    callMap.setBounds(b);
  }
}

/* ---------------------------------------------------- 출발지/목적지 상태 */
function setOrigin(pt, fromMap) {
  origin = pt;
  document.getElementById("origin-label").textContent = pt ? pt.name : "미지정";
  if (fromMap) document.getElementById("origin-sel").value = "";  // 지도 지정 시 드롭다운 해제
  setOriginMarker();
  refreshCallBtn();
}
function setDestination(pt, fromMap) {
  destination = pt;
  document.getElementById("dest-label").textContent = pt ? pt.name : "미지정";
  if (fromMap) document.getElementById("dest-sel").value = "";
  setDestMarker();
  refreshCallBtn();
}

function setPickMode(mode) {
  pickMode = mode;
  document.getElementById("pm-origin").classList.toggle("active", mode === "origin");
  document.getElementById("pm-dest").classList.toggle("active", mode === "dest");
}

function refreshCallBtn() {
  const btn = document.getElementById("call-btn");
  const ready = !!(origin && destination);
  btn.disabled = !ready;
  const note = document.getElementById("form-note");
  if (!ready) note.textContent = "출발지와 목적지를 모두 선택하면 호출할 수 있습니다.";
  else note.textContent = `${origin.name} → ${destination.name} 경로로 배차를 요청합니다.`;
}

/* ------------------------------------------------------------- 드롭다운 */
async function loadPlaces() {
  const res = await fetch("/api/places");
  const data = await res.json();
  places = data.places || [];
  const oSel = document.getElementById("origin-sel");
  const dSel = document.getElementById("dest-sel");
  places.forEach((p) => {
    byName[p.name] = p;
    oSel.insertAdjacentHTML("beforeend", `<option value="${p.name}">${p.name}</option>`);
    dSel.insertAdjacentHTML("beforeend", `<option value="${p.name}">${p.name}</option>`);
  });
  // 기본값: 출발지=한국공학대학교, 목적지=정왕역 (있으면)
  if (byName["한국공학대학교"]) { oSel.value = "한국공학대학교"; setOrigin(byName["한국공학대학교"], false); }
  if (byName["정왕역"]) { dSel.value = "정왕역"; setDestination(byName["정왕역"], false); }

  oSel.addEventListener("change", () => {
    const p = byName[oSel.value];
    if (p) setOrigin(p, false);
  });
  dSel.addEventListener("change", () => {
    const p = byName[dSel.value];
    if (p) setDestination(p, false);
  });
}

/* ------------------------------------------------------------- 경로/결과 */
function clearRouteLayer() {
  routeSegs.forEach((s) => s.setMap(null));
  routeSegs = [];
  if (vehOverlay) { vehOverlay.setMap(null); vehOverlay = null; }
}

function drawRoute(routeRes) {
  if (!callMap) return;
  routeSegs.forEach((s) => s.setMap(null));
  routeSegs = [];
  const all = [];
  const segments = routeRes.segments && routeRes.segments.length ? routeRes.segments : null;
  if (segments) {
    // 서버가 구간별 혼잡도를 묶음(chunk)으로 보내줌 → 실제 도로 경로도 깔끔하게 색칠
    segments.forEach((seg) => {
      const path = (seg.path || []).map((p) => new kakao.maps.LatLng(p.lat, p.lng));
      path.forEach((p) => all.push(p));
      if (path.length < 2) return;
      const line = new kakao.maps.Polyline({
        path,
        strokeWeight: 6,
        strokeColor: CONGEST_COLOR[seg.level] || "#2f6fed",
        strokeOpacity: 0.92,
        strokeStyle: "solid",
      });
      line.setMap(callMap);
      routeSegs.push(line);
    });
  } else {
    const pts = (routeRes.primary || []).map((p) => new kakao.maps.LatLng(p.lat, p.lng));
    pts.forEach((p) => all.push(p));
    const line = new kakao.maps.Polyline({
      path: pts, strokeWeight: 6, strokeColor: "#2f6fed", strokeOpacity: 0.9,
    });
    line.setMap(callMap);
    routeSegs.push(line);
  }
  if (all.length) {
    const b = new kakao.maps.LatLngBounds();
    all.forEach((p) => b.extend(p));
    callMap.setBounds(b);
  }
}

async function showAssignedVehicle(vehicleId) {
  // 배정 차량의 현재 위치를 받아 지도에 표시
  try {
    const res = await fetch(`/api/vehicle/${encodeURIComponent(vehicleId)}`);
    if (!res.ok) return;
    const v = (await res.json()).vehicle;
    const pos = new kakao.maps.LatLng(v.lat, v.lng);
    const el = document.createElement("div");
    el.className = "veh-marker";
    el.innerHTML = `<div class="veh-pill" style="background:${v.marker_color}"><span class="car">🚖</span><span class="lbl">${v.id.replace("RT-", "")}</span></div>`;
    if (vehOverlay) vehOverlay.setMap(null);
    vehOverlay = new kakao.maps.CustomOverlay({ position: pos, content: el, yAnchor: 0.5, zIndex: 7 });
    vehOverlay.setMap(callMap);
  } catch (e) { /* noop */ }
}

function engineBadge(engine) {
  if (engine === "openai") return `<span class="eng gemini">🤖 ChatGPT</span>`;
  if (engine === "gemini") return `<span class="eng gemini">🤖 Gemini</span>`;
  if (engine === "score") return `<span class="eng rule">📊 점수식</span>`;
  return `<span class="eng rule">⚙ 규칙기반</span>`;
}

function renderResult(res) {
  const card = document.getElementById("result");
  const body = document.getElementById("result-body");
  const a = res.assignment;
  if (!a.assigned) {
    card.style.display = "block";
    body.innerHTML = `<div class="result-fail">⚠ ${a.reason || "배차 가능한 차량이 없습니다."}</div>`;
    return;
  }
  const v = a.assigned;
  const r = res.route;
  card.style.display = "block";
  body.innerHTML = `
    <div class="res-head">
      <div class="res-plate">🚖 ${v.plate}<span class="res-id">${v.id}</span></div>
      <div class="res-eng">${engineBadge(a.engine)} 배정 · ${engineBadge(r.engine)} 경로</div>
    </div>
    <div class="res-route">${res.origin.name} <span class="arr">→</span> ${res.destination.name}
      ${r.road ? '<span class="road-tag">🛣 실제 도로 경로</span>' : '<span class="road-tag off">직선 경로(길찾기 미설정)</span>'}
    </div>
    <div class="res-grid">
      <div class="rg"><span>예상 도착(ETA)</span><b>${a.eta_min}분</b></div>
      <div class="rg"><span>이동 거리</span><b>${r.distance_km} km</b></div>
      <div class="rg"><span>예상 요금</span><b>${won(a.est_fare)}원</b></div>
      <div class="rg"><span>차량 배터리</span><b>${v.battery}%</b></div>
    </div>
    <div class="res-reason"><b>배차 사유</b><br>${a.reason}</div>
    <div class="res-reason"><b>경로 사유</b><br>${r.reason}</div>
    ${a.alternatives && a.alternatives.length ? `<div class="res-alt">대체 후보: ${a.alternatives.map((c) => c.plate + " (ETA " + c.eta_min + "분)").join(" · ")}</div>` : ""}
    <div class="res-actions">
      <a class="btn-mon" href="/monitor/${v.id}">차량 모니터링 →</a>
      <a class="btn-ghost2" href="/dashboard">지도에서 보기 →</a>
    </div>
    <div class="res-foot">배차된 차량은 목적지를 향해 출발하며, <a href="/trips">금일 이용내역</a>에 기록됩니다.</div>`;
}

async function callTaxi() {
  if (!origin || !destination) return;
  const btn = document.getElementById("call-btn");
  btn.disabled = true;
  btn.textContent = "배차 계산 중…";
  try {
    const payload = {
      origin, destination,
      traffic: document.getElementById("traffic-sel").value,
      demand: "보통",
    };
    const r = await fetch("/api/simulate/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const res = await r.json();
    drawRoute(res.route);
    renderResult(res);
    if (res.assignment.assigned) showAssignedVehicle(res.assignment.assigned.id);
  } catch (e) {
    document.getElementById("result").style.display = "block";
    document.getElementById("result-body").innerHTML =
      `<div class="result-fail">호출 처리 중 오류가 발생했습니다.</div>`;
  } finally {
    btn.textContent = "호출하기";
    btn.disabled = !(origin && destination);
  }
}

/* ---------------------------------------------------------------- 시작 */
window.addEventListener("DOMContentLoaded", async () => {
  initMap();
  await loadPlaces();
  document.querySelectorAll(".pm").forEach((b) =>
    b.addEventListener("click", () => setPickMode(b.dataset.mode)));
  document.getElementById("swap-btn").addEventListener("click", () => {
    const o = origin, d = destination;
    const oSelV = document.getElementById("origin-sel").value;
    const dSelV = document.getElementById("dest-sel").value;
    setOrigin(d, false); setDestination(o, false);
    document.getElementById("origin-sel").value = dSelV;
    document.getElementById("dest-sel").value = oSelV;
  });
  document.getElementById("call-btn").addEventListener("click", callTaxi);
  document.getElementById("traffic-btn").addEventListener("click", toggleTraffic);
});
