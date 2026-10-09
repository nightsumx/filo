# Installs or updates Filo on Windows from the latest GitHub release:
#   irm https://filoapp.dev/install.ps1 | iex
#
# Runs the release's installer silently, for this user only (no admin prompt): Filo goes to
# %LOCALAPPDATA%\Programs\Filo with Start menu and desktop shortcuts. The installer is not signed;
# a file fetched here carries no mark of the web, so SmartScreen does not stop it, whereas a
# browser download asks once ("More info", then "Run anyway"). The download is checked against the
# release's SHA-256. The app runs the user's pi when PATH has one and its own built-in pi
# otherwise, so neither Node.js nor the pi CLI is needed.
#
# FILO_URL and FILO_INSTALL_DIR override the download and the target folder (used by tests);
# with FILO_URL the checksum is FILO_URL.sha256 unless FILO_SHA256 gives it.
# Windows PowerShell 5.1 and PowerShell 7 both run it.

$ErrorActionPreference = 'Stop'
# Windows PowerShell's progress bar slows a download down many times over.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Install-Filo {
    $url = $env:FILO_URL
    if (-not $url) {
        $url = 'https://github.com/nightsumx/filo/releases/latest/download/Filo-Setup-x64.exe'
    }
    # x64 build; Windows on ARM runs it emulated.
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw 'Filo needs 64-bit Windows.'
    }

    $dir = $env:FILO_INSTALL_DIR
    if (-not $dir) {
        $dir = Join-Path $env:LOCALAPPDATA 'Programs\Filo'
    }
    $exe = Join-Path $dir 'Filo.exe'

    # The installer replaces files a running app has open.
    $running = Get-Process -Name Filo -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }
    if ($running) {
        throw 'Filo is running. Quit it (File > Quit), then run this again.'
    }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("filo-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $setup = Join-Path $tmp 'Filo-Setup.exe'
        Write-Host 'Downloading Filo...'
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $setup

        # A truncated or tampered download fails here rather than half-installed.
        $expected = $env:FILO_SHA256
        if (-not $expected) {
            $expected = (Invoke-WebRequest -UseBasicParsing -Uri "$url.sha256").Content
            if ($expected -is [byte[]]) {
                $expected = [Text.Encoding]::ASCII.GetString($expected)
            }
        }
        $expected = ($expected.Trim() -split '\s+')[0]
        $actual = (Get-FileHash -Algorithm SHA256 -Path $setup).Hash
        if ($actual -ne $expected) {
            throw 'The download is damaged (checksum mismatch). Try again.'
        }

        Write-Host 'Installing...'
        # /S: silent; /D= must come last and unquoted, as NSIS wants it.
        $installer = Start-Process -FilePath $setup -ArgumentList @('/S', "/D=$dir") -Wait -PassThru
        if ($installer.ExitCode -ne 0) {
            throw "The installer failed (exit code $($installer.ExitCode))."
        }
        if (-not (Test-Path $exe)) {
            throw "The installer finished but $exe is missing."
        }
    }
    finally {
        Remove-Item -Recurse -Force -Path $tmp -ErrorAction SilentlyContinue
    }

    Write-Host "Installed $exe"
    Write-Host "Open it from the Start menu, or run: & `"$exe`""
}

Install-Filo
