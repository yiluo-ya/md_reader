@echo off
setlocal EnableDelayedExpansion

set "REGPATH=HKCU\Software\Classes\Directory\Background\Shell\z_md_reader"
set "REGPATH2=HKCU\Software\Classes\DesktopBackground\Shell\MDReader"
set "LNK=%USERPROFILE%\Desktop\MD 阅读器.lnk"

echo Uninstalling MD Reader shortcuts...

reg delete "%REGPATH%" /f >nul 2>&1
if errorlevel 1 (
    echo   [SKIP] folder right-click menu not found
) else (
    echo   [OK] folder right-click menu removed
)

reg delete "%REGPATH2%" /f >nul 2>&1
if errorlevel 1 (
    echo   [SKIP] old desktop right-click menu not found
) else (
    echo   [OK] old desktop right-click menu removed
)

if exist "%LNK%" (
    del /f /q "%LNK%"
    echo   [OK] desktop shortcut removed
) else (
    echo   [SKIP] desktop shortcut not found
)

echo.
echo Done. Program files are NOT deleted.
pause