@echo off
rem Starts the CURRENT development version of Taskflow from the folder this file is in
rem (Vite dev server + Electron, "npm run dev"), with a separate test data folder, so the real data
rem in %APPDATA%\Taskflow is never opened or upgraded.
rem
rem Note: a copy of this file inside another project folder (for example the "Task Flow 0.2.0"
rem snapshot) starts THAT folder's code. The banner below always shows the folder and version.
rem Close the Taskflow window (or press Ctrl+C here) to stop.

setlocal EnableExtensions
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%" || (echo Cannot open the project folder "%ROOT%". & pause & exit /b 1)

rem --- Required project files -------------------------------------------------
for %%F in (package.json package-lock.json scripts\dev.mjs electron\main.cjs electron\preload.cjs src\main.jsx index.html) do (
  if not exist "%%F" (
    echo ERROR: "%ROOT%\%%F" is missing. This folder is not a complete Taskflow project.
    pause
    exit /b 1
  )
)

rem --- Node.js and npm --------------------------------------------------------
where node >nul 2>nul || (echo ERROR: Node.js was not found. Install Node.js 22 or newer from https://nodejs.org. & pause & exit /b 1)
where npm >nul 2>nul || (echo ERROR: npm was not found. Reinstall Node.js from https://nodejs.org. & pause & exit /b 1)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" || (
  echo ERROR: Node.js 22 or newer is required. Installed:
  node -v
  pause
  exit /b 1
)

for /f "usebackq delims=" %%V in (`node -p "require('./package.json').version"`) do set "VERSION=%%V"
title Taskflow %VERSION% (dev) - %ROOT%

rem --- Dependencies: install when missing or older than package-lock.json ------
set "NEED_INSTALL="
for %%M in (electron vite react @anthropic-ai\sdk) do if not exist "node_modules\%%M\package.json" set "NEED_INSTALL=1"
if not defined NEED_INSTALL (
  node -e "const fs=require('fs');let m=0;try{m=fs.statSync('node_modules/.package-lock.json').mtimeMs}catch{}process.exit(m>=fs.statSync('package-lock.json').mtimeMs?0:1)" || set "NEED_INSTALL=1"
)
if defined NEED_INSTALL (
  echo Installing or updating dependencies...
  call npm install
  if errorlevel 1 (echo ERROR: npm install failed. & pause & exit /b 1)
)

rem --- Separate test data folder ----------------------------------------------
rem Earlier versions of this file used "Taskflow 0.2.0 Preview" (also used by the 0.2.0 snapshot's
rem copy of this file). Its Taskflow files are copied once into the new folder, so test tasks and a
rem connected AI key carry over ("Local State" holds the key that decrypts it); caches are not
rem copied, and the old folder itself is left unchanged.
set "TEST_DATA=%LOCALAPPDATA%\Taskflow Dev"
set "OLD_TEST_DATA=%LOCALAPPDATA%\Taskflow 0.2.0 Preview"
if not exist "%TEST_DATA%" if exist "%OLD_TEST_DATA%" (
  echo Copying the earlier test data from "%OLD_TEST_DATA%"...
  robocopy "%OLD_TEST_DATA%" "%TEST_DATA%" "Local State" "taskflow-*" /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul
  if errorlevel 8 (echo ERROR: the test data could not be copied. & pause & exit /b 1)
)

echo.
echo ============================================================
echo  Taskflow %VERSION% - development version
echo  Project:   %ROOT%
echo  Test data: %TEST_DATA%
echo ============================================================
echo.
call npm run dev -- "--user-data-dir=%TEST_DATA%"
if errorlevel 1 (echo Taskflow exited with an error. & pause)
endlocal
