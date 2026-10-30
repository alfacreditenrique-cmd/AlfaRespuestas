@echo off
title AlfaCredit S.A. - AlfaRespuestas (Servidor + Tunel Publico + WhatsApp Bot)
cd /d "%~dp0"
echo ========================================================
echo   ALFACREDIT S.A. - SISTEMA ALFARESPUESTAS
echo   WhatsApp Bot + Panel de Control + Tunel Web Publico
echo ========================================================
echo.
netstat -ano | findstr ":3000.*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo El servidor AlfaRespuestas ya esta activo en http://localhost:3000
  if exist "data\public_url.txt" (
    echo Enlace publico actual:
    type "data\public_url.txt"
  )
  start http://localhost:3000
  pause
  exit /b 0
)
echo Iniciando servidor en http://localhost:3000 y generando enlace publico HTTPS...
echo Abriendo navegador web...
start http://localhost:3000
node src\server.js
pause

