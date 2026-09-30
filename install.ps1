$ErrorActionPreference = "Stop"

$Repository = "CYC-M/C-code"
$LocalAppData = $env:LOCALAPPDATA
if ([string]::IsNullOrWhiteSpace($LocalAppData)) {
    $LocalAppData = Join-Path $HOME "AppData\Local"
}
$InstallDirectory = Join-Path $LocalAppData "C-code"
$ApiHeaders = @{
    Accept = "application/vnd.github+json"
    "User-Agent" = "C-code-installer"
}

Write-Host "Finding the latest C-code Windows release..."
$Releases = Invoke-RestMethod -UseBasicParsing -Headers $ApiHeaders -Uri "https://api.github.com/repos/$Repository/releases?per_page=30"
$Release = $Releases |
    Where-Object { $_.tag_name -like "cc-v*" -and -not $_.draft -and -not $_.prerelease } |
    Select-Object -First 1

if ($null -eq $Release) {
    throw "No stable C-code release was found."
}

$Architecture = $env:PROCESSOR_ARCHITEW6432
if ([string]::IsNullOrWhiteSpace($Architecture)) {
    $Architecture = $env:PROCESSOR_ARCHITECTURE
}
if ($Architecture -eq "ARM64") {
    $AssetName = "pi-windows-arm64.zip"
} elseif ($Architecture -eq "AMD64") {
    $AssetName = "pi-windows-x64.zip"
} else {
    throw "Unsupported Windows architecture: $Architecture."
}

$Asset = $Release.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
$ChecksumAsset = $Release.assets | Where-Object { $_.name -eq "SHA256SUMS" } | Select-Object -First 1
if ($null -eq $Asset -or $null -eq $ChecksumAsset) {
    throw "Release $($Release.tag_name) is missing Windows or checksum assets."
}

$TemporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("c-code-" + [guid]::NewGuid().ToString("N"))
$ArchivePath = Join-Path $TemporaryDirectory $AssetName
$ChecksumPath = Join-Path $TemporaryDirectory "SHA256SUMS"
$ExtractedDirectory = Join-Path $TemporaryDirectory "extracted"

try {
    New-Item -ItemType Directory -Path $TemporaryDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $ExtractedDirectory -Force | Out-Null

    Write-Host "Downloading $AssetName ($($Release.tag_name))..."
    Invoke-WebRequest -UseBasicParsing -Uri $Asset.browser_download_url -OutFile $ArchivePath
    Invoke-WebRequest -UseBasicParsing -Uri $ChecksumAsset.browser_download_url -OutFile $ChecksumPath

    $ChecksumLine = Get-Content $ChecksumPath |
        Where-Object { $_ -match "\s$([regex]::Escape($AssetName))$" } |
        Select-Object -First 1
    if ($null -eq $ChecksumLine) {
        throw "No checksum was found for $AssetName."
    }
    $ExpectedHash = $ChecksumLine.Trim().Split()[0].ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($ExpectedHash)) {
        throw "No checksum was found for $AssetName."
    }

    $ActualHash = (Get-FileHash -Algorithm SHA256 -Path $ArchivePath).Hash.ToLowerInvariant()
    if ($ActualHash -ne $ExpectedHash) {
        throw "Checksum verification failed for $AssetName."
    }

    Expand-Archive -Path $ArchivePath -DestinationPath $ExtractedDirectory -Force
    $Executable = Join-Path $ExtractedDirectory "pi.exe"
    if (-not (Test-Path $Executable)) {
        throw "The release archive does not contain pi.exe."
    }

    if (Test-Path $InstallDirectory) {
        Remove-Item $InstallDirectory -Recurse -Force
    }
    New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
    Copy-Item -Path (Join-Path $ExtractedDirectory "*") -Destination $InstallDirectory -Recurse -Force

    foreach ($CommandName in @("cc", "c-code", "ccode")) {
        $WrapperPath = Join-Path $InstallDirectory "$CommandName.cmd"
        Set-Content -Path $WrapperPath -Encoding ASCII -Value "@echo off`r`n`"%~dp0pi.exe`" %*"
    }

    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $PathEntries = @($UserPath -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if (-not ($PathEntries | Where-Object { $_.TrimEnd("\") -ieq $InstallDirectory.TrimEnd("\") })) {
        [Environment]::SetEnvironmentVariable("Path", (($PathEntries + $InstallDirectory) -join ";"), "User")
    }

    Write-Host "C-code $($Release.tag_name) installed to $InstallDirectory"
    Write-Host "Open a new PowerShell or Command Prompt window, then run: cc, c-code, or ccode"
} finally {
    if (Test-Path $TemporaryDirectory) {
        Remove-Item $TemporaryDirectory -Recurse -Force
    }
}
