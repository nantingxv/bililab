# Launched by "打开看板.bat": make sure the service is up, then open the browser.
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI.
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$url  = 'http://127.0.0.1:8765'

function Test-Up {
    try {
        $r = Invoke-WebRequest "$url/api/state" -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

if (-not (Test-Up)) {
    Write-Host 'Service is down, starting it in background...'
    $py = if ($env:BILILAB_PYTHON) { $env:BILILAB_PYTHON } else { 'python' }
    Start-Process -FilePath $py -ArgumentList "`"$root\server.py`"" -WorkingDirectory $root -WindowStyle Minimized
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Up) { break }
    }
    if (-not (Test-Up)) {
        Write-Host 'Startup timed out. Run server.py manually to see the error.'
        Read-Host 'Press Enter to exit'
        exit 1
    }
}

Start-Process $url
