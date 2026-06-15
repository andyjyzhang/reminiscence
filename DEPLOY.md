# Local React App + RunPod GPU Backend

The React frontend runs locally. The cloud deployment runs only FastAPI, COLMAP,
and FastGS on a Linux GPU. It intentionally does not run Unity: download the
generated PLY and import it into Unity locally.

## Build and publish the image

Push the deployment files to `main`, then run the `Build GPU image` workflow in
GitHub Actions. It publishes:

```text
ghcr.io/andyjyzhang/reminiscence:gpu-latest
```

Make the GHCR package public, or configure RunPod registry authentication for
the private package.

## Create the RunPod Pod

Create a RunPod API key, then run:

```powershell
$env:RUNPOD_API_KEY="<runpod-api-key>"
.\deploy\create_runpod_pod.ps1
```

This creates an RTX 3090 Pod, exposes port `8000`, generates a separate API key
for the app, and writes the Pod URL to `frontend/.env.local`. It starts with
`1000` training iterations for an affordable first test.

## Use the API

Every protected request must include `X-API-Key`.

```powershell
curl.exe -H "X-API-Key: <key>" `
  -F "video=@clip.mp4" `
  -F "captured_at=2026-06-07T12:00:00Z" `
  -F "duration=10" `
  https://<pod-id>-8000.proxy.runpod.net/api/v1/moments
```

The upload returns a moment ID immediately. Poll its status:

```powershell
curl.exe -H "X-API-Key: <key>" `
  https://<pod-id>-8000.proxy.runpod.net/api/v1/moments/<moment-id>
```

When its status is `complete`, download the splat:

```powershell
curl.exe -H "X-API-Key: <key>" -o memory.ply `
  https://<pod-id>-8000.proxy.runpod.net/api/v1/moments/<moment-id>/splat
```

Create `frontend/.env.local` with the remote URL:

```powershell
VITE_API_BASE_URL=https://<pod-id>-8000.proxy.runpod.net
```

Then run the local React app:

```powershell
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`, enter the same API key configured on the Pod,
choose a video, and keep the page open while it polls the reconstruction job.

Delete the Pod when you are finished so GPU billing stops:

```powershell
.\deploy\remove_runpod_pod.ps1
```
