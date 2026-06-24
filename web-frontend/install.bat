@echo off
REM Installation script for sensor dashboard on Windows

echo 🚀 Installing Sensor Dashboard...
echo ==================================

REM Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js not found!
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo ✅ Node.js %NODE_VERSION%

for /f "tokens=*" %%i in ('npm --version') do set NPM_VERSION=%%i
echo ✅ npm %NPM_VERSION%

REM Install dependencies
echo.
echo 📦 Installing dependencies...
call npm install

REM Create .env file if it doesn't exist
if not exist .env (
    echo.
    echo ⚙️  Creating .env file...
    copy .env.example .env
    echo ⚠️  Please edit .env with your configuration!
)

echo.
echo ✅ Installation complete!
echo.
echo 🚀 To start the server:
echo    npm start
echo.
echo 📊 Access dashboard at:
echo    http://localhost:8080
echo.
pause
