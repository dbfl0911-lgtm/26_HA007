/* =========================================================================
   차량 모니터링 페이지 클라이언트 로직
   - /api/vehicle/{id} 를 주기적으로 조회해 차량 상세를 갱신
   - 좌측 차량 카드(번호판/상태/평점) 렌더
   - 7개 에이전트 진행 로그를 가로 스텝퍼로 시각화
   - 배터리 / 컨디션 점수 도넛 게이지(Chart.js) 2개
   - 카카오맵 미니맵에 현재 위치 마커 표시
   - 운행 기록 테이블 채우기
   ========================================================================= */

const VID = window.APP.vehicleId;
const REFRESH_MS = 4000;

let monMap = null;        // 카카오맵 인스턴스
let monOverlay = null;    // 차량 위치 마커(CustomOverlay)
let batteryGauge = null;  // 배터리 게이지 차트
let condGauge = null;     // 컨디션 게이지 차트
const won = (n) => Number(n).toLocaleString("ko-KR");

/* ------------------------------------------------------------- 색상 헬퍼 */
// 게이지는 시안의 규칙대로 '심각도' 기준으로 색을 칠한다.
//   배터리: 30%↓ 위험(빨강) · 50%↓ 주의(노랑) · 그 외 양호(초록) · 충전중(초록)
function batteryColor(v) {
  if (v.battery_state === "CHARGING") return "#36b37e";
  if (v.battery <= 30) return "#e5484d";
  if (v.battery <= 50) return "#f5b301";
  return "#36b37e";
}
//   컨디션(청결도) 점수: 60↓ 빨강 · 80↓ 노랑 · 그 외 초록
function conditionColor(score) {
  if (score < 60) return "#e5484d";
  if (score < 80) return "#f5b301";
  return "#36b37e";
}
const TRACK = "#eceef3"; // 게이지 잔여(배경) 트랙 색

/* 차량 사진 — 5인 이상 전용 대형차는 셔틀형, 나머지는 차량번호 순서대로 6종을 돌려 쓴다 */
const CAR_PHOTOS = ["sedan", "coupe", "wagon", "crossover", "suv", "minivan"];
const LARGE_PHOTO = "shuttle";

function carPhoto(v) {
  if (v && v.car_type === "SUV") return LARGE_PHOTO;
  const num = parseInt(((v && v.id) || "").replace(/\D/g, ""), 10) || 1;
  return CAR_PHOTOS[(num - 1) % CAR_PHOTOS.length];
}

/* ------------------------------------------------------------- 차량 카드 */
function renderVehicleCard(v) {
  document.getElementById("m-plate").textContent = v.plate;

  const photo = carPhoto(v);
  const av = document.getElementById("m-avatar");
  if (av && av.dataset.car !== photo) {
    av.dataset.car = photo;
    av.innerHTML = `<img src="/static/img/avatars/${photo}.jpg" alt="${v.plate} 차량 사진">`;
  }

  // 상태 문구: 손님맞이/목적지이동/대기/충전/수리 + 사고·고장·견인 강조
  let stat = v.status_label;
  if (v.incident) {
    stat = (v.incident.type === "ACCIDENT" ? "사고 — " : "고장 — ") + v.incident.desc;
    if (v.towing) stat = "견인 중 → 정비소 · " + stat;
  } else if (v.status === "PICKUP" && v.passenger) {
    stat = "손님 맞이중 · " + v.passenger;
  } else if (v.status === "DRIVING" && v.passenger) {
    stat = "목적지 이동중 · " + v.passenger;
  }
  const statEl = document.getElementById("m-stat");
  statEl.textContent = stat;
  statEl.style.color = v.incident ? "#e5484d" : "var(--muted)";

  // 평점 + 별
  const r = v.rating;
  document.getElementById("m-rating").textContent = r.toFixed(1);
  const full = Math.round(r);
  document.getElementById("m-stars").textContent = "★".repeat(full) + "☆".repeat(5 - full);
}

