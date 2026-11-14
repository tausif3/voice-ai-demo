# Voice notes

A Next.js page for recording and sharing voice notes, backed by FastAPI. The browser captures each take for local playback and streams the same audio through FastAPI to OpenAI for live transcription. **Stop** or the 90-second limit ends capture. **Play** previews the draft, and **Record again** replaces it. **Send** reveals the transcript and uploads the WAV to Cloudflare R2.

## Run locally

Use Node.js 22.13+ LTS, Python 3.12+, and [uv](https://docs.astral.sh/uv/getting-started/installation/).

1. Create a private R2 bucket and a bucket-scoped [R2 API token](https://developers.cloudflare.com/r2/api/tokens/) with Object Read & Write permissions. Use the S3 access key ID and secret generated for the token.
2. Set the R2 values and an OpenAI API key with access to [`gpt-live-transcribe`](https://developers.openai.com/api/docs/models/gpt-live-transcribe) in `backend/.env`. Use `backend/.env.example` as the template. Run the following commands to sync the locked Python dependencies and start FastAPI.

   ```sh
   cd backend
   uv run --locked uvicorn voice_api.main:app --host 127.0.0.1 --port 8000 --ws websockets-sansio --ws-max-size 16384
   ```

3. In a second terminal, start Next.js:

   ```sh
   cd frontend
   npm ci
   npm run dev
   ```

   If you use `nvm`, run `nvm use` from `frontend` before `npm ci`. On Apple Silicon, `node -p process.arch` should print `arm64`. If Next.js is already running under Rosetta, stop it with Ctrl+C, switch Node versions, then run `npm ci` and `npm run dev` again.

4. Open [http://localhost:3000](http://localhost:3000) and allow microphone access. For a different frontend origin, set `FRONTEND_ORIGIN` in the backend. For a different API base URL, copy `frontend/.env.example` to `frontend/.env.local` and update it.

The recording, transcript, and message list live in tab memory. Refreshing the page clears them. Only sent audio is stored in R2. The player and **Open recording** use a signed URL that expires after one hour. Anyone with that link can use it before expiration. The audio object remains in the bucket.

## Run with Docker

Build and run either service independently from the repository root. For the backend, populate `backend/.env` using `backend/.env.example` before starting the container.

```sh
docker build -t voice-ai-backend ./backend
docker run --rm -p 8000:8000 --env-file backend/.env voice-ai-backend
```

In a separate terminal, build and run the frontend, then open [http://localhost:3000](http://localhost:3000).

```sh
docker build -t voice-ai-frontend ./frontend
docker run --rm -p 3000:3000 voice-ai-frontend
```

For separate deployments, build the frontend with `--build-arg NEXT_PUBLIC_API_URL=https://api.example.com`, using the backend URL reachable from users’ browsers. Changing this URL requires a frontend rebuild. Set `FRONTEND_ORIGIN=https://voice.example.com` in the backend’s runtime environment using the exact public frontend origin, and supply the OpenAI and R2 credentials there as well. Serve both deployments over HTTPS and enable WebSocket upgrades on the backend.

## Checks

From `backend`, run `uv run --locked python -m pytest`. The tests mock OpenAI and R2. To add a backend dependency, run `uv add <package>` for runtime or `uv add --dev <package>` for development.

From `frontend`, run `npm run typecheck`, `npm run lint`, and `npm run build`. To test the full flow with credentials, record and stop a take, play it, record a replacement, then send the replacement and play it from its R2 URL. Leave a separate take running for 90 seconds to check automatic stop.

See [PLAN.md](PLAN.md) for the implementation plan.
