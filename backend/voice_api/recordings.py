from datetime import UTC, datetime, timedelta
from struct import Struct
from uuid import UUID

import boto3
from botocore.config import Config
from fastapi import Request
from pydantic import BaseModel

from .settings import Settings

SAMPLE_RATE = 24_000
BYTES_PER_SAMPLE = 2
MAX_SECONDS = 90
MAX_PCM_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * MAX_SECONDS

WAV_HEADER = Struct("<4sI4s4sIHHIIHH4sI")
MAX_WAV_BYTES = WAV_HEADER.size + MAX_PCM_BYTES
LINK_TTL_SECONDS = 3600


class RecordingLink(BaseModel):
    audioUrl: str
    expiresAt: datetime


class RecordingTooLarge(ValueError):
    pass


async def read_recording(request: Request) -> bytes:
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_WAV_BYTES:
            raise RecordingTooLarge
        body.extend(chunk)
    return bytes(body)


def validate_wav(body: bytes) -> None:
    pcm_size = len(body) - WAV_HEADER.size
    if pcm_size <= 0 or pcm_size % BYTES_PER_SAMPLE:
        raise ValueError("The WAV must contain whole audio samples.")
    if pcm_size > MAX_PCM_BYTES:
        raise RecordingTooLarge

    # The browser writes a PCM WAV with a single format chunk and a single data chunk.
    expected_header = (
        b"RIFF", len(body) - 8, b"WAVE", b"fmt ", 16, 1, 1, SAMPLE_RATE,
        SAMPLE_RATE * BYTES_PER_SAMPLE, BYTES_PER_SAMPLE, 16, b"data", pcm_size,
    )
    if WAV_HEADER.unpack_from(body) != expected_header:
        raise ValueError("Expected a mono 24 kHz, 16-bit PCM WAV file.")


def store_recording(settings: Settings, take_id: UUID, body: bytes) -> RecordingLink:
    client = boto3.client(
        "s3",
        endpoint_url=f"https://{settings.r2_account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=settings.r2_access_key_id,
        aws_secret_access_key=settings.r2_secret_access_key,
        region_name="auto",
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            request_checksum_calculation="when_required",
            connect_timeout=5,
            read_timeout=15,
            retries={"total_max_attempts": 2, "mode": "standard"},
        ),
    )
    bucket = settings.r2_bucket_name
    key = f"recordings/{take_id}.wav"
    try:
        client.put_object(
            Bucket=bucket,
            Key=key,
            Body=body,
            ContentType="audio/wav",
            CacheControl="private, no-store",
        )
        expires_at = datetime.now(UTC) + timedelta(seconds=LINK_TTL_SECONDS)
        audio_url = client.generate_presigned_url(
            "get_object",
            Params={"Bucket": bucket, "Key": key},
            ExpiresIn=LINK_TTL_SECONDS,
        )
        return RecordingLink(audioUrl=audio_url, expiresAt=expires_at)
    finally:
        client.close()
