@echo off
title AlfaCredit S.A. - AlfaRespuestas
cd /d "%~dp0"
echo ========================================================
echo   ALFACREDIT S.A. - SISTEMA ALFARESPUESTAS
echo   WhatsApp Bot de Entrevistas y Panel de Control
echo ========================================================
echo.
echo Iniciando servidor en http://localhost:3000 ...
echo Abriendo navegador web...
start http://localhost:3000
node src\server.js
pause
