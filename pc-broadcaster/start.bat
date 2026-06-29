@echo off
title CKast Broadcaster Server
color 0A

echo ===================================================
echo             CKast TV Streaming Server              
echo ===================================================
echo.
echo [*] Checking for existing active TV servers...

:: Silently terminate any background node.exe running "server.js"
wmic process where "name='node.exe' and commandline like '%%server.js%%'" call terminate >nul 2>&1

:: Edge-case: ensure port 8080 is completely released
FOR /F "tokens=5" %%P IN ('netstat -a -n -o ^| findstr :8080') DO (
    echo [*] Port 8080 is still locked by PID %%P. Force terminating...
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
