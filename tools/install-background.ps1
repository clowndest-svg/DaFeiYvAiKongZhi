param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskName = 'BiZhiBackground'
$taskStop = Join-Path $taskRoot 'data\background.disabled'
if ($Remove) {
    New-Item -ItemType File -Force -Path $taskStop | Out-Null
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output 'Background disabled; running QQ and business app were left untouched.'
    exit
}
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
if (!(Test-Path -LiteralPath (Join-Path $taskRoot 'node_modules\ws'))) { throw 'Run npm ci first.' }
# Save only the public executable path; no passwords or login state in task XML.
New-Item -ItemType Directory -Force -Path (Join-Path $taskRoot 'data') | Out-Null
[IO.File]::WriteAllText((Join-Path $taskRoot 'data\background-node.txt'), $taskNode)
if (Test-Path -LiteralPath $taskStop) { Remove-Item -LiteralPath $taskStop }
$taskAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument ('"' + (Join-Path $taskRoot 'start-background-hidden.vbs') + '"') -WorkingDirectory $taskRoot
$taskUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
$taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $taskUser
$taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Force | Out-Null
# Remove the old project-specific duplicate autostart only after replacement succeeds.
Remove-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name BiZhiCompanion -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $taskName
Write-Output 'Hidden background watchdog installed for this Windows user. Automatic QQ injection remains off.'
