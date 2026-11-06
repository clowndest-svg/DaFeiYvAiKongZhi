Set sh = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
file = fs.BuildPath(fs.GetParentFolderName(WScript.ScriptFullName), "tools\install-background.ps1")
result = sh.Run("powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -File " & Chr(34) & file & Chr(34) & " -Remove", 0, True)
If result <> 0 Then
  MsgBox "Could not disable the background task. Run tools\install-background.ps1 -Remove to inspect the error.", 48, "BiZhi"
  WScript.Quit 1
End If
On Error Resume Next
sh.RegDelete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run\BiZhiCompanion"
MsgBox "已取消小知开机自启。", 64, "小知"
