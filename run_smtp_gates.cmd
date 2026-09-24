@echo off
setlocal EnableExtensions
cd /d "C:\Users\PC\Documents\star-billing-outreach-main\star-billing-outreach-main"
set "OUT=%TEMP%\smtp_gates_res.txt"
echo SMTP_GATES_RUN_BEGIN>"%OUT%"
echo === TSC ===>>"%OUT%"
call "node_modules\.bin\tsc.cmd" --noEmit>>"%OUT%" 2>&1
set "TSCE=%errorlevel%"
echo TSC_EXIT=%TSCE%>>"%OUT%"
echo === VITEST ===>>"%OUT%"
call "node_modules\.bin\vitest.cmd" run --reporter=dot>>"%OUT%" 2>&1
set "VITE=%errorlevel%"
echo VIT_EXIT=%VITE%>>"%OUT%"
echo === BUILD ===>>"%OUT%"
call "node_modules\.bin\next.cmd" build>>"%OUT%" 2>&1
set "BLDE=%errorlevel%"
echo BUILD_EXIT=%BLDE%>>"%OUT%"
echo SMTP_GATES_RUN_END>>"%OUT%"
echo RUNNER_DONE
endlocal