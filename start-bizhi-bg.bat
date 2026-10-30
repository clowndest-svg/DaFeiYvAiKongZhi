@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "OPEN_BROWSER=0"
if not exist "data\logs" mkdir "data\logs"
if not exist "node_modules\ws" call npm ci
if errorlevel 1 exit /b 1
node --disable-warning=ExperimentalWarning "%~dp0src\index.js" > "data\logs\server.out" 2>&1
