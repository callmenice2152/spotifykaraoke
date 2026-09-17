Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "c:\xampp\htdocs\spotify-auto"
WshShell.Run "cmd.exe /c npx electron .", 0, False

' 999
