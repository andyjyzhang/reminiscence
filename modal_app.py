from __future__ import annotations

import hmac
import os
import shutil
import subprocess
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

import modal


APP_NAME = "reminiscence"
GPU_IMAGE = "ghcr.io/andyjyzhang/reminiscence:gpu-latest"
VOLUME_NAME = "reminiscence-data"
USAGE_DICT_NAME = "reminiscence-usage"
SECRET_NAME = "reminiscence-secrets"

DATA_ROOT = Path("/reminiscence-data")
JOB_ROOT = DATA_ROOT / "jobs"
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
DAILY_JOB_LIMIT = 10
MONTHLY_JOB_LIMIT = 30
TRAINING_ITERATIONS = 1000
JOB_TIMEOUT_SECONDS = 20 * 60
RETENTION_DAYS = 7

app = modal.App(APP_NAME, tags={"project": "reminiscence"})
data_volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)
usage = modal.Dict.from_name(USAGE_DICT_NAME, create_if_missing=True)
api_secret = modal.Secret.from_name(SECRET_NAME, required_keys=["REMINISCENCE_API_KEY"])

web_image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "fastapi==0.124.4",
    "python-multipart==0.0.20",
)
gpu_image = modal.Image.from_registry(GPU_IMAGE)


def _public_result(call_id: str, result: dict) -> dict:
    return {
        key: value
        for key, value in {**result, "id": call_id}.items()
        if key not in {"splat_path"}
    }


@app.function(
    image=gpu_image,
    gpu="A10",
    volumes={str(DATA_ROOT): data_volume},
    timeout=JOB_TIMEOUT_SECONDS,
    max_containers=1,
    scaledown_window=30,
)
def reconstruct(upload_id: str, captured_at: str, duration: str) -> dict:
    from backend.rendering_pipeline import prepare_fastgs_input_and_train
    from backend.unity_splat_transfer import find_fastgs_point_cloud

    data_volume.reload()
    project_root = Path("/app")
    job_dir = JOB_ROOT / upload_id
    video_path = job_dir / "input.mp4"
    work_dir = Path("/tmp") / f"reminiscence-{upload_id}"
    colmap_output_dir = work_dir / "colmap"
    pipeline_result = None

    if not video_path.is_file():
        raise FileNotFoundError(f"Uploaded video is missing: {video_path}")

    try:
        subprocess.run(
            [
                sys.executable,
                str(project_root / "prepare_colmap_windows.py"),
                str(video_path),
                str(colmap_output_dir),
                "--fps",
                "5",
                "--overwrite",
                "--export-ply",
            ],
            check=True,
        )
        pipeline_result = prepare_fastgs_input_and_train(
            colmap_output_dir=colmap_output_dir,
            fastgs_root=project_root / "fastgs",
            run_training=True,
            training_iterations=TRAINING_ITERATIONS,
        )

        source_ply = find_fastgs_point_cloud(
            Path(pipeline_result.model_path),
            iteration=TRAINING_ITERATIONS,
        )
        splat_path = job_dir / "memory.ply"
        shutil.copy2(source_ply, splat_path)
        video_size = video_path.stat().st_size
        data_volume.commit()

        return {
            "status": "complete",
            "captured_at": captured_at,
            "duration_seconds": float(duration),
            "size_bytes": video_size,
            "dataset_name": upload_id,
            "registered_image_count": pipeline_result.registered_image_count,
            "splat_download_url": "",
            "splat_path": str(splat_path),
        }
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
        if pipeline_result is not None:
            shutil.rmtree(pipeline_result.dataset_path, ignore_errors=True)
            shutil.rmtree(pipeline_result.model_path, ignore_errors=True)


