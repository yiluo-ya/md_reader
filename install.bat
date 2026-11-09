@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "APPNAME=启动 MD 阅读器"
set "REGPATH=HKCU\Software\Classes\Directory\Background\Shell\z_md_reader"
set "BAT=%~dp0start.bat"
set "ICONO=%~dp0md_reader.exe,0"

echo ===============================================
echo   Install MD Reader shortcuts
echo   Dir: %~dp0
echo ===============================================
echo.

echo [1/2] Registering folder right-click menu (next to Baichuan) ...
reg add "%REGPATH%" /ve /d "%APPNAME%" /f >nul
reg add "%REGPATH%" /v "Icon" /d "%ICONO%" /f >nul
reg add "%REGPATH%\command" /ve /d "\"%BAT%\"" /f >nul
if errorlevel 1 (
    echo   [FAIL] registry write failed
) else (
    echo   [OK] right-click in folder background, right next to Baichuan entry
)

echo.
echo [2/2] Creating desktop shortcut ...
set "LNK=%USERPROFILE%\Desktop\MD 阅读器.lnk"
powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LNK%');" ^
  "$s.TargetPath='%BAT%';" ^
  "$s.WorkingDirectory='%~dp0';" ^
  "$s.IconLocation='%ICONO%';" ^
  "$s.Description='MD Reader';" ^
  "$s.WindowStyle=7;" ^
  "$s.Save()" 2>nul
if exist "%LNK%" (
    echo   [OK] %LNK%
) else (
    echo   [SKIP] shortcut creation failed (right-click menu still works)
)

echo.
echo Refreshing Explorer ...
powershell -NoProfile -Command "Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 800; Start-Process explorer.exe" >nul 2>&1

echo Done. To uninstall: run uninstall.bat
if "%~1"=="/nopause" exit /b 0
pause