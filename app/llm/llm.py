"""LLM 호출 디스패처. OpenAI 우선, 없으면 Gemini."""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from ..config import settings
from . import gemini

_OPENAI_URL = "https://api.openai.com/v1/chat/completions"
_warned = False


def available() -> bool:
    return settings.llm_enabled


def provider() -> str:
    """현재 사용 중인 LLM 공급자 문자열('openai'/'gemini'/'')."""
    return settings.llm_provider


# engine 코드값 → 사용자 표시용 이름
_ENGINE_LABELS = {
    "openai": "ChatGPT", "gemini": "Gemini",
    "score": "점수식", "rule": "규칙기반", "none": "없음", "ai": "AI",
}


def engine_label(code: str) -> str:
    """engine 코드를 표시용 이름으로 바꾼다."""
    return _ENGINE_LABELS.get(code, code or "규칙기반")


def _openai_generate_json(system_prompt: str, user_payload: dict, schema_hint: str) -> dict | None:
    """OpenAI Chat Completions(JSON 모드)로 JSON 응답을 받는다."""
    global _warned
    user_content = (
        f"[입력 데이터(JSON)]\n{json.dumps(user_payload, ensure_ascii=False, indent=2)}\n\n"
        f"[출력 형식]\n{schema_hint}\n\n"
        "위 출력 형식에 맞는 JSON 객체 하나만 출력하세요. 코드블록이나 설명은 넣지 마세요."
    )
    body = json.dumps({
        "model": settings.openai_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.3,
    }).encode("utf-8")
    req = urllib.request.Request(
        _OPENAI_URL, data=body, method="POST",
        headers={
            "Authorization": f"Bearer {settings.openai_api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        content = data["choices"][0]["message"]["content"].strip()
        if not content:
            return None
        return json.loads(content)
    except urllib.error.HTTPError as exc:
        if not _warned:
            detail = ""
            try:
                detail = exc.read().decode("utf-8")[:300]
            except Exception:
                pass
            hint = ""
            if exc.code == 401:
                hint = "(401: OpenAI 키가 올바른지 확인) "
            elif exc.code == 429:
                hint = "(429: 사용량/크레딧 초과 — OpenAI 결제/잔액 확인) "
            print(f"[openai] HTTP {exc.code} → 규칙 기반 폴백. {hint}{detail}")
            _warned = True
        return None
    except Exception as exc:
        if not _warned:
            print(f"[openai] 호출 실패 → 규칙 기반 폴백 사용: {exc}")
            _warned = True
        return None


def generate_json(system_prompt: str, user_payload: dict, schema_hint: str) -> dict | None:
    """설정된 공급자로 JSON 응답을 생성한다(OpenAI 우선, 그다음 Gemini). 실패 시 None."""
    provider = settings.llm_provider
    if provider == "openai":
        return _openai_generate_json(system_prompt, user_payload, schema_hint)
    if provider == "gemini":
        return gemini.generate_json(system_prompt, user_payload, schema_hint)
    return None
