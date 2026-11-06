Option Explicit
Dim fs, sh, root, nodeFile, nodePath, stream, command, result
Set fs = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fs.GetParentFolderName(WScript.ScriptFullName)
nodeFile = fs.BuildPath(root, "data\background-node.txt")
If Not fs.FileExists(nodeFile) Then WScript.Quit 1
Set stream = fs.OpenTextFile(nodeFile, 1)
nodePath = Trim(stream.ReadAll)
stream.Close
If Not fs.FileExists(nodePath) Then WScript.Quit 1
sh.CurrentDirectory = root
command = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & fs.BuildPath(root, "tools\background.mjs") & Chr(34)
' Wait keeps the scheduled task alive so IgnoreNew and crash restart take effect.
result = sh.Run(command, 0, True)
WScript.Quit result
