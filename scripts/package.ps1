# Builds dist/tall-screenshot-<version>.zip for the Chrome Web Store and Edge Add-ons.
# Only the files the extension needs go in: manifest.json, icons/ and src/.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json).version
$dist = Join-Path $root 'dist'
$zip = Join-Path $dist "tall-screenshot-$version.zip"

New-Item -ItemType Directory -Force $dist | Out-Null
if (Test-Path $zip) { Remove-Item $zip -Force }

# bsdtar (built into Windows 10+) writes forward-slash paths, which the stores require.
Push-Location $root
try {
  tar.exe -a -c -f $zip manifest.json icons src
  if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}
Write-Host "Built $zip ($([math]::Round((Get-Item $zip).Length / 1KB)) KB)"
