param(
    [string]$ApiKey = ""
)

$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot "deploy_modal.ps1") -ApiKey $ApiKey
& (Join-Path $PSScriptRoot "deploy_vercel.ps1")
