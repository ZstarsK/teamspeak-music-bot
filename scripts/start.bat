@echo off
title TSMusicBot
echo Starting TSMusicBot...
echo.

:: Check if node is available
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo Node.js is not installed.
    echo Run scripts\setup.bat for automatic installation, or install Node.js 20+ from https://nodejs.org
    pause
    exit /b 1
)

:: Resolve project root (one level up from scripts/)
cd /d "%~dp0.."

:: Install dependencies if needed
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install --production
    if %errorlevel% neq 0 (
        echo Failed to install dependencies.
        pause
        exit /b 1
    )
)

:: Build if dist/ doesn't exist
if not exist "dist" (
    echo Building project...
    call npx tsc
    if %errorlevel% neq 0 (
        echo Build failed.
        pause
        exit /b 1
    )
)

:: FFmpeg is bundled via ffmpeg-static — no PATH check needed.
echo FFmpeg is bundled via node_modules (ffmpeg-static).
echo.

:: Start the application
node dist/index.js

pause
