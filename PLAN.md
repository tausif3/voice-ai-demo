# Voice recording demo with Next.js and FastAPI

## Summary

Build a single-page app with a plain canvas and a voice button. OpenAI transcribes each take while the user speaks. The transcript stays hidden in tab memory until **Send**. Sending reveals the transcript in a message bubble and saves the recording to a private Cloudflare R2 bucket.

## Implementation

- **Recording.** Use the Next.js App Router with TypeScript. Show a countdown and three recording actions. **Stop** ends capture and prepares the take for review. **Play** previews the take locally. **Record again** discards the current audio and transcript and starts a fresh take. At 90 seconds, automatically stop and enter review without sending.
- **Live transcription.** Use an `AudioWorklet` to capture mono 24 kHz PCM and cap the clip at 90 seconds of samples. Keep the audio in browser memory for WAV preview and stream the same samples to FastAPI over `WS /api/transcription`. FastAPI relays them to OpenAI’s `gpt-live-transcribe`, commits the audio on Stop, and returns the final transcript. Enable **Send** once the transcript is ready. If transcription fails, keep the take playable and let the user record again. [OpenAI Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
- **Send and playback.** Show the transcript immediately on Send, with an upload status beside it. Send the WAV to `PUT /api/recordings/{take_id}`. FastAPI validates the format, size, and duration, then uploads it through R2’s S3-compatible API. Return `{audioUrl, expiresAt}` and show an inline audio player and **Open recording** link. If upload fails, offer **Retry upload** on the same bubble and reuse the same object key. If OpenAI returns an empty transcript, show “No speech detected” and still allow the user to send the audio. [Cloudflare R2 Boto3 setup](https://developers.cloudflare.com/r2/examples/aws/boto3/), [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)

## Verification

- Exercise microphone permission, manual Stop, local Play, and Record again. Verify that late transcription results from a discarded take cannot appear in the next take.
- Run a full 90-second recording. Verify that the microphone is released, the WAV contains at most 90 seconds of audio, and nothing reaches R2 before Send.
- Test the API with mocked providers for malformed or oversized audio, transcription disconnects, and failed uploads. Verify that retry creates one message and uses one R2 object key. Run the frontend build and, when credentials are configured, verify live transcription and playback from the signed R2 link.

## Defaults and setup

Run Next.js and FastAPI as separate localhost services. Include a README and sample environment configuration, with OpenAI and bucket-scoped R2 credentials loaded only by FastAPI. Drafts and message history reset on refresh. Sent audio stays in R2, and each playback link expires one hour after signing.
