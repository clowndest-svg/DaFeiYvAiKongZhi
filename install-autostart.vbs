Set fs = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
file = fs.BuildPath(fs.GetParentFolderName(WScript.ScriptFullName), "start-all-hidden.vbs")
sh.RegWrite "HKCU\Software\Microsoft\Windows\CurrentVersion\Run\BiZhiCompanion", "wscript.exe " & Chr(34) & file & Chr(34), "REG_SZ"
MsgBox "Autostart enabled for this project directory.", 64, "BiZhi"
