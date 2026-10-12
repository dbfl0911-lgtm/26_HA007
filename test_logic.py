"""로직 검증용 테스트."""
import os, tempfile, sys

# config import 전에 환경을 잡아둔다
os.environ["GEMINI_API_KEY"] = ""  # 키 없음 → 규칙 기반 폴백 경로
os.environ["OPENAI_API_KEY"] = ""  # OpenAI 키도 비움
os.environ["DB_PATH"] = os.path.join(tempfile.gettempdir(), "robotaxi_test.db")
os.environ["FLEET_SIZE"] = "12"
if os.path.exists(os.environ["DB_PATH"]):
    os.remove(os.environ["DB_PATH"])

from app.config import settings
from app import area, simulation, auth
from app.llm import assignment, risk, route

ok = 0; fail = 0
def check(name, cond):
    global ok, fail
    if cond: ok += 1; print(f"  \u2713 {name}")
    else: fail += 1; print(f"  \u2717 {name}  <-- \uc2e4\ud328")

print("\n[1] config / area (시흥 정왕동)")
check("llm_enabled == False (\ud0a4 \uc5c6\uc74c)", settings.llm_enabled is False)
check("ANCHORS 5개 이상 (정왕동)", len(area.ANCHORS) >= 5)
check("DEPOTS \uc874\uc7ac", len(area.DEPOTS) >= 1)
check("CENTER \uc88c\ud45c \uc0c1\uc218", isinstance(area.CENTER_LAT, float) and isinstance(area.CENTER_LNG, float))

print("\n[2] simulation \u2014 \uc0dd\uc131/\ud2f1/\uc2a4\ub0c5\uc0f7")
fleet = simulation.FleetSimulator(size=12, seed=7)
TOTAL = 12 + simulation.SUV_COUNT  # 세단 12 + 대형(SUV) 3대
check(f"차량 {TOTAL}대 생성(세단12+SUV{simulation.SUV_COUNT})", len(fleet.vehicles) == TOTAL)
vehlist = list(fleet.vehicles.values())
# 이동 검증
mv = vehlist[0]
mv.status = simulation.STATUS_DRIVING
mv.repositioning = False
mv.passenger = "테스트"
_o = area.ANCHORS[0]
_d = area.ANCHORS[min(3, len(area.ANCHORS) - 1)]
mv.lat, mv.lng = _o[1], _o[2]
mv.dest_name, mv.dest_lat, mv.dest_lng = _d[0], _d[1], _d[2]
mv.path = None
mv.route_wait = 0
pos_before = (mv.lat, mv.lng)
bat_before = [v.battery for v in vehlist]
for _ in range(50):
    fleet.tick()
vehlist2 = list(fleet.vehicles.values())
moved = (mv.lat, mv.lng) != pos_before
check("틱 후 차량 이동 발생", moved)
drained = any(v.battery != b for v, b in zip(vehlist2, bat_before))
check("\ud2f1 \ud6c4 \ubc30\ud130\ub9ac \ubcc0\ud654", drained)
snap = fleet.full_state()
check("full_state type==snapshot", snap.get("type") == "snapshot")
check(f"snapshot.vehicles {TOTAL}대", isinstance(snap.get("vehicles"), list) and len(snap["vehicles"]) == TOTAL)
check("snapshot.kpis.status_counts \uc874\uc7ac", "kpis" in snap and "status_counts" in snap["kpis"])
check("snapshot.alerts \uc874\uc7ac", "alerts" in snap)

print("\n[3] simulation \u2014 \ub370\uc774\ud130 \ud615\ud0dc")
vd = snap["vehicles"][0]
for key in ["id","plate","lat","lng","battery","status","status_label","battery_state","marker_color","rating","cleanliness"]:
    check(f"vehicle.{key} \ud3ec\ud568", key in vd)
check("battery_state \uac12 \uc815\uc0c1", vd["battery_state"] in ("CHARGING","DANGER","CAUTION","NORMAL"))
check("marker_color \ud5e5\uc2a4", isinstance(vd["marker_color"], str) and vd["marker_color"].startswith("#"))
counts = fleet.status_counts()
check(f"status_counts 합 == {TOTAL}", sum(counts.values()) == TOTAL)
check("kpis.deltas.trips \uc874\uc7ac", "deltas" in fleet.kpis() and "trips" in fleet.kpis()["deltas"])

