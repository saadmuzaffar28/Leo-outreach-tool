@echo off
setlocal
cd /d "C:\Users\PC\Documents\star-billing-outreach-main\star-billing-outreach-main"
set "LOG=%TEMP%\app_runtime.log"
echo APP_RUN_BEGIN>"%LOG%"
echo START_UTC_SECONDS=%date% %time%>>"%LOG%"
start "sbs-dev" /min cmd /c "call "node_modules\.bin\next.cmd" dev -p 3002 >>"%TEMP%\app_dev.out" 2>>"%TEMP%\app_dev.err""
echo DEV_LAUNCHED=True>>"%LOG%"
echo APP_RUN_LAUNCH_DONE>>"%LOG%"
endlocal