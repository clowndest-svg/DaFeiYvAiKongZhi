Option Explicit
On Error Resume Next
Dim fs, sh, root, nodeFile, nodePath, stream, command, result, attempt
Set fs = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
If Err.Number <> 0 Then WScript.Quit 1
root = fs.GetParentFolderName(WScript.ScriptFullName)
If fs.FileExists(fs.BuildPath(root, "data\background.disabled")) Then WScript.Quit 0
nodeFile = fs.BuildPath(root, "data\background-node.txt")
If Not fs.FileExists(nodeFile) Then WScript.Quit 1
Set stream = fs.OpenTextFile(nodeFile, 1)
nodePath = Trim(stream.ReadAll)
stream.Close
If Not fs.FileExists(nodePath) Then WScript.Quit 1
sh.CurrentDirectory = root
If Not fs.FolderExists(fs.BuildPath(root, "data\runtime")) Then fs.CreateFolder fs.BuildPath(root, "data\runtime")
sh.Environment("Process")("TEMP") = fs.BuildPath(root, "data\runtime\bootstrap-tmp")
sh.Environment("Process")("TMP") = fs.BuildPath(root, "data\runtime\bootstrap-tmp")
sh.Environment("Process")("BIZHI_WATCHDOG_MANAGED") = "1"
If Not fs.FolderExists(sh.Environment("Process")("TEMP")) Then fs.CreateFolder sh.Environment("Process")("TEMP")
If Err.Number <> 0 Then WScript.Quit 1
command = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & fs.BuildPath(root, "tools\background.mjs") & Chr(34)
' Keep the task alive and retry the supervisor itself; Windows task failure
' retries are a second fallback, not the only recovery mechanism.
For attempt = 0 To 3
  result = sh.Run(command, 0, True)
  If Err.Number <> 0 Then
    result = 1
    Err.Clear
  End If
  If result = 0 Or fs.FileExists(fs.BuildPath(root, "data\background.disabled")) Then WScript.Quit 0
  If attempt < 3 Then WScript.Sleep 5000 * (3 ^ attempt)
Next
WScript.Quit 1
