const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

class BackupManager {
  constructor() {
    this.isBackingUp = false;
  }

  // Sincronizar y subir la base de datos a GitHub automáticamente
  async syncToGitHub(actionDescription = 'auto-sync') {
    if (this.isBackingUp) return { success: false, reason: 'already_running' };
    this.isBackingUp = true;

    try {
      const gitDir = path.join(__dirname, '..', '.git');
      if (!fs.existsSync(gitDir)) {
        this.isBackingUp = false;
        return { success: false, reason: 'no_git_repo' };
      }

      const cwd = path.join(__dirname, '..');
      const timestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');

      return await new Promise((resolve) => {
        const cmd = `git add data/alfa_citas.sqlite && git commit -m "auto-backup: ${actionDescription} [${timestamp}]" && git push origin main`;
        exec(cmd, { cwd }, (err, stdout) => {
          this.isBackingUp = false;
          if (err) {
            // Si no hay cambios nuevos para commitear
            if (err.message && err.message.includes('nothing to commit')) {
              return resolve({ success: true, message: 'Base de datos al día (sin cambios)' });
            }
            console.warn('[AutoBackup] Aviso al sincronizar con GitHub:', err.message);
            return resolve({ success: false, error: err.message });
          }
          console.log('✅ [AutoBackup] Respaldo de base de datos subido a GitHub exitosamente.');
          resolve({ success: true, stdout });
        });
      });
    } catch (e) {
      this.isBackingUp = false;
      console.warn('[AutoBackup] Error en sincronización:', e.message);
      return { success: false, error: e.message };
    }
  }
}

const backupManager = new BackupManager();
module.exports = backupManager;
