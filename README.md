# AlfaRespuestas - Sistema de Agendamiento de Entrevistas 24/7
### AlfaCredit S.A. | Recursos Humanos & WhatsApp Bot

Sistema integral y robusto para la gestión automatizada de entrevistas laborales, con turnos cada 15 minutos, alertas visuales y por WhatsApp de cupos críticos (10 turnos o menos), panel administrativo interactivo con reprogramación de cualquier dato, gestión dinámica de fechas, sistema de respaldos automáticos y empaquetador en instalador ejecutable `.exe` para desplegar en cualquier máquina Windows sin requerir Node.js ni Git.

---

## ☁️ Despliegue en la Nube 24/7 (Render / Railway / Docker)

### ⚠️ ¿Por qué NO en Vercel?
**Vercel es una plataforma *Serverless***. Sus servidores solo se activan por milisegundos para responder una petición HTTP web y luego **se apagan completamente**. 

Un bot de WhatsApp corporativo basado en Baileys requiere:
1. **Conexión WebSocket TCP permanente e ininterrumpida (24/7)** con los servidores de WhatsApp para recibir y enviar mensajes instantáneamente.
2. **Almacenamiento persistente** para que la sesión vinculada mediante el código QR (`auth_info_baileys`) y la base de datos SQLite no se borren cada pocos minutos.

Si se sube a Vercel, el bot se congelará a los pocos segundos y se desconectará.

### ✅ Despliegue Recomendado en 1 Clic (Render o Railway)

El proyecto incluye `Dockerfile`, `render.yaml` y `railway.json` listos para funcionar 24 horas al día, 7 días a la semana, incluso con la computadora apagada:

#### Opción A: Render.com
1. Sube este repositorio a tu cuenta de GitHub.
2. Ingresa a [Render.com](https://render.com) y crea un **New Web Service**.
3. Conecta el repositorio de GitHub. Render detectará automáticamente el archivo `render.yaml` o `Dockerfile`.
4. En **Disks**, asigna un disco persistente montado en `/data` (tamaño: 1 GB).
5. Haz clic en **Deploy**. ¡Listo! Tendrás tu enlace HTTPS (ej: `https://alfacredit-bot.onrender.com`) accesible desde cualquier teléfono o computadora del mundo.

#### Opción B: Railway.app
1. Ingresa a [Railway.app](https://railway.app) y haz clic en **New Project > Deploy from GitHub Repo**.
2. Agrega un **Volume** al servicio y móntalo en `/data`.
3. Establece la variable de entorno `PORT=3000` y `DATA_DIR=/data`.
4. El despliegue se completará automáticamente.

---

## 🚀 Características Principales

1. **Bot de WhatsApp Inteligente (@whiskeysockets/baileys):**
   - Conexión por WebSocket nativo con visualización del Código QR en el navegador web.
   - **Blindaje Conversacional:** Si el usuario ingresa un texto inválido o diferente en cualquier paso (`AWAITING_POSITION`, `AWAITING_DATE`, `AWAITING_NAME`, `AWAITING_PHONE`), el bot le advierte y **repite inmediatamente el menú del paso actual**, sin perder el estado ni avanzar hasta recibir una respuesta válida.
   - Detección de intenciones de reprogramación (`REPROGRAMAR`, `REINICIAR`).
   - Soporte para cuentas WhatsApp tipo LID (`@lid`), mensajes efímeros/temporales y multidispositivo (`:1`, `:2`).

2. **Gestión Dinámica de Fechas ("Abrir más fechas"):**
   - Recursos Humanos puede agregar nuevas fechas (ej: Jueves 6, Viernes 7 de Noviembre) directamente desde el botón **"Fechas"** en el panel web.
   - Activa o pausa fechas con 1 solo clic.
   - El bot de WhatsApp consulta las fechas activas en tiempo real y actualiza sus opciones automáticamente.

3. **Sistema de Respaldos Automáticos y Descarga de Seguridad:**
   - Cada creación, reprogramación, cancelación o cambio de fecha genera un respaldo en caliente (`VACUUM INTO`) en `data/backups/alfa_citas_backup_YYYYMMDD_HHMMSS.sqlite`.
   - Botón **"Respaldo"** en el panel superior para descargar la base de datos completa con un solo clic.

4. **Lógica de Horarios e Intervalos:**
   - Bloque Matutino: `08:30` a `12:00` (15 turnos de 15 minutos).
   - Bloque de Almuerzo: `12:00` a `13:30` (pausa total sin asignaciones).
   - Bloque Vespertino: `13:30` a `17:15` (16 turnos de 15 minutos).
   - Capacidad: **31 turnos por día**.

5. **Alerta de Cupos Críticos (10 turnos o menos):**
   - **En WhatsApp:** Advertencia automática *"⚡ ¡ÚLTIMOS CUPOS! Quedan únicamente X turnos disponibles..."*.
   - **En el Panel Web:** Banner superior rojo y tarjetas de fechas con alertas parpadeantes y barra de ocupación.

6. **Panel Administrativo en Tiempo Real:**
   - Métricas en vivo con actualización instantánea por WebSocket.
   - Buscador en vivo y filtros por fecha, plaza y estado.
   - Edición y reprogramación total con notificación formal automática al postulante por WhatsApp.
   - Exportación profesional a Excel (`.xlsx`).

7. **Instalador Autónomo Windows (.exe):**
   - Ubicado en `dist/Instalador-AlfaRespuestas.exe`.
   - Funciona sin requerir Node.js ni Git instalados en la máquina del cliente.

---

## 📁 Estructura del Proyecto

```
c:\sistema\AlfaRespuestas/
├── dist/
│   ├── Instalador-AlfaRespuestas.exe  # Instalador .exe para otra máquina
│   └── AlfaRespuestas-Portable.zip    # Paquete portable listo para usar
├── src/
│   ├── config.js                      # Configuración de rutas, horarios y persistencia
│   ├── database.js                    # Base de datos SQLite (citas, fechas dinámicas, backups)
│   ├── scheduler.js                   # Lógica de turnos, cupos <= 10 y plantillas dinámicas
│   ├── whatsapp.js                    # Conexión Baileys, blindaje conversacional y QR
│   ├── server.js                      # API Express, endpoints de fechas y WebSockets
│   └── public/                        # Frontend Web (HTML5, Tailwind, JS)
│       ├── index.html
│       ├── app.js
│       └── styles.css
├── tests/
│   ├── scheduler.test.js              # Pruebas de turnos, límites y formatos
│   ├── database.test.js               # Pruebas de persistencia y reprogramación
│   ├── whatsapp-flow.test.js          # Pruebas de flujo conversacional y blindaje
│   └── api.test.js                    # Pruebas de endpoints REST y backups
├── Dockerfile                         # Configuración para contenedor Docker en la nube
├── render.yaml                        # Blueprint para despliegue en Render.com
├── railway.json                       # Configuración para Railway.app
├── package.json
└── start.bat                          # Lanzador directo local
```

---

## 🧪 Verificación y Pruebas Automatizadas

Para ejecutar la suite de pruebas:
```bash
npm test
```

---

## 💻 Ejecución Local

Hacer doble clic en `start.bat` o ejecutar:
```bash
npm start
```
El panel estará disponible en: [http://localhost:3000](http://localhost:3000).
