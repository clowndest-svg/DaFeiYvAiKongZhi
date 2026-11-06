$root = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType File -Force -Path (Join-Path $root 'data\background.disabled') | Out-Null
& node (Join-Path $root 'tools/process.mjs') stop
exit $LASTEXITCODE
