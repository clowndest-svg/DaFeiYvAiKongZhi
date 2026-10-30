$root = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $root 'tools/process.mjs') stop
exit $LASTEXITCODE
