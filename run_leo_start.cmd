@echo off
setlocal EnableExtensions
cd /d "C:\Users\PC\Documents\star-billing-outreach-main\star-billing-outreach-main"
set "LOG=%TEMP%\leo_start.out"
"echo" >"%LOG%"
echo LEO_START_BEGIN>>"%LOG%"
call "node_modules\.bin\next.cmd" dev -p 3002 -H 0.0.0.0 >>"%LOG%" 2>&1
echo LEO_NEXT_EXIT=%errorlevel%>>"%LOG%"
echo LEO_START_END>>"%LOG%"
endlocal