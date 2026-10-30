@echo off
chcp 65001 >nul
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v BiZhiCompanion /f
echo 已取消小知开机自启。
pause
