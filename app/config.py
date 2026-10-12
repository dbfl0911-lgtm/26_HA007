"""환경 설정."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

# 프로젝트 루트
BASE_DIR = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    """아주 단순한 .env 로더. KEY=VALUE 형식만 지원한다."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        # 이미 OS 환경변수로 지정돼 있으면 그것을 우선한다
        os.environ.setdefault(key, value)


_load_dotenv(BASE_DIR / ".env")


@dataclass
class Settings:
    # 카카오 지도 (JavaScript 키)
    kakao_js_key: str = os.environ.get(
        "KAKAO_JS_KEY", "5b382e4eefd68e4695a484b56aba6cf8"
    )

    # 카카오모빌리티 길찾기 REST 키
    kakao_rest_key: str = os.environ.get("KAKAO_REST_KEY", "")

    # Google Gemini
    gemini_api_key: str = os.environ.get("GEMINI_API_KEY", "")
    gemini_model: str = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

    # OpenAI (ChatGPT)
    openai_api_key: str = os.environ.get("OPENAI_API_KEY", "")
    openai_model: str = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")

    # 세션/보안
    secret_key: str = os.environ.get(
        "SECRET_KEY", "robotaxi-dev-secret-change-me-please"
    )

    # 시뮬레이션
    fleet_size: int = int(os.environ.get("FLEET_SIZE", "47"))
    tick_seconds: float = float(os.environ.get("TICK_SECONDS", "2.0"))

    # 데이터베이스 (SQLite 파일 경로)
    db_path: str = os.environ.get("DB_PATH", str(BASE_DIR / "robotaxi.db"))

    @property
    def llm_provider(self) -> str:
        """사용할 LLM 공급자: 'openai' / 'gemini' / '' (없음=규칙 기반)."""
        if self.openai_api_key:
            return "openai"
        if self.gemini_api_key:
            return "gemini"
        return ""

    @property
    def llm_enabled(self) -> bool:
        return bool(self.llm_provider)

    @property
    def llm_label(self) -> str:
        """시작 로그/화면 표시용 모델 이름."""
        if self.llm_provider == "openai":
            return f"OpenAI({self.openai_model})"
        if self.llm_provider == "gemini":
            return f"Gemini({self.gemini_model})"
        return "미설정(규칙 기반 폴백)"

    @property
    def llm_name(self) -> str:
        """사용자 표시용 공급자 이름: 'ChatGPT' / 'Gemini' / '' ."""
        if self.llm_provider == "openai":
            return "ChatGPT"
        if self.llm_provider == "gemini":
            return "Gemini"
        return ""

    @property
    def llm_model(self) -> str:
        """현재 사용 중인 모델 문자열(공급자에 맞게)."""
        if self.llm_provider == "openai":
            return self.openai_model
        if self.llm_provider == "gemini":
            return self.gemini_model
        return ""


settings = Settings()
