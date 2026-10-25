@echo off
rem Task Flow (portable): starts the packaged app in the "app" folder next to this file.
rem No Node.js, npm or installation is needed. Task data and AI settings are kept in
rem %APPDATA%\Taskflow; API keys are stored encrypted by Windows for the current user.
rem Extra arguments are passed to the app.
setlocal
set "APP_EXE=%~dp0app\Taskflow.exe"
if not exist "%APP_EXE%" (
  echo Task Flow could not find app\Taskflow.exe next to this file.
  echo Extract the whole ZIP archive to a folder first, then run "Task Flow.bat" from there.
  echo.
  echo Task Flow ne nashel app\Taskflow.exe ryadom s etim faylom.
  echo Snachala raspakuyte ves ZIP-arkhiv v papku, zatem zapustite "Task Flow.bat" ottuda.
  pause
  exit /b 1
)
start "" "%APP_EXE%" %*
