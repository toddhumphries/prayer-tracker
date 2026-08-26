@echo off
REM Double-click this to start the server and open the app.
REM Closing the window stops the server.

cd /d "%~dp0"

REM If it's already running, just open the browser and stop.
powershell -NoProfile -Command ^
  "try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 2 -UseBasicParsing; exit 0 } catch { exit 1 }"
if %errorlevel%==0 (
  echo Server is already running.
  start "" "http://localhost:8787"
  exit /b 0
)

echo Starting prayer tracker...
start "" "http://localhost:8787"
node --no-warnings server.mjs

REM If node exits immediately, keep the window open so the error is readable.
if %errorlevel% neq 0 (
  echo.
  echo Server stopped with an error. Press any key to close.
  pause >nul
)
