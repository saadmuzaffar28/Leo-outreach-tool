@echo off
cd /d "C:\Users\PC\Documents\star-billing-outreach-main\star-billing-outreach-main"
"node_modules\.bin\prisma.cmd" generate
echo GENPROC_EXIT=%ERRORLEVEL%