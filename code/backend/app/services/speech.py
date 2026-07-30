"""Azure AI Speech — text-to-speech and speech-to-text, over plain REST.

We deliberately call the REST API with httpx instead of installing the Speech SDK.
Two reasons, both pedagogical: it keeps the dependency list honest, and it shows
what an "AI service" actually is once the SDK wrapper is removed — an HTTP
endpoint, a key or token, a content type, and bytes in both directions.

A Speech resource is *separate* from your Foundry resource: its own endpoint, its
own region, its own key. That is the point made in the session — services are not
the model, and one credential does not open all of them.

Two ways to address it: a region (`<region>.tts.speech.microsoft.com`) or, for
resources with a custom subdomain (multi-service "AI Foundry" accounts included),
the resource's own endpoint host (`<resource>.cognitiveservices.azure.com`) — the
path suffixes are identical either way.

Config:  AZURE_SPEECH_KEY, and either AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import httpx

from ..config import settings

# 24 kHz mono PCM in a RIFF container — plays in any browser, no codec needed
TTS_FORMAT = "riff-24khz-16bit-mono-pcm"


class SpeechUnavailable(Exception):
    """Raised with instructions when the Speech resource is not configured."""


def _require_config() -> None:
    if not settings.azure_speech_key:
        raise SpeechUnavailable(
            "Azure Speech is not configured. Create a Speech resource in the Azure portal, "
            "then set AZURE_SPEECH_KEY plus AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT in .env "
            "(see the Session 4 page, 'Speech: giving the assistant a voice')."
        )
    if not settings.azure_speech_region and not settings.azure_speech_endpoint:
        raise SpeechUnavailable(
            "Azure Speech has a key but no region or endpoint. Set AZURE_SPEECH_REGION "
            "(e.g. swedencentral) or AZURE_SPEECH_ENDPOINT (the resource's custom-domain host) in .env."
        )


def _host(subdomain: str) -> str:
    """The Speech host, without scheme or trailing slash.

    A custom-domain endpoint (multi-service "AI Foundry" resources) serves both
    TTS and STT off the *same* host; the region-based form splits them across
    `<region>.tts...` and `<region>.stt...`, hence the subdomain argument.
    """
    if settings.azure_speech_endpoint:
        return settings.azure_speech_endpoint.strip().rstrip("/").removeprefix("https://").removeprefix("http://")
    return f"{settings.azure_speech_region}.{subdomain}.speech.microsoft.com"


def synthesize(text: str, voice: str | None = None) -> bytes:
    """Text -> spoken audio (WAV bytes). The request body is SSML."""
    _require_config()
    voice = voice or settings.azure_speech_voice
    locale = "-".join(voice.split("-")[:2]) if "-" in voice else "en-US"

    ssml = (
        f'<speak version="1.0" xml:lang="{locale}">'
        f'<voice xml:lang="{locale}" name="{voice}">{_escape(text)}</voice>'
        f"</speak>"
    )
    url = f"https://{_host('tts')}/cognitiveservices/v1"

    response = httpx.post(
        url,
        headers={
            "Ocp-Apim-Subscription-Key": settings.azure_speech_key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": TTS_FORMAT,
            "User-Agent": "libra-academy",
        },
        content=ssml.encode("utf-8"),
        timeout=30.0,
    )
    if response.status_code != 200:
        raise SpeechUnavailable(
            f"Speech synthesis failed: HTTP {response.status_code} — {response.text[:300]}"
        )
    return response.content


def transcribe(audio: bytes, content_type: str = "audio/wav", language: str | None = None) -> dict:
    """Spoken audio -> text. Short-audio endpoint: up to about 60 seconds.

    This REST endpoint takes exactly one `language` and has no built-in auto-detect
    (real language identification on Azure Speech requires the SDK, which this module
    deliberately avoids — see the module docstring). We fake it: when no language is
    forced, the same audio is sent once per candidate in `azure_speech_candidate_languages`
    (in parallel, so it costs latency, not wall-clock multiples) and the transcript with
    the highest confidence wins. A Romanian sentence recognized as en-US typically comes
    back as low-confidence gibberish, so the ro-RO attempt beats it, and vice versa.
    """
    _require_config()
    if language:
        return _transcribe_one(audio, content_type, language)

    candidates = [c.strip() for c in settings.azure_speech_candidate_languages.split(",") if c.strip()]
    if len(candidates) <= 1:
        return _transcribe_one(audio, content_type, candidates[0] if candidates else settings.azure_speech_language)

    with ThreadPoolExecutor(max_workers=len(candidates)) as pool:
        results = list(pool.map(lambda lang: _transcribe_one(audio, content_type, lang), candidates))

    return max(results, key=lambda r: r.get("confidence") or 0.0)


def _transcribe_one(audio: bytes, content_type: str, language: str) -> dict:
    url = f"https://{_host('stt')}/speech/recognition/conversation/cognitiveservices/v1"
    response = httpx.post(
        url,
        params={"language": language, "format": "detailed"},
        headers={
            "Ocp-Apim-Subscription-Key": settings.azure_speech_key,
            "Content-Type": f"{content_type}; codecs=audio/pcm; samplerate=16000",
            "Accept": "application/json",
        },
        content=audio,
        timeout=60.0,
    )
    if response.status_code != 200:
        raise SpeechUnavailable(
            f"Speech recognition failed: HTTP {response.status_code} — {response.text[:300]}"
        )

    data = response.json()
    best = (data.get("NBest") or [{}])[0]
    return {
        "status": data.get("RecognitionStatus"),
        "text": data.get("DisplayText") or best.get("Display", ""),
        "confidence": best.get("Confidence"),
        "duration_seconds": round(data.get("Duration", 0) / 10_000_000, 2),
        "language": language,
    }


def _escape(text: str) -> str:
    return (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
