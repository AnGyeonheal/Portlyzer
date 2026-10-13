@echo off
setlocal
cd /d "%~dp0"
set "PORTLYZER_NODE=node"
for /d %%D in ("%~dp0.local-tools\node-v24*-win-x64") do if exist "%%~fD\node.exe" set "PORTLYZER_NODE=%%~fD\node.exe"
"%PORTLYZER_NODE%" --import=tsx "%~dp0scripts\local.ts" %*
exit /b %errorlevel%
