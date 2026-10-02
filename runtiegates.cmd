@echo off
setlocal
cd /d "C:\Users\PC\Documents\star-billing-outreach-main\star-billing-outreach-main"
echo ===== GATE_TSC_BEGIN =====
call "node_modules\.bin\tsc.cmd" --noEmit
set TS
echo GATE_TSC_EXIT=%errorlevel%
echo ===== GATE_TSC_END =====
echo ===== GATE_VIT_BEGIN =====
call "node_modules\.bin\vitest.cmd" run --reporter=dot
set VT
echo GATE_VIT_EXIT=%errorlevel%
echo ===== GATE_VIT_END =====
echo ===== GATE_BUILD_BEGIN =====
call "node_modules\.bin\next.cmd" build
set BL
echo GATE_BUILD_EXIT=%errorlevel%
echo ===== GATE_BUILD_END =====
echo ===== GATES_DONE =====
