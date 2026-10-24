param()
$ErrorActionPreference = 'Stop'
$transferRoot = Split-Path -Parent $PSScriptRoot
$transferService = Join-Path $transferRoot 'service'
$transferRuntime = Join-Path $transferRoot 'local-runtime'
$transferLogs = Join-Path $transferRuntime 'logs'
New-Item -ItemType Directory -Force -Path $transferLogs | Out-Null
$transferNode = (Get-Command node -ErrorAction Stop).Source
$transferEnvFile = Join-Path $transferService '.env'
if (!(Test-Path -LiteralPath $transferEnvFile)) {
    Copy-Item -LiteralPath (Join-Path $transferService '.env.example') -Destination $transferEnvFile
    Write-Output 'Created service/.env from the template. Staff use their existing HTN Data Capture group or role and centre assignment.'
}
# Fail before spawning if an existing .env targets anything other than this local gateway.
# The validation prints no credentials.
$transferCheck = "import {readConfig} from './src/config.mjs';const c=readConfig();if(c.base!=='http://127.0.0.1:8081'||c.origin!=='http://127.0.0.1:8080'||c.port!==8094)throw new Error('This launcher requires DHIS2 on 8081, gateway on 8080 and service on 8094 (127.0.0.1).');"
Push-Location $transferService
try {
    & $transferNode --env-file=.env --input-type=module -e $transferCheck
    if ($LASTEXITCODE -ne 0) { throw 'Local transfer settings need correction.' }
} finally { Pop-Location }

function Test-TransferPort([int]$Port) {
    $transferClient = New-Object System.Net.Sockets.TcpClient
    try { $transferClient.Connect('127.0.0.1', $Port); return $true }
    catch { return $false }
    finally { $transferClient.Dispose() }
}
if (!(Test-TransferPort 8081)) { throw 'Start the existing local DHIS2 on 127.0.0.1:8081 first (Docker host port 8081).' }
if (Test-TransferPort 8094) {
    $transferExisting = Invoke-RestMethod -Uri 'http://127.0.0.1:8094/health' -TimeoutSec 3
    if ($transferExisting.service -ne 'tracker-ownership-transfers' -and $transferExisting.service -ne 'patient-transfers') { throw 'Port 8094 belongs to another service.' }
    Write-Output 'Transfer service is already running.'
} else {
    $transferProcess = Start-Process -FilePath $transferNode -ArgumentList '--env-file=.env','src/server.mjs' `
        -WorkingDirectory $transferService -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $transferLogs 'service.out.log') `
        -RedirectStandardError (Join-Path $transferLogs 'service.err.log')
    Write-Output "Started transfer service PID $($transferProcess.Id)."
}
$transferBackendReady = $false
for ($transferAttempt = 0; $transferAttempt -lt 20; $transferAttempt++) {
    try {
        $transferBackendHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8094/health' -TimeoutSec 2
        if ($transferBackendHealth.service -eq 'tracker-ownership-transfers' -or $transferBackendHealth.service -eq 'patient-transfers') { $transferBackendReady = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 300
}
if (!$transferBackendReady) { throw "The transfer backend did not start. Check $transferLogs before restarting." }
if (Test-TransferPort 8080) {
    $transferExistingGateway = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/transfer-api/health' -TimeoutSec 3
    if ($transferExistingGateway.service -ne 'tracker-ownership-transfers' -and $transferExistingGateway.service -ne 'patient-transfers') { throw 'Port 8080 is not the transfer gateway (stop direct DHIS2 on 8080; use Docker host port 8081).' }
    Write-Output 'Transfer gateway is already running.'
} else {
    $transferGatewayProcess = Start-Process -FilePath $transferNode -ArgumentList 'src/gateway.mjs' `
        -WorkingDirectory $transferService -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $transferLogs 'gateway.out.log') `
        -RedirectStandardError (Join-Path $transferLogs 'gateway.err.log')
    Write-Output "Started transfer gateway PID $($transferGatewayProcess.Id)."
}
$transferReady = $false
for ($transferAttempt = 0; $transferAttempt -lt 20; $transferAttempt++) {
    try {
        $transferHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/transfer-api/health' -TimeoutSec 2
        if ($transferHealth.service -eq 'tracker-ownership-transfers' -or $transferHealth.service -eq 'patient-transfers') { $transferReady = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 300
}
if (!$transferReady) { throw "Service startup failed. Check $transferLogs. Do not start duplicate processes." }
Write-Output 'Connection verified. This confirms connectivity, not transfer readiness.'
Write-Output 'Sign in through http://127.0.0.1:8080/ only (DHIS2 + transfers + chatbot API).'
Write-Output 'Open http://127.0.0.1:8080/apps/tracker-ownership-transfers'
Write-Output 'After editing service/.env, restart the service deliberately; rerunning this launcher preserves running processes.'
