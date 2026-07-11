@echo off
title CKast Broadcaster Server
color 0A
cd /d "%~dp0"

echo ===================================================
echo             CKast TV Streaming Server              
echo ===================================================
echo.
echo [*] Checking the local listener on port 8080...

:: Stop only the process proven to own the local listening socket.
FOR /F "usebackq delims=" %%P IN (`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue ^| Select-Object -ExpandProperty OwningProcess -Unique"`) DO (
    echo [*] Port 8080 is owned by PID %%P. Terminating that listener...
    taskkill /PID %%P /F >nul 2>&1
)

:: Small delay to ensure the OS network layer fully releases the port bind
timeout /t 1 /nobreak >nul

echo [*] Environment clear. Starting CKast Server...
echo.
node server.js

echo.
echo [!] Server crashed or was closed.
pause
