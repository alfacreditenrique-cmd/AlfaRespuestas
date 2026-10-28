const path = require('path');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

const CONFIG = {
  PORT: process.env.PORT || 3000,
  COMPANY_NAME: 'AlfaCredit S.A.',
  LOCATION: 'Oficinas Principales AlfaCredit S.A., Edificio Central, Nivel 3',
  DATA_DIR: dataDir,
  DB_PATH: process.env.DB_PATH || path.join(dataDir, 'alfa_citas.sqlite'),
  AUTH_DIR: process.env.AUTH_DIR || (process.env.DATA_DIR ? path.join(dataDir, 'auth_info_baileys') : path.join(__dirname, '..', 'auth_info_baileys')),
  BACKUP_DIR: process.env.BACKUP_DIR || path.join(dataDir, 'backups'),

  // Plazas disponibles
  POSITIONS: [
    { id: '1', title: 'Oficial de Crédito', code: 'OFICIAL' },
    { id: '2', title: 'Promotor de Crédito', code: 'PROMOTOR' },
    { id: '3', title: 'Desembolsador de Crédito', code: 'DESEMBOLSADOR' }
  ],

  // Fechas de entrevistas permitidas
  DATES: [
    { id: '2025-11-04', label: 'Martes 4 de Noviembre', short: '04/11' },
    { id: '2025-11-05', label: 'Miércoles 5 de Noviembre', short: '05/11' }
  ],

  // Turnos en bloques de 15 minutos:
  // Mañana: 08:30 AM a 12:00 PM (15 turnos)
  // Almuerzo: 12:00 PM a 01:30 PM (pausa)
  // Tarde: 01:30 PM a 05:30 PM (16 turnos, último inicio 17:15)
  // Total por día: 31 turnos
  TIME_SLOTS: [
    // Mañana
    '08:30', '08:45', '09:00', '09:15', '09:30', '09:45',
    '10:00', '10:15', '10:30', '10:45', '11:00', '11:15',
    '11:30', '11:45', '12:00',
    // Tarde
    '13:30', '13:45', '14:00', '14:15', '14:30', '14:45',
    '15:00', '15:15', '15:30', '15:45', '16:00', '16:15',
    '16:30', '16:45', '17:00', '17:15'
  ],

  // Alerta de cupos críticos cuando queden 10 turnos o menos
  LOW_SLOTS_ALERT_THRESHOLD: 10,

  // Estados posibles de la cita
  STATUSES: {
    CONFIRMED: 'confirmada',
    RESCHEDULED: 'reprogramada',
    CANCELLED: 'cancelada',
    ATTENDED: 'asistio',
    NO_SHOW: 'no_asistio'
  },

  // Prefijo telefónico nacional por defecto (+505 Nicaragua)
  DEFAULT_COUNTRY_CODE: '505',

  // Normalizador de números telefónicos (soporta formato nacional de 8 dígitos)
  normalizePhone(phone) {
    if (!phone) return '';
    let digits = String(phone).replace(/[^0-9]/g, '');
    if (digits.length === 8) {
      digits = (CONFIG.DEFAULT_COUNTRY_CODE || '505') + digits;
    }
    return digits;
  }
};

module.exports = CONFIG;
