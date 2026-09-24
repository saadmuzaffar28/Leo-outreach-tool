@echo off
setlocal EnableExtensions
cd /d "C:\Users\PC\Documents\star-billing-outreach-main\star-billing-outreach-main"
set "TSC_OUT=%TEMP%\gate_tsc.out"
set "TSC_ERR=%TEMP%\gate_tsc.err"
set "VIT_OUT=%TEMP%\gate_vit.out"
set "VIT_ERR=%TEMP%\gate_vit.err"
set "BLD_OUT=%TEMP%\gate_bld.out"
set "BLD_ERR=%TEMP%\gate_bld.err"

echo GATE_TSC_BEGIN
call "node_modules\.bin\tsc.cmd" --noEmit 1>"%TSC_OUT%" 2>"%TSC_ERR%"
set "TSC_EXIT=%errorlevel%"
echo GATE_TSC_EXIT=%TSC_EXIT%
IF %TSC_EXIT%==0 ( echo GATE_TSC_RESULT=PASS ) else ( echo GATE_TSC_RESULT=FAIL )

echo GATE_VIT_BEGIN
call "node_modules\.bin\vitest.cmd" run --reporter=dot 1>"%VIT_OUT%" 2>"%VIT_ERR%"
set "VIT_EXIT=%errorlevel%"
echo GATE_VIT_EXIT=%VIT_EXIT%
IF %VIT_EXIT%==0 ( echo GATE_VIT_RESULT=PASS ) else ( echo GATE_VIT_RESULT=FAIL )

echo GATE_BUILD_BEGIN
call "node_modules\.bin\next.cmd" build 1>"%BLD_OUT%" 2>"%BLD_ERR%"
set "BLD_EXIT=%errorlevel%"
echo GATE_BUILD_EXIT=%BLD_EXIT%
IF %BLD_EXIT%==0 ( echo GATE_BUILD_RESULT=PASS ) else ( echo GATE_BUILD_RESULT=FAIL )

echo GATES_ALL_END
endlocal