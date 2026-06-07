param(
    [Parameter(Mandatory = $true)]
    [string]$RunPodApiKey,

    [string]$ImageName = "ghcr.io/andyjyzhang/reminiscence:gpu-latest",
    [string]$GpuType = "NVIDIA GeForce RTX 3090",
    [int]$TrainingIterations = 1000
)

$ErrorActionPreference = "Stop"
$appApiKey = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()

$body = @{
    name = "reminiscence-gpu"
    imageName = $ImageName
    cloudType = "COMMUNITY"
    computeType = "GPU"
    gpuCount = 1
    gpuTypeIds = @($GpuType)
    gpuTypePriority = "availability"
    containerDiskInGb = 50
    volumeInGb = 20
    volumeMountPath = "/workspace"
    ports = @("8000/http")
    supportPublicIp = $true
    interruptible = $false
    env = @{
        REMINISCENCE_API_KEY = $appApiKey
        REMINISCENCE_ASYNC_JOBS = "1"
        REMINISCENCE_UNITY_IMPORT = "0"
        REMINISCENCE_TRAINING_ITERATIONS = "$TrainingIterations"
        REMINISCENCE_CORS_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"
    }
} | ConvertTo-Json -Depth 5

$pod = Invoke-RestMethod `
    -Method Post `
    -Uri "https://rest.runpod.io/v1/pods" `
    -Headers @{ Authorization = "Bearer $RunPodApiKey" } `
    -ContentType "application/json" `
    -Body $body

$apiUrl = "https://$($pod.id)-8000.proxy.runpod.net"
$envPath = Join-Path $PSScriptRoot "..\frontend\.env.local"
"VITE_API_BASE_URL=$apiUrl" | Set-Content -LiteralPath $envPath -Encoding ascii

Write-Host "Pod ID: $($pod.id)"
Write-Host "API URL: $apiUrl"
Write-Host "Reminiscence API key: $appApiKey"
Write-Host "Saved frontend URL to frontend/.env.local"
