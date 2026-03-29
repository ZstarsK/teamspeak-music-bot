@echo off
title TSMusicBot Setup
echo ============================================
echo   TSMusicBot - First-Time Setup (Windows)
echo ============================================
echo.

:: Resolve project root (one level up from scripts/)
cd /d "%~dp0.."

:: ---- Step 1: Check / install Node.js ----
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo Node.js not found. Attempting automatic installation...
    echo.

    :: Try winget first (available on Windows 10 1709+ and Windows 11)
    where winget >nul 2>&1
    if %errorlevel% equ 0 (
        echo Installing Node.js via winget...
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        if %errorlevel% neq 0 (
            echo winget installation failed. Please install Node.js manually from https://nodejs.org
            pause
            exit /b 1
        )
        :: Refresh PATH so node is available in this session
        call refreshenv >nul 2>&1
        :: If refreshenv is not available, ask user to restart
        where node >nul 2>&1
        if %errorlevel% neq 0 (
            echo.
            echo Node.js was installed but is not yet available in this terminal.
            echo Please close this window and run setup.bat again.
            pause
            exit /b 0
        )
    ) else (
        echo winget is not available on this system.
        echo Please install Node.js 20 LTS manually from https://nodejs.org
        echo After installing, close this window and run setup.bat again.
        pause
        exit /b 1
    )
) else (
    echo [OK] Node.js found.
    node --version
)
echo.

:: ---- Step 2: Install npm dependencies ----
echo Installing dependencies (this may take a few minutes)...
call npm install
if %errorlevel% neq 0 (
    echo.
    echo npm install failed. Check the error messages above.
    pause
    exit /b 1
)
echo [OK] Dependencies installed.
echo.

:: ---- Step 3: Build the project ----
echo Building TypeScript project...
call npx tsc
if %errorlevel% neq 0 (
    echo.
    echo Build failed. Check the error messages above.
    pause
    exit /b 1
)
echo [OK] Build succeeded.
echo.

:: ---- Step 4: Create default config if missing ----
if not exist "config.json" (
    echo Creating default config.json...
    echo Please edit config.json with your TeamSpeak server details before starting the bot.
) else (
    echo [OK] config.json already exists.
)
echo.

:: ---- Done ----
echo ============================================
echo   Setup complete!
echo ============================================
echo.
echo To start the bot, run:  scripts\start.bat
echo.
pause
