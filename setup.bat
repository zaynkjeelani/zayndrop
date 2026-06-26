@echo off
echo.
echo  =====================================
echo   ZaynDrop Setup
echo  =====================================
echo.

:: Check Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
  echo  ERROR: Node.js is not installed.
  echo  Please download it from https://nodejs.org and run this setup again.
  echo.
  pause
  exit /b 1
)

echo  Node.js found. Installing dependencies...
echo.
call npm install

if %errorlevel% neq 0 (
  echo.
  echo  ERROR: npm install failed. Check your internet connection and try again.
  pause
  exit /b 1
)

echo.
echo  =====================================
echo   Setup complete! Launching ZaynDrop...
echo  =====================================
echo.
call npm start
