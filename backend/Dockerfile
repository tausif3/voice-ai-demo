FROM python:3.12-slim-bookworm AS build

COPY --from=ghcr.io/astral-sh/uv:0.11.21 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project --no-cache --no-managed-python

FROM python:3.12-slim-bookworm

WORKDIR /app
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN useradd --create-home --uid 10001 app
COPY --from=build /app/.venv ./.venv
COPY voice_api ./voice_api

USER app
EXPOSE 8000
CMD ["uvicorn", "voice_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--ws", "websockets-sansio", "--ws-max-size", "16384"]
