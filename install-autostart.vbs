Set fs = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
file = fs.BuildPath(fs.GetParentFolderName(WScript.ScriptFullName), "tools\install-background.ps1")
result = sh.Run("powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -File " & Chr(34) & file & Chr(34), 0, True)
If result = 0 Then
  MsgBox "Hidden background watchdog and logon startup enabled.", 64, "BiZhi"
Else
  MsgBox "Installation failed. Run tools\install-background.ps1 to see the error. No password is needed by this installer.", 48, "BiZhi"
End If
