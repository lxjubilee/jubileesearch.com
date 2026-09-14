@echo off
rem Jubilee Inference API on the RTX PRO 6000 workstation. Registered as a
rem per-user logon task (see ops/README.md); the loop restarts the service if
rem it exits, since a scheduled task does not.
cd /d "%~dp0.."
:loop
node --env-file-if-exists=.env bin/serve.js >> inference.log 2>&1
echo %date% %time% inference exited with %errorlevel%, restarting in 5s >> inference.log
timeout /t 5 /nobreak > nul
goto loop