/* --------------------------------------------------------- 에이전트 로그 */
function renderAgents(agentLog) {
  const track = document.getElementById("agent-track");
  if (!agentLog || !agentLog.length) {
    track.innerHTML = `<div class="empty-hint">표시할 에이전트 로그가 없습니다.</div>`;
    return;
  }
  track.innerHTML = agentLog.map((a) => {
    const steps = a.steps.map((s) => `
      <div class="agent-step">
        <div class="lb">${s.label}</div>
        <div class="tx">${s.text}</div>
      </div>`).join("");
    return `
      <div class="agent-col ${a.state}">
        <div class="agent-name"><span class="pin"></span>${a.name}</div>
        ${steps}
      </div>`;
  }).join("");
}

/* ----------------------------------------------- 에이전트 활동 이력(누적) */
// 서버가 차량별 활동을 계속 누적(agent_history)하므로, 클라이언트는 '새로 생긴
// 항목만' 앞에 덧붙인다. 기존 항목과 스크롤 위치를 지우지 않아 새로고침되지 않는다.
let lastAgentSeq = 0;
let agentHistInit = false;   // 첫 렌더 완료 여부(중복 렌더 방지)

const AGENT_STATE_LABEL = { done: "완료", active: "진행", alert: "경고", idle: "대기" };

// 각 에이전트가 하는 일(상세 보기에서 설명으로 표시)
const AGENT_DESC = {
  "재배치 에이전트": "수요를 예측해 빈 차량을 수요가 많은 지역으로 미리 재배치합니다.",
  "배차 에이전트": "호출에 가장 적합한 차량을 선택해 배정합니다(거리·배터리·평점을 함께 고려).",
  "인시던트 대응 에이전트": "사고·방전 등 돌발 상황을 감지하고 대응 절차를 실행합니다.",
  "통합 관제 에이전트": "전체 차량 상태를 실시간으로 모니터링하고 이상 징후를 탐지합니다.",
  "정비 인텔리전스 에이전트": "주행·배터리 데이터를 분석해 정비가 필요한 시점을 예측합니다.",
  "정비 오퍼레이션 에이전트": "정비·점검 작업을 차고지에 배정하고 진행 상황을 관리합니다.",
  "플릿 오케스트레이터 에이전트": "충전·재배치·정비의 우선순위를 종합적으로 조율합니다.",
};
const agentHistMap = {};       // seq -> 이벤트 (상세 보기용)
let agentClickBound = false;

function showAgentDetail(e) {
  const m = document.getElementById("agent-modal");
  if (!m) return;
  const cls = ["done", "active", "alert", "idle"].includes(e.state) ? e.state : "active";
  document.getElementById("am-agent").textContent = e.agent;
  const st = document.getElementById("am-state");
  st.textContent = AGENT_STATE_LABEL[cls];
  st.className = "ah-state " + cls;
  document.getElementById("am-desc").textContent = AGENT_DESC[e.agent] || "에이전트 활동 기록입니다.";
  document.getElementById("am-time").textContent = e.ts || e.time || "—";
  document.getElementById("am-text").textContent = e.text || "—";

  // 정비 내역 상세(정비 완료 이력에만 존재)
  const mbox = document.getElementById("am-maint");
  const d = e.detail;
  if (mbox && d && d.type === "maintenance") {
    const won = (n) => (n || 0).toLocaleString("ko-KR") + "원";
    const rows = (d.items || []).map(
      (it) => `<div class="mt-item"><span>${it.name}</span><span>${won(it.cost)}</span></div>`
    ).join("");
    mbox.innerHTML = `
      <div class="mt-title">🔧 정비 내역</div>
      <div class="mt-field"><span>정비 유형</span><b>${d.kind || "-"}</b></div>
      <div class="mt-field"><span>정비소</span><b>${d.shop || "-"}</b></div>
      <div class="mt-field"><span>소요 시간</span><b>약 ${d.duration_min || "-"}분</b></div>
      <div class="mt-items-head">정비 항목</div>
      ${rows}
      <div class="mt-total"><span>총 비용</span><span>${won(d.total_cost)}</span></div>
      ${d.after ? `<div class="mt-field"><span>정비 후 상태</span><b>배터리 ${d.after.battery}% · 청결 ${d.after.cleanliness}점</b></div>` : ""}
      ${d.note ? `<div class="mt-note">${d.note}</div>` : ""}`;
    mbox.style.display = "block";
  } else if (mbox) {
    mbox.style.display = "none";
    mbox.innerHTML = "";
  }
  m.classList.add("show");
}
function closeAgentModal() {
  const m = document.getElementById("agent-modal");
  if (m) m.classList.remove("show");
}

