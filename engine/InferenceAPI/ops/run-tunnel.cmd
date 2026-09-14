@echo off
rem Reverse SSH tunnel: the production box reaches this workstation's
rem Inference API at 127.0.0.1:4033 on ITS loopback. Nothing is exposed to the
rem internet in either direction; the tunnel is authenticated by the SSH key
rem and the API additionally by INFERENCE_API_KEY.
cd /d "%~dp0.."
:loop
"C:\Program Files\Git\usr\bin\ssh.exe" -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes -i "%USERPROFILE%\.ssh\id_ed25519" -R 127.0.0.1:4033:127.0.0.1:4033 root@13.140.33.98 >> tunnel.log 2>&1
echo %date% %time% tunnel exited with %errorlevel%, reconnecting in 5s >> tunnel.log
timeout /t 5 /nobreak > nul
goto loop
