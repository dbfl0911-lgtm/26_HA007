"""Gemini 호출 래퍼."""

from __future__ import annotations

import json

from ..config import settings

_client = None  # 지연 초기화된 genai.Client


def available() -> bool:
    return settings.llm_enabled


def _get_client():
    global _client
    if _client is not None:
        return _client
    from google import genai  # 지연 import

    _client = genai.Client(api_key=settings.gemini_api_key)
    return _client


def generate_json(system_prompt: str, user_payload: dict, schema_hint: str) -> dict | None:
    """Gemini에게 JSON 형식 응답을 요청한다."""
    if not available():
        return None
    try:
        from google.genai import types

        client = _get_client()
        prompt = (
            f"{system_prompt}\n\n"
            f"[입력 데이터(JSON)]\n{json.dumps(user_payload, ensure_ascii=False, indent=2)}\n\n"
            f"[출력 형식]\n{schema_hint}\n\n"
            "위 출력 형식의 JSON 객체 '하나만' 출력하세요. 코드블록이나 설명은 넣지 마세요."
        )
        resp = client.models.generate_content(
            model=settings.gemini_model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                temperature=0.3,
            ),
        )
        text = (resp.text or "").strip()
        if not text:
            return None
        return json.loads(text)
    except Exception as exc:  # 네트워크/쿼터/파싱 등 모든 예외 → 폴백
        print(f"[gemini] 호출 실패 → 규칙 기반 폴백 사용: {exc}")
        return None
