@echo off
chcp 65001 >nul
cd /d "%~dp0"
wscript "%~dp0start-qq-hidden.vbs"
echo QQ login status is in the console settings page.
timeout /t 3 >nul
