param([ValidateSet('install','dev','package','test','smoke')][string]$Task = 'dev')
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$cache = Join-Path (Get-Location) '.codex-cache'
foreach ($part in @('tmp','npm','electron','electron-builder','node-gyp')) { New-Item -ItemType Directory -Force (Join-Path $cache $part) | Out-Null }
$env:TEMP = Join-Path $cache 'tmp'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path $cache 'npm'
$env:npm_config_devdir = Join-Path $cache 'node-gyp'
$env:ELECTRON_CACHE = Join-Path $cache 'electron'
$env:electron_config_cache = $env:ELECTRON_CACHE
$env:ELECTRON_BUILDER_CACHE = Join-Path $cache 'electron-builder'
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
switch ($Task) {
  'install' { npm ci --registry=https://registry.npmjs.org }
  'dev' { npm run build:drag; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run dev }
  'package' {
    if (Test-Path 'node_modules\electron\dist') {
      npm run dist:win -- --publish never --config.electronDist=node_modules/electron/dist
    } else {
      npm run dist:win -- --publish never
    }
  }
  'test' { npm test }
  'smoke' { npm run build; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & ./node_modules/.bin/electron.cmd scripts/smoke.cjs }
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
