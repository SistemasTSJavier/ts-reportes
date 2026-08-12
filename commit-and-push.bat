@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

cd /d "%~dp0"

echo.
echo === ts-reportes: commit y push ===
echo Carpeta: %CD%
echo.

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo ERROR: Esta carpeta no es un repositorio git.
  pause
  exit /b 1
)

echo --- Estado actual ---
git status --short
echo.

git status --porcelain > "%TEMP%\ts-reportes-git-status.txt"
for %%A in ("%TEMP%\ts-reportes-git-status.txt") do set SIZE=%%~zA
if "%SIZE%"=="0" (
  echo No hay cambios para commit.
  pause
  exit /b 0
)

set "MSG=%*"
if "%MSG%"=="" (
  set /p MSG=Mensaje del commit: 
)

if "%MSG%"=="" (
  set "MSG=Actualiza logos PDF, limpieza de usuarios y scripts de BD"
)

echo.
echo --- Agregando cambios ---
git add -A
if errorlevel 1 (
  echo ERROR: falló git add.
  pause
  exit /b 1
)

echo --- Commit ---
git commit -m "%MSG%"
if errorlevel 1 (
  echo ERROR: falló el commit ^(puede que no haya cambios staged o un hook lo rechazó^).
  pause
  exit /b 1
)

for /f "delims=" %%B in ('git branch --show-current') do set "BRANCH=%%B"
if "%BRANCH%"=="" set "BRANCH=main"

echo --- Push a origin/%BRANCH% ---
git push -u origin "%BRANCH%"
if errorlevel 1 (
  echo ERROR: falló el push. Revisa credenciales o permisos de GitHub.
  pause
  exit /b 1
)

echo.
echo Listo: commit y push en origin/%BRANCH%
echo.
git status --short
echo.
pause
endlocal
