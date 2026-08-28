@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installazione iniziale delle dipendenze...
  call npm install
  if errorlevel 1 goto :error
)
node --env-file=.env index.mjs
if errorlevel 1 goto :error
exit /b 0

:error
echo.
echo L'agente di stampa si e' arrestato. Leggi l'errore sopra.
pause
exit /b 1
