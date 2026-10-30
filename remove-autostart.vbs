Set sh = CreateObject("WScript.Shell")
On Error Resume Next
sh.RegDelete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run\BiZhiCompanion"
MsgBox "已取消小知开机自启。", 64, "小知"
