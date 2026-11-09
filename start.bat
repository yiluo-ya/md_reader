@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "PORT=5656"
if not "%MD_READER_PORT%"=="" set "PORT=%MD_READER_PORT%"
set "URL=http://127.0.0.1:%PORT%/"

REM ---------- build if exe missing ----------
if not exist md_reader.exe (
    echo [build] building md_reader.exe ...
    if exist "%GOROOT%\bin\go.exe" (
        "%GOROOT%\bin\go.exe" build -o md_reader.exe .
    ) else (
        where go >nul 2>nul
        if errorlevel 1 (
            echo.
            echo [error] Go not found and md_reader.exe missing.
            pause
            exit /b 1
        )
        go build -o md_reader.exe .
    )
    if not exist md_reader.exe (
        echo [error] build failed
        pause
        exit /b 1
    )
)

REM ---------- already running? just open browser ----------
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if !errorlevel!==0 (
    echo [already-running] service is up, opening browser: %URL%
    start "" "%URL%"
    exit /b 0
)

REM ---------- start service minimized ----------
echo [starting] launching service %URL% ...
set "MD_READER_NO_BROWSER=1"
start "MD-Reader" /min "%~dp0md_reader.exe"

REM ---------- wait until ready (max 30s) ----------
echo [waiting] waiting for service ready ...
set /a TRIES=0
:waitloop
timeout /t 1 /nobreak >nul
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if !errorlevel!==0 goto ready
set /a TRIES+=1
if !TRIES! geq 30 (
    echo [timeout] service not ready in 30s. run md_reader.exe manually to see errors.
    pause
    exit /b 1
)
goto waitloop

:ready
echo [ready] opening browser: %URL%
start "" "%URL%"
exit /b 0
