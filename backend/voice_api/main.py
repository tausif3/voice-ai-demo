import logging
from uuid import UUID

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool
from websockets.exceptions import WebSocketException

from .recordings import (
    RecordingLink,
    RecordingTooLarge,
    read_recording,
    store_recording,
    validate_wav,
)
from .settings import Settings
from .transcription import TranscriptionError, transcribe

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    app = FastAPI(title="Voice recording demo")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.frontend_origin],
        allow_methods=["PUT"],
        allow_headers=["Content-Type"],
    )

    @app.websocket("/api/transcription")
    async def live_transcription(socket: WebSocket) -> None:
        if socket.headers.get("origin") != settings.frontend_origin:
            await socket.close(code=1008)
            return
        await socket.accept()

        try:
            try:
                if not settings.openai_api_key:
                    raise TranscriptionError("Live transcription is unavailable. Set OPENAI_API_KEY on the server.")
                transcript = await transcribe(socket, settings.openai_api_key)
                await socket.send_json({"type": "transcript", "text": transcript})
                await socket.close()
            except TranscriptionError as error:
                await socket.send_json({"type": "error", "message": str(error)})
                await socket.close(code=1008)
            except (TimeoutError, OSError, WebSocketException) as error:
                logger.warning("Live transcription connection failed (%s)", type(error).__name__)
                await socket.send_json({
                    "type": "error",
                    "message": "The transcription connection was interrupted. Record again to retry.",
                })
                await socket.close(code=1011)
        except WebSocketDisconnect:
            return

    @app.put("/api/recordings/{take_id}", response_model=RecordingLink)
    async def upload_recording(take_id: UUID, request: Request) -> RecordingLink:
        origin = request.headers.get("origin")
        if origin and origin != settings.frontend_origin:
            raise HTTPException(403, "Unexpected request origin.")
        media_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if media_type != "audio/wav":
            raise HTTPException(415, "Send the recording as audio/wav.")
        try:
            body = await read_recording(request)
            validate_wav(body)
        except RecordingTooLarge as error:
            raise HTTPException(413, "Recordings can be up to 90 seconds.") from error
        except ValueError as error:
            raise HTTPException(422, str(error)) from error

        if not settings.r2_configured:
            raise HTTPException(503, "Recording storage is unavailable. Set the R2 credentials on the server.")
        try:
            return await run_in_threadpool(store_recording, settings, take_id, body)
        except (BotoCoreError, ClientError) as error:
            logger.warning("R2 upload failed (%s)", type(error).__name__)
            raise HTTPException(502, "The recording could not be saved. Retry the upload.") from error

    return app


app = create_app()