function agentHistRow(e) {
  const cls = ["done", "active", "alert", "idle"].includes(e.state) ? e.state : "active";
  return `
    <div class="ah-row ${cls}" data-seq="${e.seq}">
      <div class="ah-time">${e.time}</div>
      <div class="ah-dot"></div>
      <div class="ah-body">
        <div class="ah-agent">${e.agent}<span class="ah-state ${cls}">${AGENT_STATE_LABEL[cls]}</span></div>
        <div class="ah-text">${e.text}</div>
      </div>
      <div class="ah-go">›</div>
    </div>`;
}

function renderAgentHistory(list) {
  const box = document.getElementById("agent-history");
  if (!box) return;
  if (!list || !list.length) {
    if (!agentHistInit) box.innerHTML = `<div class="empty-hint">아직 기록된 활동이 없습니다.</div>`;
    return;
  }
  list.forEach((e) => { agentHistMap[e.seq] = e; });   // 상세 보기용으로 저장
  // 행 클릭 → 상세 모달 (한 번만 바인딩)
  if (!agentClickBound) {
    agentClickBound = true;
    box.addEventListener("click", (ev) => {
      const row = ev.target.closest(".ah-row");
      if (!row) return;
      const e = agentHistMap[row.getAttribute("data-seq")];
      if (e) showAgentDetail(e);
    });
  }
  if (!agentHistInit) {
    // 첫 렌더: seq 유무와 무관하게 현재 목록을 전부 표시(최신이 맨 위).
    box.innerHTML = "";
    list.slice().reverse().forEach((e) => box.insertAdjacentHTML("afterbegin", agentHistRow(e)));
    lastAgentSeq = Math.max(0, ...list.map((e) => e.seq || 0));
    agentHistInit = true;
  } else {
    // 이후: 아직 안 보여준 항목(seq>lastAgentSeq)만 앞에 덧붙인다.
    const fresh = list.filter((e) => (e.seq || 0) > lastAgentSeq);
    if (!fresh.length) return;
    fresh.slice().reverse().forEach((e) => box.insertAdjacentHTML("afterbegin", agentHistRow(e)));
    lastAgentSeq = Math.max(lastAgentSeq, ...fresh.map((e) => e.seq || 0));
  }
  // 화면 누적 항목이 너무 많아지면 꼬리(오래된 것)만 정리 (메모리/렌더 보호)
  const rows = box.querySelectorAll(".ah-row");
  if (rows.length > 200) {
    for (let i = 200; i < rows.length; i++) rows[i].remove();
  }
}

/* --------------------------------------------------------------- 게이지 */
function makeGauge(canvasId, color) {
  const ctx = document.getElementById(canvasId).getContext("2d");
  return new Chart(ctx, {
    type: "doughnut",
    data: {
      datasets: [{
        data: [0, 100],
        backgroundColor: [color, TRACK],
        borderWidth: 0,
        circumference: 360,
        rotation: 0,
      }],
    },
    options: {
      cutout: "76%",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      animation: { duration: 400 },
    },
  });
}

function updateGauge(chart, value, color) {
  const val = Math.max(0, Math.min(100, value));
  chart.data.datasets[0].data = [val, 100 - val];
  chart.data.datasets[0].backgroundColor = [color, TRACK];
  chart.update("none");
}

function renderGauges(v) {
  const bCol = batteryColor(v);
  updateGauge(batteryGauge, v.battery, bCol);
  const bNum = document.getElementById("g-battery-num");
  bNum.textContent = Math.round(v.battery) + "%";
  bNum.style.color = bCol;
  const bState = { CHARGING: "충전 중", DANGER: "위험 · 즉시 충전 필요",
                   CAUTION: "주의 · 충전 권고", NORMAL: "양호" }[v.battery_state];
  document.getElementById("g-battery-desc").textContent =
    `배터리 상태: ${bState}\n${v.status === "CHARGING" ? "차고지에서 충전 진행 중" : "주행 가능 범위 내"}`;

  const cond = Math.round(v.cleanliness);
  const cCol = conditionColor(cond);
  updateGauge(condGauge, cond, cCol);
  const cNum = document.getElementById("g-cond-num");
  cNum.textContent = cond;
  cNum.style.color = cCol;
  const cState = cond < 60 ? "청소·점검 필요" : cond < 80 ? "정비 모니터링" : "양호";
  document.getElementById("g-cond-desc").textContent =
    `청결·컨디션 점수 ${cond}점\n상태: ${cState}`;
}

