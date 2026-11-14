import asyncio
import base64
import json

from fastapi import WebSocket, WebSocketDisconnect
from websockets.asyncio.client import ClientConnection, connect

from .recordings import MAX_PCM_BYTES, MAX_SECONDS, SAMPLE_RATE

OPENAI_URL = "wss://api.openai.com/v1/realtime?intent=transcription"
OPENAI_MODEL = "gpt-live-transcribe"
MAX_CHUNK_BYTES = 9_600
MIN_PCM_BYTES = SAMPLE_RATE * 2 // 10
SETUP_TIMEOUT = 12
FINALIZATION_TIMEOUT = 25


class TranscriptionError(Exception):
    pass


async def send_event(upstream: ClientConnection, event: dict) -> None:
    await upstream.send(json.dumps(event))


async def receive_event(upstream: ClientConnection) -> dict:
    event = json.loads(await upstream.recv())
    if event["type"] in ("error", "conversation.item.input_audio_transcription.failed"):
        raise TranscriptionError("Live transcription failed. Record again to retry.")
    return event


async def configure_session(upstream: ClientConnection) -> None:
    await send_event(upstream, {
        "type": "session.update",
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    "format": {"type": "audio/pcm", "rate": SAMPLE_RATE},
                    "transcription": {"model": OPENAI_MODEL},
                    "turn_detection": None,
                },
            },
        },
    })
    async with asyncio.timeout(SETUP_TIMEOUT):
        while (await receive_event(upstream))["type"] != "session.updated":
            pass


async def forward_audio(browser: WebSocket, upstream: ClientConnection) -> None:
    received = 0
    async with asyncio.timeout(MAX_SECONDS + 10):
        while True:
            message = await browser.receive()
            if message["type"] == "websocket.disconnect":
                raise WebSocketDisconnect(message["code"])

            chunk = message.get("bytes")
            if chunk is not None:
                if not chunk or len(chunk) % 2 or len(chunk) > MAX_CHUNK_BYTES:
                    raise TranscriptionError("Received an invalid audio chunk.")
                received += len(chunk)
                if received > MAX_PCM_BYTES:
                    raise TranscriptionError("Recordings can be up to 90 seconds.")
                await send_event(upstream, {
                    "type": "input_audio_buffer.append",
                    "audio": base64.b64encode(chunk).decode("ascii"),
                })
                continue

            if message.get("text") != "stop":
                raise TranscriptionError("An unexpected recording event was received.")
            if received < MIN_PCM_BYTES:
                raise TranscriptionError("The recording was too short. Record again to retry.")
            await send_event(upstream, {"type": "input_audio_buffer.commit"})
            return


async def final_transcript(upstream: ClientConnection) -> str:
    committed_item = None
    completed = {}
    while True:
        event = await receive_event(upstream)
        if event["type"] == "input_audio_buffer.committed":
            committed_item = event["item_id"]
        elif event["type"] == "conversation.item.input_audio_transcription.completed":
            completed[event["item_id"]] = event["transcript"]

        if committed_item in completed:
            return completed[committed_item].strip()


async def wait_for_disconnect(browser: WebSocket) -> None:
    while True:
        event = await browser.receive()
        if event["type"] == "websocket.disconnect":
            raise WebSocketDisconnect(event["code"])


async def transcribe(browser: WebSocket, api_key: str) -> str:
    async with connect(
        OPENAI_URL,
        additional_headers={"Authorization": f"Bearer {api_key}"},
        open_timeout=SETUP_TIMEOUT,
        close_timeout=2,
    ) as upstream:
        await configure_session(upstream)
        await browser.send_json({"type": "ready"})

        audio = asyncio.create_task(forward_audio(browser, upstream))
        transcript = asyncio.create_task(final_transcript(upstream))
        disconnect = None
        try:
            done, _ = await asyncio.wait((audio, transcript), return_when=asyncio.FIRST_COMPLETED)
            if audio in done:
                audio.result()
            if transcript in done:
                return transcript.result()
            disconnect = asyncio.create_task(wait_for_disconnect(browser))
            async with asyncio.timeout(FINALIZATION_TIMEOUT):
                done, _ = await asyncio.wait((transcript, disconnect), return_when=asyncio.FIRST_COMPLETED)
                if disconnect in done:
                    disconnect.result()
                return transcript.result()
        finally:
            tasks = (audio, transcript, disconnect) if disconnect else (audio, transcript)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
