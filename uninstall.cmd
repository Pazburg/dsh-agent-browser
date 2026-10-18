@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
if errorlevel 1 (
  echo.
  echo Uninstall failed. See the messages above.
  pause
  exit /b 1
)
echo.
echo Done. Restart the DSH desktop app.
pause
