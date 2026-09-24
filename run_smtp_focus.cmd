@echo off
setlocal
cd /d "C:\Users\PC\Documents\star-billing-outreach-main\star-billing-outreach-main"
set "VF=%~dp0vit_s.txt"
call "node_modules\.bin\vitest.cmd" run --reporter=verbose tests/smtp.test.ts > "%VF%" 2>&1
set RV=%errorlevel%
echo VIT_SMTP_FOCUS_EXIT=%RV%
if exist "%VF%" (
  echo VIT_SMTP_FOCUS_FILE_SIZE=%z_IGNORED%
  for /f "usebackq delims=" %%L in ("%VF%") do (
    echo FOCUS_LINE: %%L
  )
)
echo FOCUS_RUN_END
endlocal