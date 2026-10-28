const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const STAGING_DIR = path.join(DIST_DIR, 'AlfaRespuestas');
const PAYLOAD_ZIP = path.join(DIST_DIR, 'payload.zip');
const INSTALLER_EXE = path.join(DIST_DIR, 'Instalador-AlfaRespuestas.exe');
const PORTABLE_ZIP = path.join(DIST_DIR, 'AlfaRespuestas-Portable.zip');

const CSC_PATH = 'C:\\WINDOWS\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const NODE_SOURCE = 'C:\\Program Files\\nodejs\\node.exe';

console.log('=================================================================');
console.log('🔨 CONSTRUCCIÓN DEL INSTALADOR AUTÓNOMO (.EXE) - ALFACREDIT S.A.');
console.log('=================================================================');

// 1. Preparar directorios limpios
if (fs.existsSync(DIST_DIR)) {
  console.log('🧹 Limpiando directorio dist previo...');
  try {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  } catch (e) {
    console.warn('Nota al limpiar dist:', e.message);
  }
}
fs.mkdirSync(STAGING_DIR, { recursive: true });

// 2. Copiar node.exe para el bundle portable autónomo
console.log('📦 Copiando runtime autónomo de Node.js...');
if (!fs.existsSync(NODE_SOURCE)) {
  throw new Error(`No se encontró node.exe en ${NODE_SOURCE}`);
}
fs.copyFileSync(NODE_SOURCE, path.join(STAGING_DIR, 'node.exe'));

// 3. Copiar src, package.json
console.log('📂 Copiando archivos de la aplicación (src, config, frontend)...');
copyRecursiveSync(path.join(ROOT_DIR, 'src'), path.join(STAGING_DIR, 'src'));
fs.copyFileSync(path.join(ROOT_DIR, 'package.json'), path.join(STAGING_DIR, 'package.json'));

// Crear directorio de datos vacío
fs.mkdirSync(path.join(STAGING_DIR, 'data'), { recursive: true });

// 4. Copiar node_modules de producción
console.log('📚 Copiando dependencias node_modules...');
copyRecursiveSync(path.join(ROOT_DIR, 'node_modules'), path.join(STAGING_DIR, 'node_modules'));

// 5. Compilar Launcher.exe nativo
console.log('⚙️  Compilando lanzador nativo AlfaRespuestas.exe...');
const launcherCs = path.join(__dirname, 'Launcher.cs');
const launcherOut = path.join(STAGING_DIR, 'AlfaRespuestas.exe');

const cscLauncherCmd = `"${CSC_PATH}" /nologo /target:winexe /optimize /r:System.Windows.Forms.dll /r:System.Drawing.dll /out:"${launcherOut}" "${launcherCs}"`;
execSync(cscLauncherCmd, { stdio: 'inherit' });

// 6. Crear scripts batch de apoyo
console.log('📝 Generando scripts de ejecución rápida...');
fs.writeFileSync(
  path.join(STAGING_DIR, 'Iniciar.bat'),
  '@echo off\r\ncd /d "%~dp0"\r\nstart "" "AlfaRespuestas.exe"\r\n',
  'utf8'
);

fs.writeFileSync(
  path.join(STAGING_DIR, 'Iniciar-Consola.bat'),
  '@echo off\r\ncd /d "%~dp0"\r\necho ===================================================\r\necho  AlfaCredit S.A. - Servidor AlfaRespuestas\r\necho ===================================================\r\nnode.exe src\\server.js\r\npause\r\n',
  'utf8'
);

// 7. Comprimir paquete en payload.zip usando tar.exe
console.log('🗜️  Empaquetando payload comprimido (payload.zip)...');
if (fs.existsSync(PAYLOAD_ZIP)) fs.unlinkSync(PAYLOAD_ZIP);
execSync(`tar.exe -a -cf "${PAYLOAD_ZIP}" -C "${STAGING_DIR}" .`, { stdio: 'inherit' });

// Copiar también como AlfaRespuestas-Portable.zip para descarga directa
fs.copyFileSync(PAYLOAD_ZIP, PORTABLE_ZIP);

// 8. Compilar Instalador-AlfaRespuestas.exe con payload embebido
console.log('🚀 Compilando instalador autónomo Instalador-AlfaRespuestas.exe...');
const installerCs = path.join(__dirname, 'Installer.cs');

const cscInstallerCmd = `"${CSC_PATH}" /nologo /target:winexe /optimize /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /resource:"${PAYLOAD_ZIP}",payload /out:"${INSTALLER_EXE}" "${installerCs}"`;
execSync(cscInstallerCmd, { stdio: 'inherit' });

// Eliminar el zip temporal interno de dist si se desea mantener orden
console.log('✅ Verificando archivos generados:');
const installerStat = fs.statSync(INSTALLER_EXE);
const portableStat = fs.statSync(PORTABLE_ZIP);

console.log(`   - Instalador .EXE: ${INSTALLER_EXE} (${(installerStat.size / 1024 / 1024).toFixed(2)} MB)`);
console.log(`   - Paquete Portable: ${PORTABLE_ZIP} (${(portableStat.size / 1024 / 1024).toFixed(2)} MB)`);
console.log('=================================================================');
console.log('🎉 ¡COMPILACIÓN DEL INSTALADOR COMPLETADA EXITOSAMENTE!');
console.log('=================================================================');

function copyRecursiveSync(src, dest) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats.isDirectory();
  if (isDirectory) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    fs.readdirSync(src).forEach((childItemName) => {
      // Excluir carpetas temporales, logs y .git
      if (['.git', '.cache', '.system_generated'].includes(childItemName)) return;
      copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
    });
  } else {
    fs.copyFileSync(src, dest);
  }
}
