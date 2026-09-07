Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\ciank\finance-tracker"
WshShell.Run "cmd /c ""C:\Program Files\nodejs\node.exe"" server.js >> ""C:\Users\ciank\finance-tracker\server.log"" 2>&1", 0, False
