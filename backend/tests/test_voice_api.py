import asyncio
import base64
import json
import struct
from uuid import uuid4

import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from voice_api import recordings, transcription
from voice_api.main import create_app
from voice_api.settings import Settings

ORIGIN = "http://localhost:3000"
AUDIO_HEADERS = {"Content-Type": "audio/wav", "Origin": ORIGIN}


@pytest.fixture
def client():
    settings = Settings(
        frontend_origin=ORIGIN,
        openai_api_key="test",
        r2_account_id="example",
        r2_bucket_name="voice-notes",
        r2_access_key_id="test",
        r2_secret_access_key="test",
    )
    return TestClient(create_app(settings))


def wav(samples=2400):
    pcm = b"\0\0" * samples
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + len(pcm), b"WAVE", b"fmt ", 16, 1, 1, 24000,
        48000, 2, 16, b"data", len(pcm),
    ) + pcm


@pytest.mark.parametrize("body,status", [
    (b"not a wav", 422),
    (wav()[:-2], 422),
    (wav(0), 422),
    (wav(90 * 24000 + 1), 413),
])
def test_invalid_audio_does_not_reach_r2(client, monkeypatch, body, status):
    def unexpected_storage_call(*args, **kwargs):
        pytest.fail("Invalid audio reached R2")

    monkeypatch.setattr(recordings.boto3, "client", unexpected_storage_call)
    response = client.put(f"/api/recordings/{uuid4()}", content=body, headers=AUDIO_HEADERS)
    assert response.status_code == status


def test_send_retry_uses_one_r2_key(client, monkeypatch):
    writes = []
    audio_url = "https://example.r2.cloudflarestorage.com/voice-notes/recordings/test.wav?signature=test"

    class FakeR2:
        def put_object(self, **kwargs):
            writes.append(kwargs)
            if len(writes) == 1:
                raise ClientError({"Error": {"Code": "ServiceUnavailable"}}, "PutObject")

        def generate_presigned_url(self, operation, Params, ExpiresIn):
            assert operation == "get_object"
            assert Params == {"Bucket": "voice-notes", "Key": writes[-1]["Key"]}
            assert ExpiresIn == 3600
            return audio_url

        def close(self):
            pass

    monkeypatch.setattr(recordings.boto3, "client", lambda *args, **kwargs: FakeR2())
    take_id = uuid4()
    route = f"/api/recordings/{take_id}"
    body = wav(90 * 24000)
    first_response = client.put(route, content=body, headers=AUDIO_HEADERS)
    assert first_response.status_code == 502
    retry = client.put(route, content=body, headers=AUDIO_HEADERS)
    assert retry.status_code == 200
    assert retry.json()["audioUrl"] == audio_url
    assert retry.json()["expiresAt"]
    assert [write["Key"] for write in writes] == [f"recordings/{take_id}.wav"] * 2
    assert all(write["ContentType"] == "audio/wav" and write["Body"] == body for write in writes)


class FakeOpenAI:
    def __init__(self, complete=True):
        self.complete = complete
        self.events = []
        self.exited = False

    async def __aenter__(self):
        self.replies = asyncio.Queue()
        return self

    async def __aexit__(self, *exc):
        self.exited = True

    async def send(self, encoded):
        event = json.loads(encoded)
        self.events.append(event)
        if event["type"] == "session.update":
            self.replies.put_nowait({"type": "session.updated"})
        if event["type"] == "input_audio_buffer.commit" and self.complete:
            # Prove the relay uses the committed item's final result.
            for reply in (
                {"type": "conversation.item.input_audio_transcription.delta", "delta": "partial"},
                {"type": "conversation.item.input_audio_transcription.completed", "item_id": "other", "transcript": "wrong"},
                {"type": "conversation.item.input_audio_transcription.completed", "item_id": "take", "transcript": "A voice note."},
                {"type": "input_audio_buffer.committed", "item_id": "take"},
            ):
                self.replies.put_nowait(reply)

    async def recv(self):
        return json.dumps(await self.replies.get())


def test_transcribes_the_same_samples_and_only_returns_the_final_text(client, monkeypatch):
    provider = FakeOpenAI()
    monkeypatch.setattr(transcription, "connect", lambda *args, **kwargs: provider)
    chunk = b"\x01\x00" * 2400
    with client.websocket_connect("/api/transcription", headers={"origin": ORIGIN}) as socket:
        assert socket.receive_json() == {"type": "ready"}
        socket.send_bytes(chunk)
        socket.send_text("stop")
        assert socket.receive_json() == {"type": "transcript", "text": "A voice note."}
    assert provider.events[0]["session"]["audio"]["input"]["transcription"]["model"] == "gpt-live-transcribe"
    assert base64.b64decode(provider.events[1]["audio"]) == chunk
    assert provider.events[2]["type"] == "input_audio_buffer.commit"
    assert provider.exited


@pytest.mark.parametrize("stop_first", [False, True])
def test_closes_openai_connection_when_take_is_discarded(client, monkeypatch, stop_first):
    provider = FakeOpenAI(complete=False)
    monkeypatch.setattr(transcription, "connect", lambda *args, **kwargs: provider)
    with client.websocket_connect("/api/transcription", headers={"origin": ORIGIN}) as socket:
        assert socket.receive_json() == {"type": "ready"}
        socket.send_bytes(b"\x01\x00" * 2400)
        if stop_first:
            socket.send_text("stop")
        socket.close()
    assert provider.exited


def test_rejects_other_websocket_origins(client):
    with pytest.raises(WebSocketDisconnect) as error:
        with client.websocket_connect("/api/transcription", headers={"origin": "https://other.example"}):
            pytest.fail("Unexpected origin was allowed")
    assert error.value.code == 1008
