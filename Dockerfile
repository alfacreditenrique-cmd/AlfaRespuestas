# Imagen base Node.js 22 LTS (soporta DatabaseSync node:sqlite nativo)
FROM node:22-bookworm-slim

# Directorio de trabajo
WORKDIR /app

# Variables de entorno por defecto
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

# Instalar dependencias primero para optimizar caché de capas Docker
COPY package*.json ./
RUN npm ci --only=production

# Copiar el código fuente de la aplicación
COPY . .

# Crear directorios para persistencia de base de datos, backups y sesión WhatsApp
RUN mkdir -p /data/backups /data/auth_info_baileys

# Exponer el puerto
EXPOSE 3000

# Punto de entrada para ejecución 24/7
CMD ["node", "src/server.js"]
