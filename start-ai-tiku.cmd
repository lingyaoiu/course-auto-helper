@echo off
chcp 65001 >nul
title AI Tiku Service - 127.0.0.1:8765
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH.
  echo Install Node.js 18+ first: https://nodejs.org/
  pause
  exit /b 1
)

if not exist "ai-tiku.config.json" (
  if exist "ai-tiku.config.example.json" (
    copy "ai-tiku.config.example.json" "ai-tiku.config.json" >nul
    echo [INFO] Created ai-tiku.config.json - please put your API key in it.
  )
)

echo Starting AI tiku service on http://127.0.0.1:8765 ...
node ai-tiku-server.js
echo.
echo Service exited. Press any key to close.
pause >nul
