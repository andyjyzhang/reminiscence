# Vercel Frontend + Modal GPU Deployment

The React frontend runs on Vercel. Modal hosts a small CPU API and starts one
A10 GPU worker only while a reconstruction is running. No GPU workload runs on
your local computer or on Vercel.

## Cost and abuse controls

The limits are defined near the top of `modal_app.py`:

```text
GPU workers:          1 maximum
GPU job timeout:      20 minutes
Daily jobs:           10 maximum
Monthly jobs:         30 maximum
Upload size:          200 MB maximum
Result retention:     7 days
Training iterations:  1000
```

Both the API and GPU worker scale to zero when idle. Every upload, status, and
download request requires the generated `X-API-Key`. Modal's Starter plan
includes $30/month in compute credit, but you should also set a `$30` workspace
budget in Modal under **Settings > Usage & Billing > Workspace budget**.

## First deployment

Create free accounts at [Modal](https://modal.com) and
[Vercel](https://vercel.com), then install and authenticate their CLIs:

```powershell
python -m pip install -r deploy\requirements.txt
python -m modal token new
npx vercel login
```

Deploy both services:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\deploy_cloud.ps1
```

The script:

1. Generates a strong API key.
2. Saves it as the Modal secret `reminiscence-secrets`.
3. Deploys the Modal API and GPU worker.
4. Saves the endpoint and API key to ignored file `deploy/.modal-state.json`.
5. Links and deploys the React frontend as the Vercel project `reminiscence`.
6. Configures `VITE_API_BASE_URL` for the Vercel production deployment.

Enter the generated API key in the deployed web app before uploading a video.
Do not put that API key in a `VITE_` environment variable because Vite exposes
those values to every browser visitor.

## Deploy services separately

Redeploy Modal after changing `modal_app.py` or GPU behavior:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\deploy_modal.ps1 -SkipSecret
```

Redeploy Vercel after changing the React frontend:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\deploy_vercel.ps1
```

To deliberately rotate the API key:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\deploy_modal.ps1
```

## Local frontend against Modal

After Modal has deployed, copy its URL from `deploy/.modal-state.json` into
`frontend/.env.local`:

```text
VITE_API_BASE_URL=https://your-modal-web-endpoint.modal.run
```

Then run:

```powershell
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` and enter the API key stored in
`deploy/.modal-state.json`.

## Architecture

- Vercel serves the static React/Vite app.
- Modal's CPU web function receives uploads and polls jobs.
- A Modal Volume stores uploaded videos and generated PLY files.
- A queued Modal A10 function runs COLMAP and FastGS.
- Completed jobs return a downloadable PLY file.
- A daily cleanup job removes files older than seven days.

Modal function results also expire after seven days, so old job URLs stop
working even if a stale browser tab remains open.
