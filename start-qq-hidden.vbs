Set fs = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fs.GetParentFolderName(WScript.ScriptFullName)
sh.Run Chr(34) & fs.BuildPath(root, "start-qq-bg.bat") & Chr(34), 0, False
