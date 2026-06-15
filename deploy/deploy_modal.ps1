param(
    [string]$ApiKey = "",
    [switch]$SkipSecret
)

$ErrorActionPreference = "Stop"
$env:PYTHONUTF8 = "1"
$repoRoot = Split-Path -Parent $PSScriptRoot
$statePath = Join-Path $PSScriptRoot ".modal-state.json"

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw "Python is not installed or is not on PATH."
}
try {
    & python -c "import modal" 2>$null
}
catch {
    throw "Modal CLI is not installed. Run: python -m pip install -r deploy\requirements.txt"
}
if ($LASTEXITCODE -ne 0) {
    throw "Modal CLI is not installed. Run: python -m pip install -r deploy\requirements.txt"
}

if (-not $ApiKey -and $SkipSecret) {
    if (-not (Test-Path -LiteralPath $statePath)) {
        throw "Cannot preserve the Modal secret because deploy/.modal-state.json is missing."
    }
    $ApiKey = (Get-Content -LiteralPath $statePath | ConvertFrom-Json).api_key
}
if (-not $ApiKey) {
    $bytes = New-Object byte[] 24
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $random.GetBytes($bytes)
    }
    finally {
        $random.Dispose()
    }
    $ApiKey = ([BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
}

Push-Location $repoRoot
try {
    if (-not $SkipSecret) {
        & python -m modal secret create reminiscence-secrets "REMINISCENCE_API_KEY=$ApiKey" --force
        if ($LASTEXITCODE -ne 0) {
            throw "Could not create the Modal API-key secret."
        }
    }

    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $deployOutput = & python -m modal deploy modal_app.py 2>&1
    $deployExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorAction
    $deployOutput | Write-Host
    if ($deployExitCode -ne 0) {
        throw "Modal deployment failed."
    }

    $endpointMatches = [regex]::Matches(
        ($deployOutput -join "`n"),
        "https://[a-zA-Z0-9-]+\.modal\.run"
    )
    if ($endpointMatches.Count -eq 0) {
        throw "Modal deployed, but its web endpoint could not be read from the CLI output."
    }

    $endpoint = $endpointMatches[$endpointMatches.Count - 1].Value
    @{
        api_url = $endpoint
        api_key = $ApiKey
        deployed_at = (Get-Date).ToUniversalTime().ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath $statePath

    @"

Modal is deployed.
API URL: $endpoint
API key: $ApiKey

The API key is saved locally in deploy/.modal-state.json.
"@ | Write-Host
}
finally {
    Pop-Location
}
