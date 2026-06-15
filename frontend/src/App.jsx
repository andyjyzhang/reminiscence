import React, { useEffect, useState } from "react";

const terminalStatuses = new Set(["complete", "failed"]);
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

function apiUrl(path) {
  return `${apiBaseUrl}${path}`;
}

export default function App() {
  const [file, setFile] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!job?.id || terminalStatuses.has(job.status)) return undefined;

    const timer = setInterval(async () => {
      try {
        const response = await fetch(apiUrl(`/api/v1/moments/${job.id}`));
        const body = await response.json();
        if (!response.ok) throw new Error(body.detail || "Could not read job status");
        setJob(body);
      } catch (pollError) {
        setError(pollError.message);
      }
    }, 3000);

    return () => clearInterval(timer);
  }, [job?.id, job?.status]);

  async function upload(event) {
    event.preventDefault();
    if (!file) return;

    setError("");
    setJob(null);
    setUploading(true);

    const form = new FormData();
    form.append("video", file);
    form.append("captured_at", new Date().toISOString());
    form.append("duration", "0");

    try {
      const response = await fetch(apiUrl("/api/v1/moments"), {
        method: "POST",
        body: form,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail || "Upload failed");
      setJob(body);
    } catch (uploadError) {
      setError(uploadError.message);
    } finally {
      setUploading(false);
    }
  }

  async function download() {
    setError("");
    try {
      const response = await fetch(apiUrl(`/api/v1/moments/${job.id}/splat`));
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.detail || "Download failed");
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${job.dataset_name}.ply`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      setError(downloadError.message);
    }
  }

  return (
    <main>
      <section className="hero">
        <p className="eyebrow">REMINISCENCE</p>
        <h1>Turn a video into a place you can revisit.</h1>
        <p className="lede">
          Upload a slow walk around a memory. We will reconstruct it into a
          Gaussian splat ready for Unity.
        </p>
      </section>

      <section className="panel">
        <form onSubmit={upload}>
          <label className="file-picker">
            <span>{file ? file.name : "Choose a video"}</span>
            <input
              type="file"
              accept="video/*"
              onChange={(event) => setFile(event.target.files[0])}
            />
          </label>
          <button disabled={!file || uploading} type="submit">
            {uploading ? "Uploading..." : "Create memory"}
          </button>
        </form>

        {job && (
          <div className="job">
            <div>
              <p className="eyebrow">RECONSTRUCTION</p>
              <h2>{job.status}</h2>
            </div>
            <span className={`status ${job.status}`} />
            {job.registered_image_count != null && (
              <p>{job.registered_image_count} camera views registered</p>
            )}
            {job.error && <p className="error">{job.error}</p>}
            {job.status === "complete" && (
              <button type="button" onClick={download}>Download .ply</button>
            )}
          </div>
        )}

        {error && <p className="error">{error}</p>}
      </section>
    </main>
  );
}
