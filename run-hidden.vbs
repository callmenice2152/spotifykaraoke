Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "c:\xampp\htdocs\spotify-auto"
WshShell.Run "npx electron .", 0, False
