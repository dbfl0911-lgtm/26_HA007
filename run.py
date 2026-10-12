"""실행 스크립트."""

import uvicorn
import socket


def _lan_ip() -> str:
    """같은 와이파이의 휴대폰이 접속할 이 PC 의 IP 주소를 찾는다."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # 실제 전송 없음
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


if __name__ == "__main__":
    ip = _lan_ip()
    print("=" * 60)
    print("  로보택시 통합관제 대시보드")
    print("  ▶ 이 PC 에서:      http://127.0.0.1:8000")
    print(f"  ▶ 휴대폰·다른 기기: http://{ip}:8000")
    print(f"     · 데모 제어:     http://{ip}:8000/control")
    print(f"     · 고객 앱(AgentTaxi) RobotaxiApi.kt 의 BASE_URL 을")
    print(f"       \"http://{ip}:8000\" 로 설정하세요.")
    print("  ▶ 기본 관리자:  admin@robotaxi.local / admin1234")
    print("  ▶ 종료:  터미널에서 Ctrl + C")
    print("=" * 60)
    # reload=True: 코드 수정 시 자동 재시작
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
