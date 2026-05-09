@echo off
cd /d "c:\Users\neofi\content report"
"C:\Program Files\nodejs\node.exe" tools/main.js --now >> run_report.log 2>&1
