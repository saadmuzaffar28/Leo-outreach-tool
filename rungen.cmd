@echo off
cd /d "C:\Users\PC\Documents\star-billing-outreach-main\star-billing-outreach-main"
call "node_modules\.bin\prisma.cmd" generate
echo GENRUNNER_EXIT=%ERRORLEVEL%