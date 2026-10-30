@echo off
chcp 65001 >nul
echo 这会停止小知服务，并关闭 NapCat 启动的机器人 QQ。
echo 不会关闭你另外打开的 QQ。继续请按任意键，取消请关窗口。
pause >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-all.ps1"
pause
