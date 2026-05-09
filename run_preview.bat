@echo off
cd /d "c:\Users\neofi\content report"
"C:\Program Files\nodejs\node.exe" tools/preview_send.js >> run_preview.log 2>&1