@app.function(
    image=web_image,
    secrets=[api_secret],
    volumes={str(DATA_ROOT): data_volume},
    timeout=15 * 60,
    max_containers=1,
    scaledown_window=30,
)
@modal.asgi_app()
def web():
    from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import FileResponse

    web_app = FastAPI(title="Reminiscence Modal API")
    web_app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "X-API-Key"],
    )

    def require_api_key(x_api_key: str | None) -> None:
        expected = os.environ["REMINISCENCE_API_KEY"]
        if not x_api_key or not hmac.compare_digest(x_api_key, expected):
            raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key")

    async def poll_result(call_id: str) -> dict | None:
        function_call = modal.FunctionCall.from_id(call_id)
        try:
            return await function_call.get.aio(timeout=0)
        except TimeoutError:
            return None
        except modal.exception.OutputExpiredError as exc:
            raise HTTPException(status_code=404, detail="Moment not found or expired") from exc
        except Exception as exc:
            return {"status": "failed", "error": str(exc)}

    @web_app.get("/api/health")
    async def health():
        return {
            "status": "server is running",
            "gpu": "A10",
            "max_gpu_containers": 1,
            "daily_job_limit": DAILY_JOB_LIMIT,
            "monthly_job_limit": MONTHLY_JOB_LIMIT,
            "max_upload_bytes": MAX_UPLOAD_BYTES,
        }

    @web_app.post("/api/v1/moments", status_code=202)
    async def create_moment(
        video: UploadFile = File(...),
        captured_at: str = Form(...),
        duration: str = Form(...),
        x_api_key: str | None = Header(default=None),
    ):
        require_api_key(x_api_key)
        try:
            duration_seconds = float(duration)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Duration must be a number") from exc
        if duration_seconds < 0:
            raise HTTPException(status_code=422, detail="Duration cannot be negative")

        now = datetime.now(UTC)
        daily_usage_key = f"jobs:day:{now.date().isoformat()}"
        monthly_usage_key = f"jobs:month:{now.strftime('%Y-%m')}"
        jobs_today = await usage.get.aio(daily_usage_key, 0)
        jobs_this_month = await usage.get.aio(monthly_usage_key, 0)
        if jobs_today >= DAILY_JOB_LIMIT:
            raise HTTPException(status_code=429, detail="Daily reconstruction limit reached")
        if jobs_this_month >= MONTHLY_JOB_LIMIT:
            raise HTTPException(status_code=429, detail="Monthly reconstruction limit reached")
        await usage.put.aio(daily_usage_key, jobs_today + 1)
        await usage.put.aio(monthly_usage_key, jobs_this_month + 1)

        upload_id = str(uuid.uuid4())
        job_dir = JOB_ROOT / upload_id
        video_path = job_dir / "input.mp4"
        job_dir.mkdir(parents=True, exist_ok=False)
        uploaded_bytes = 0

        try:
            with video_path.open("wb") as destination:
                while chunk := await video.read(1024 * 1024):
                    uploaded_bytes += len(chunk)
                    if uploaded_bytes > MAX_UPLOAD_BYTES:
                        raise HTTPException(
                            status_code=413,
                            detail=f"Video exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit",
                        )
                    destination.write(chunk)

            data_volume.commit()
            call = await reconstruct.spawn.aio(upload_id, captured_at, str(duration_seconds))
            return {"id": call.object_id, "status": "queued"}
        except Exception:
            shutil.rmtree(job_dir, ignore_errors=True)
            data_volume.commit()
            raise

    @web_app.get("/api/v1/moments/{call_id}")
    async def get_moment(call_id: str, x_api_key: str | None = Header(default=None)):
        require_api_key(x_api_key)
        result = await poll_result(call_id)
        if result is None:
            return {"id": call_id, "status": "processing"}
        public_result = _public_result(call_id, result)
        if public_result.get("status") == "complete":
            public_result["splat_download_url"] = f"/api/v1/moments/{call_id}/splat"
        return public_result

    @web_app.get("/api/v1/moments/{call_id}/splat")
    async def download_splat(call_id: str, x_api_key: str | None = Header(default=None)):
        require_api_key(x_api_key)
        result = await poll_result(call_id)
        if result is None:
            raise HTTPException(status_code=409, detail="Moment is processing")
        if result.get("status") != "complete":
            raise HTTPException(status_code=409, detail=f"Moment is {result.get('status')}")

        data_volume.reload()
        splat_path = Path(result["splat_path"])
        if not splat_path.is_file():
            raise HTTPException(status_code=404, detail="Splat file has expired")
        return FileResponse(
            splat_path,
            filename=f"{result['dataset_name']}.ply",
            media_type="application/octet-stream",
        )

    return web_app


@app.function(
    image=web_image,
    volumes={str(DATA_ROOT): data_volume},
    schedule=modal.Cron("17 4 * * *"),
    timeout=10 * 60,
    max_containers=1,
)
def cleanup_expired_jobs() -> int:
    data_volume.reload()
    cutoff = time.time() - RETENTION_DAYS * 24 * 60 * 60
    removed = 0
    monthly_usage_key = f"jobs:month:{datetime.now(UTC).strftime('%Y-%m')}"
    monthly_usage = usage.get(monthly_usage_key)
    if monthly_usage is not None:
        usage.put(monthly_usage_key, monthly_usage)

    if JOB_ROOT.is_dir():
        for job_dir in JOB_ROOT.iterdir():
            if job_dir.is_dir() and job_dir.stat().st_mtime < cutoff:
                shutil.rmtree(job_dir)
                removed += 1

    if removed:
        data_volume.commit()
    return removed
