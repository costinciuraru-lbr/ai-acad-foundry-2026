<#
  Hybrid dev lane: API runs on the host (inherits your `az login`), Qdrant and
  the console run in Docker. See code/backend/docker-compose.host-api.yml for
  why - a containerized API can't see your Azure CLI login and falls back to
  key auth, which breaks the Agent Service / control plane.

  Run from anywhere:  .\scripts\start-dev.ps1
#>

$ErrorActionPreference = 'Stop'

$backend = (Resolve-Path (Join-Path $PSScriptRoot '..\code\backend')).Path
Push-Location $backend

try {
    $branch = git branch --show-current
    Write-Host "Branch: $branch" -ForegroundColor Cyan
    if ($branch -ne 'my-work') {
        Write-Warning "Not on 'my-work' (currently on '$branch') - continuing anyway."
    }

    Write-Host "`nStopping any containers left over from a previous run..." -ForegroundColor Cyan
    docker compose down

    Write-Host "`nChecking Azure CLI login..." -ForegroundColor Cyan
    az account show *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Not logged in - opening az login..." -ForegroundColor Yellow
        az login | Out-Null
    } else {
        Write-Host "Already authenticated." -ForegroundColor Green
    }

    Write-Host "`nStarting the API on the host (new window)..." -ForegroundColor Cyan
    Start-Process powershell -ArgumentList @(
        '-NoExit', '-Command',
        "Set-Location '$backend'; uv run uvicorn app.main:app --reload --port 7799"
    )

    Write-Host "`nStarting Qdrant + console in Docker (host-api lane)..." -ForegroundColor Cyan
    docker compose -f docker-compose.yml -f docker-compose.host-api.yml up -d

    Write-Host "`nWaiting for the API to come up..." -ForegroundColor Cyan
    $ok = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            Invoke-WebRequest -Uri 'http://localhost:7799/health' -UseBasicParsing -TimeoutSec 2 | Out-Null
            $ok = $true
            break
        } catch { Start-Sleep -Seconds 1 }
    }

    if ($ok) {
        Write-Host "`nUp and running:" -ForegroundColor Green
        Write-Host "  API      http://localhost:7799/docs"
        Write-Host "  Console  http://localhost:7800"
        Write-Host "  Qdrant   http://localhost:7833/dashboard"
        Write-Host "`n(Close the new PowerShell window to stop the API. Run 'docker compose down' in code\backend to stop the rest.)"
    } else {
        Write-Warning "API did not respond within 30s - check the new PowerShell window for errors."
    }
} finally {
    Pop-Location
}