/* --------------------------------------------------------------- 미니맵 */
function initMiniMap(v) {
  if (!window.kakao || !kakao.maps) {
    document.getElementById("mon-map").innerHTML =
      `<div class="empty-hint" style="padding:14px">카카오맵 SDK 로드 실패 — 도메인 등록/네트워크를 확인하세요.</div>`;
    return;
  }
  kakao.maps.load(() => {
    monMap = new kakao.maps.Map(document.getElementById("mon-map"), {
      center: new kakao.maps.LatLng(v.lat, v.lng),
      level: 5,
    });
    placeMarker(v);
  });
}

function placeMarker(v) {
  if (!monMap) return;
  const pos = new kakao.maps.LatLng(v.lat, v.lng);
  if (!monOverlay) {
    const el = document.createElement("div");
    el.className = "veh-marker";
    el.innerHTML = `<div class="veh-pill"><span class="car">🚖</span><span class="lbl">${v.id.replace("RT-", "")}</span></div>`;
    monOverlay = new kakao.maps.CustomOverlay({ position: pos, content: el, xAnchor: 0.5, yAnchor: 0.5, zIndex: 3 });
    monOverlay.setMap(monMap);
    monOverlay._el = el;
  }
  monOverlay.setPosition(pos);
  const pill = monOverlay._el.querySelector(".veh-pill");
  pill.style.background = v.marker_color;
  // 노란색(주의) 위에서는 흰 글자가 안 읽혀서 밝기에 따라 글자색을 바꾼다
  pill.style.color = isLight(v.marker_color) ? "#1b1f33" : "#fff";
  pill.classList.toggle("alert", !!v.incident);
  monMap.setCenter(pos);
}

/* #rrggbb 의 상대 휘도로 밝은 색인지 판정 */
function isLight(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.62;
}

/* --------------------------------------------------------------- 운행기록 */
function renderHistory(rows) {
  const body = document.getElementById("hist-body");
  if (!rows || !rows.length) {
    body.innerHTML = `<tr><td colspan="4" class="empty-hint">운행 기록이 없습니다.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((r) => `
    <tr>
      <td>${r.time}</td>
      <td>${r.route}</td>
      <td class="fare">${won(r.fare)}원</td>
      <td><span class="star">★</span> ${r.rating.toFixed(1)}</td>
    </tr>`).join("");
}

/* --------------------------------------------------------------- 조회/갱신 */
let historyLoaded = false;

async function refresh() {
  try {
    const res = await fetch(`/api/vehicle/${encodeURIComponent(VID)}`);
    if (res.status === 404) {
      document.getElementById("m-stat").textContent = "차량을 찾을 수 없습니다.";
      return;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const v = data.vehicle;

    renderVehicleCard(v);
    renderAgents(data.agent_log);
    renderAgentHistory(data.agent_history);
    renderGauges(v);
    placeMarker(v);

    // 운행 기록은 차량별 고정(합성)이므로 최초 1회만 렌더
    if (!historyLoaded) {
      renderHistory(data.history);
      historyLoaded = true;
    }
  } catch (e) {
    console.error("차량 정보 조회 실패", e);
  }
}

/* --------------------------------------------------------------- 시작 */
window.addEventListener("DOMContentLoaded", async () => {
  batteryGauge = makeGauge("g-battery", "#36b37e");
  condGauge = makeGauge("g-cond", "#36b37e");

  // 최초 데이터로 미니맵 중심을 잡기 위해 한 번 먼저 조회
  try {
    const res = await fetch(`/api/vehicle/${encodeURIComponent(VID)}`);
    if (res.ok) {
      const data = await res.json();
      const v = data.vehicle;
      renderVehicleCard(v);
      renderAgents(data.agent_log);
      renderAgentHistory(data.agent_history);
      renderGauges(v);
      renderHistory(data.history);
      historyLoaded = true;
      initMiniMap(v);
    }
  } catch (e) {
    console.error(e);
  }

  setInterval(refresh, REFRESH_MS);
});
