Set fs = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fs.GetParentFolderName(WScript.ScriptFullName)
sh.Run Chr(34) & fs.BuildPath(root, "start-bizhi-bg.bat") & Chr(34), 0, False
WScript.Sleep 1500
sh.Run Chr(34) & fs.BuildPath(root, "start-qq-bg.bat") & Chr(34), 0, False