print("\n[4] auth \u2014 DB/\ud574\uc2f1/\uc778\uc99d")
auth.init_db()
admin = auth.authenticate("admin@robotaxi.local", "admin1234")
check("\uc2dc\ub4dc \uad00\ub9ac\uc790 \ub85c\uadf8\uc778 \uc131\uacf5", admin is not None)
check("\uad00\ub9ac\uc790 \uc774\ub984 \uc874\uc7ac", bool(admin and admin.get("name")))
check("\uc798\ubabb\ub41c \ube44\ubc00\ubc88\ud638 \uac70\ubd80", auth.authenticate("admin@robotaxi.local", "wrongpw") is None)
created_ok, _ = auth.create_user("tester@robotaxi.local", "\ud14c\uc2a4\ud130", "pw123456")
check("\uc2e0\uaddc \uc0ac\uc6a9\uc790 \uc0dd\uc131", created_ok is True)
dup_ok, _ = auth.create_user("tester@robotaxi.local", "\ud14c\uc2a4\ud1602", "pw123456")
check("\uc911\ubcf5 \uc774\uba54\uc77c \uac70\ubd80", dup_ok is False)
newu = auth.authenticate("tester@robotaxi.local", "pw123456")
check("\uc2e0\uaddc \uc0ac\uc6a9\uc790 \ub85c\uadf8\uc778", newu is not None)
u = auth.get_user(newu["id"]) if newu else None  # get_user 는 \uc22b\uc790 id
check("get_user \ub294 pw_hash \ub178\ucd9c \uc548\ud568(\ubcf4\uc548)", u is not None and "pw_hash" not in u)
# \ud574\uc2f1 \ud3ec\ub9f7\uc740 DB\ub97c \uc9c1\uc811 \uc870\ud68c\ud574 \uac80\uc99d
import sqlite3 as _sq
_c = _sq.connect(os.environ["DB_PATH"])
_ph = _c.execute("SELECT pw_hash FROM users WHERE email=?", ("tester@robotaxi.local",)).fetchone()[0]
_c.close()
check("\ube44\ubc00\ubc88\ud638 pbkdf2 \ud574\uc2f1 \uc800\uc7a5(\ud3c9\ubb38 \uc544\ub2d8)", "pw123456" not in _ph and _ph.startswith("pbkdf2_sha256$"))

print("\n[5] LLM \ud3f4\ubc31 \u2014 \uaddc\uce59 \uae30\ubc18 \ub3d9\uc791")
o = {"name":"\uac15\ub0a8\uc5ed","lat":37.4979,"lng":127.0276}
d = {"name":"\uc11c\uc6b8\uc5ed","lat":37.5547,"lng":126.9707}
ar = assignment.assign(o, d, "\ubcf4\ud1b5")  # \uc804\uc5ed simulation.fleet \uc0ac\uc6a9
check("assign \ubc18\ud658 dict", isinstance(ar, dict))
check("assign engine \ud544\ub4dc", ar.get("engine") in ("gemini","openai","score","rule","none"))
check("assign eta/\uc0ac\uc720 \ud3ec\ud568", "eta_min" in ar and "reason" in ar)
rr = route.find_route(o, d, "\ubcf4\ud1b5")
check("route.primary \uacbd\uc720\uc810", isinstance(rr.get("primary"), list) and len(rr["primary"]) >= 2)
check("route eta/\uac70\ub9ac \ud3ec\ud568", "eta_min" in rr and "distance_km" in rr)
gv = list(simulation.fleet.vehicles.values())[0]
kr = risk.analyze(gv)
check("risk \uc810\uc218 0~100", 0 <= kr.get("score", -1) <= 100)
check("risk \ub4f1\uae09 \ud55c\uae00", kr.get("grade") in ("\uc591\ud638","\uc8fc\uc758","\uc704\ud5d8"))
check("risk engine \ud544\ub4dc", "engine" in kr)

print(f"\n========== \uacb0\uacfc: {ok} \ud1b5\uacfc / {fail} \uc2e4\ud328 ==========")
sys.exit(1 if fail else 0)
