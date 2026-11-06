param([switch]$Remove, [switch]$UpdateOnly)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskName = 'BiZhiBackground'
$taskStop = Join-Path $taskRoot 'data\background.disabled'
$taskLifecycle = Join-Path $taskRoot 'data\background-lifecycle.json'
if ($Remove) {
    New-Item -ItemType File -Force -Path $taskStop | Out-Null
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $taskLifecycle) { Remove-Item -LiteralPath $taskLifecycle }
    Write-Output 'Background disabled; running QQ and business app were left untouched.'
    exit
}
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
if (!(Test-Path -LiteralPath (Join-Path $taskRoot 'node_modules\ws'))) { throw 'Run npm ci first.' }
# Save only the public executable path; no passwords or login state in task XML.
New-Item -ItemType Directory -Force -Path (Join-Path $taskRoot 'data') | Out-Null
[IO.File]::WriteAllText((Join-Path $taskRoot 'data\background-node.txt'), $taskNode)
if (!$UpdateOnly -and (Test-Path -LiteralPath $taskStop)) { Remove-Item -LiteralPath $taskStop }
$taskAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument ('"' + (Join-Path $taskRoot 'start-background-hidden.vbs') + '"') -WorkingDirectory $taskRoot
$taskUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
$taskLogon = New-ScheduledTaskTrigger -AtLogOn -User $taskUser
$taskLogon.Delay = 'PT10S'
$taskUnlock = New-CimInstance -Namespace 'Root/Microsoft/Windows/TaskScheduler' -ClassName 'MSFT_TaskSessionStateChangeTrigger' -ClientOnly -Property @{ StateChange=[uint32]8; UserId=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; Enabled=$true; Delay='PT10S' }
$taskResumeQuery = "<QueryList><Query Id='0' Path='System'><Select Path='System'>*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1]]</Select></Query></QueryList>"
$taskResume = New-CimInstance -Namespace 'Root/Microsoft/Windows/TaskScheduler' -ClassName 'MSFT_TaskEventTrigger' -ClientOnly -Property @{ Subscription=$taskResumeQuery; Enabled=$true; Delay='PT15S' }
# Client-only CIM instances do not include inherited type names. The ScheduledTasks
# cmdlet validates the base trigger type before submitting the concrete class.
foreach ($taskCustomTrigger in @($taskUnlock,$taskResume)) {
    $taskCustomTrigger.PSTypeNames.Add('Microsoft.Management.Infrastructure.CimInstance#MSFT_TaskTrigger')
}
$taskPeriodic = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5)
$taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd
$taskSettings.WakeToRun = $false
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger @($taskLogon,$taskUnlock,$taskResume,$taskPeriodic) -Principal $taskPrincipal -Settings $taskSettings -Force | Out-Null
$taskMetadata = @{ installed=$true; logon=$true; unlock=$true; resume=$true; periodicMinutes=5; installedAt=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
[IO.File]::WriteAllText($taskLifecycle + '.tmp', $taskMetadata)
Move-Item -LiteralPath ($taskLifecycle + '.tmp') -Destination $taskLifecycle -Force
# Remove the old project-specific duplicate autostart only after replacement succeeds.
Remove-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name BiZhiCompanion -ErrorAction SilentlyContinue
if (!$UpdateOnly) { Start-ScheduledTask -TaskName $taskName }
Write-Output 'Hidden background task configured for logon, unlock, resume and five-minute recovery. Automatic QQ injection remains off.'
