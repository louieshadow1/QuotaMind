Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
ps = dir & "\launch.ps1"
cmd = "powershell -STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps & """"
sh.Run cmd, 0, False
