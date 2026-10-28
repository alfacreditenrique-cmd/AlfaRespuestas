// Estado local de la aplicación
const state = {
  config: null,
  whatsapp: null,
  stats: null,
  appointments: [],
  filters: {
    search: '',
    date: '',
    position: '',
    status: ''
  },
  ws: null
};

// Formateador de 12h
function formatTime12h(timeStr) {
  if (!timeStr) return '';
  const parts = timeStr.split(':');
  if (parts.length < 2) return timeStr;
  let hours = parseInt(parts[0], 10);
  const minutes = parts[1];
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 === 0 ? 12 : hours % 12;
  return `${displayHours.toString().padStart(2, '0')}:${minutes} ${ampm}`;
}

// Inicialización
document.addEventListener('DOMContentLoaded', () => {
  initWebSocket();
  fetchInitialData();
  setupEventListeners();
});

// Conexión WebSocket
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  try {
    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.onopen = () => {
      console.log('✅ WebSocket conectado con el servidor AlfaRespuestas');
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        handleSocketMessage(message);
      } catch (err) {
        console.error('Error parseando mensaje WebSocket:', err);
      }
    };

    ws.onclose = () => {
      console.warn('⚠️ WebSocket desconectado. Reintentando en 3s...');
      setTimeout(initWebSocket, 3000);
    };

    ws.onerror = (err) => {
      console.error('Error de WebSocket:', err);
    };
  } catch (e) {
    console.error('No se pudo inicializar WebSocket:', e);
  }
}

// Manejar mensajes recibidos por WebSocket
function handleSocketMessage(msg) {
  const { event, data } = msg;

  if (event === 'init_state') {
    state.config = data.config;
    updateWhatsAppUI(data.whatsapp);
    updateStatsUI(data.stats);
    updateDateDropdowns(data.config?.dates || []);
  } else if (event === 'status_change') {
    updateWhatsAppUI(data);
  } else if (event === 'qr') {
    if (state.whatsapp) state.whatsapp.qrDataUrl = data.qrDataUrl;
    updateWhatsAppUI({ status: 'QR_READY', qrDataUrl: data.qrDataUrl });
  } else if (event === 'new_appointment' || event === 'appointment_created') {
    showToast(`🎉 Nueva cita agendada: ${data.candidate_name} (${data.time_slot})`, 'success');
    fetchAppointments();
    fetchStats();
  } else if (event === 'appointment_updated') {
    showToast(`📝 Cita actualizada: ${data.candidate_name}`, 'info');
    fetchAppointments();
    fetchStats();
  } else if (event === 'appointment_cancelled') {
    showToast(`❌ Cita cancelada: ${data.candidate_name}`, 'warning');
    fetchAppointments();
    fetchStats();
  } else if (event === 'stats_updated') {
    updateStatsUI(data);
  } else if (event === 'dates_updated') {
    if (state.config) state.config.dates = data;
    updateDateDropdowns(data);
    renderDatesTable(data);
  }
}

// Cargar datos iniciales vía REST API
async function fetchInitialData() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (data.success) {
      state.config = data.config;
      updateWhatsAppUI(data.whatsapp);
      updateStatsUI(data.stats);
      updateDateDropdowns(data.config?.dates || []);
    }
  } catch (e) {
    console.error('Error cargando status inicial:', e);
  }
  await fetchAppointments();
}

async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    if (data.success) {
      updateStatsUI(data.stats);
    }
  } catch (e) {
    console.error('Error cargando estadísticas:', e);
  }
}

async function fetchAppointments() {
  const { search, date, position, status } = state.filters;
  const params = new URLSearchParams();
  if (search) params.append('search', search);
  if (date) params.append('date', date);
  if (position) params.append('position', position);
  if (status) params.append('status', status);

  try {
    const res = await fetch(`/api/appointments?${params.toString()}`);
    const data = await res.json();
    if (data.success) {
      state.appointments = data.appointments;
      renderAppointmentsTable(data.appointments);
    }
  } catch (e) {
    console.error('Error cargando citas:', e);
    showToast('Error cargando citas del servidor', 'error');
  }
}

// Actualizar UI de WhatsApp
function updateWhatsAppUI(wa) {
  if (!wa) return;
  state.whatsapp = wa;

  const badge = document.getElementById('waConnectionBadge');
  const statusText = document.getElementById('waStatusText');
  const connectedView = document.getElementById('waConnectedView');
  const qrView = document.getElementById('waQrView');
  const connectingView = document.getElementById('waConnectingView');
  const qrImage = document.getElementById('waQrImage');
  const connectedAccount = document.getElementById('waConnectedAccount');

  if (wa.status === 'CONNECTED') {
    badge.className = 'flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';
    badge.firstElementChild.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400';
    statusText.textContent = 'WhatsApp Activo';

    connectedView.classList.remove('hidden');
    qrView.classList.add('hidden');
    connectingView.classList.add('hidden');

    if (wa.connectionInfo) {
      connectedAccount.textContent = wa.connectionInfo.name ? `${wa.connectionInfo.name} (${wa.connectionInfo.id.split(':')[0]})` : wa.connectionInfo.id.split(':')[0];
    }
  } else if (wa.status === 'QR_READY' && wa.qrDataUrl) {
    badge.className = 'flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/40';
    badge.firstElementChild.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse';
    statusText.textContent = 'Escanea el Código QR';

    connectedView.classList.add('hidden');
    qrView.classList.remove('hidden');
    connectingView.classList.add('hidden');
    qrImage.src = wa.qrDataUrl;
  } else {
    // CONNECTING o DISCONNECTED
    badge.className = 'flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-blue-500/20 text-blue-300 border border-blue-500/40';
    badge.firstElementChild.className = 'w-2.5 h-2.5 rounded-full bg-blue-400 animate-pulse';
    statusText.textContent = wa.status === 'CONNECTING' ? 'Generando sesión...' : 'Desconectado';

    connectedView.classList.add('hidden');
    qrView.classList.add('hidden');
    connectingView.classList.remove('hidden');
  }
}

// Actualizar Estadísticas y Alertas de Cupos
function updateStatsUI(stats) {
  if (!stats) return;
  state.stats = stats;

  // Totales
  const totalEl = document.getElementById('totalAgendados');
  if (totalEl) totalEl.textContent = (stats.totals?.confirmed || 0) + (stats.totals?.rescheduled || 0);

  // Plazas
  const oficialCount = stats.byPosition?.find(p => p.position.includes('Oficial'))?.count || 0;
  const promotorCount = stats.byPosition?.find(p => p.position.includes('Promotor'))?.count || 0;
  const desembolsadorCount = stats.byPosition?.find(p => p.position.includes('Desembolsador'))?.count || 0;

  const countOficialEl = document.getElementById('countOficial');
  if (countOficialEl) countOficialEl.textContent = oficialCount;
  const countPromotorEl = document.getElementById('countPromotor');
  if (countPromotorEl) countPromotorEl.textContent = promotorCount;
  const countDesembolsadorEl = document.getElementById('countDesembolsador');
  if (countDesembolsadorEl) countDesembolsadorEl.textContent = desembolsadorCount;

  // Renderizar tarjetas dinámicas de fechas
  renderDateCards(stats.datesStats || []);

  // Fechas y Alerta de cupos <= 10
  let criticalAlertActive = false;
  let criticalMessages = [];

  (stats.datesStats || []).forEach(d => {
    if (d.is_active) {
      if (d.isExhausted) {
        criticalAlertActive = true;
        criticalMessages.push(`${d.label}: CUPOS AGOTADOS`);
      } else if (d.isCritical) {
        criticalAlertActive = true;
        criticalMessages.push(`${d.label}: ÚLTIMOS ${d.remaining} TURNOS`);
      }
    }
  });

  // BANNER SUPERIOR DE ALERTA DE CUPOS CRÍTICOS (<= 10 TURNOS)
  const quotaBanner = document.getElementById('criticalQuotaBanner');
  const quotaText = document.getElementById('criticalQuotaText');
  if (quotaBanner && quotaText) {
    if (criticalAlertActive) {
      quotaBanner.classList.remove('hidden');
      quotaText.textContent = `¡Alta demanda de candidatos! Se está llegando al límite de cupos: ${criticalMessages.join(' | ')}. Los mensajes de WhatsApp informan automáticamente a los postulantes de los últimos turnos disponibles.`;
    } else {
      quotaBanner.classList.add('hidden');
    }
  }
}

// Renderizado dinámico de tarjetas de fechas
function renderDateCards(datesStats) {
  const container = document.getElementById('datesCardsContainer');
  if (!container) return;

  container.innerHTML = '';
  datesStats.forEach((d, idx) => {
    const card = document.createElement('div');
    card.id = `cardDate${idx + 1}`;
    const pct = Math.round((d.taken / (d.totalCapacity || 1)) * 100);

    let borderClass = 'border-slate-200';
    let badgeHtml = '';
    let progressBg = idx % 2 === 0 ? 'bg-blue-600' : 'bg-indigo-600';

    if (!d.is_active) {
      borderClass = 'border-slate-300 opacity-60';
      badgeHtml = `<span class="px-2.5 py-1 text-xs font-semibold rounded-full bg-slate-100 text-slate-600">⏸️ En Pausa</span>`;
    } else if (d.isExhausted) {
      borderClass = 'border-red-300 bg-red-50/20 border-2';
      badgeHtml = `<span class="px-2.5 py-1 text-xs font-bold rounded-full bg-red-100 text-red-800">❌ AGOTADO</span>`;
      progressBg = 'bg-red-600';
    } else if (d.isCritical) {
      borderClass = 'border-red-400 bg-red-50/20 border-2 shadow-md';
      badgeHtml = `<span class="px-2.5 py-1 text-xs font-bold rounded-full bg-red-100 text-red-800 animate-pulse">⚡ ¡ÚLTIMOS ${d.remaining} CUPOS!</span>`;
      progressBg = 'bg-red-500';
    } else {
      badgeHtml = `<span class="px-2.5 py-1 text-xs font-semibold rounded-full bg-blue-100 text-blue-700">${d.remaining} disponibles</span>`;
    }

    card.className = `bg-white rounded-2xl p-5 border ${borderClass} shadow-sm relative overflow-hidden flex flex-col justify-between transition hover:shadow`;
    card.innerHTML = `
      <div class="flex justify-between items-start">
        <div>
          <span class="text-xs font-bold uppercase tracking-wider text-slate-500">Fecha ${idx + 1}</span>
          <h3 class="text-lg font-bold text-slate-800">${escapeHtml(d.label)}</h3>
        </div>
        <div id="badgeDate${idx + 1}">${badgeHtml}</div>
      </div>
      <div class="my-4">
        <div class="flex items-baseline space-x-2">
          <span id="remainingDate${idx + 1}" class="text-3xl font-black text-slate-900">${d.remaining}</span>
          <span class="text-sm text-slate-500 font-medium">turnos disponibles</span>
        </div>
        <div class="text-xs text-slate-500 mt-1">
          <span id="takenDate${idx + 1}" class="font-semibold text-slate-700">${d.taken}</span> de ${d.totalCapacity} turnos ocupados
        </div>
        <div class="w-full bg-slate-100 h-2.5 rounded-full mt-3 overflow-hidden">
          <div id="progressBarDate${idx + 1}" class="${progressBg} h-2.5 rounded-full transition-all duration-500" style="width: ${pct}%"></div>
        </div>
      </div>
      <div class="text-xs font-semibold text-slate-500 flex items-center justify-between pt-2 border-t border-slate-100">
        <div class="flex items-center gap-1.5">
          <i class="fa-regular fa-clock"></i>
          <span>8:30 - 12:00 y 13:30 - 17:30</span>
        </div>
        <span class="text-[11px] font-mono text-slate-400">${d.date}</span>
      </div>
    `;

    container.appendChild(card);
  });
}

// Sincronizar selectores de fechas en filtros y formularios
function updateDateDropdowns(dates) {
  if (!dates || !Array.isArray(dates)) return;

  // 1. Filtro en tabla (#filterDate)
  const filterSelect = document.getElementById('filterDate');
  if (filterSelect) {
    const currentVal = filterSelect.value;
    filterSelect.innerHTML = '<option value="">Todas las Fechas</option>';
    dates.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.label}${d.is_active ? '' : ' (Pausada)'}`;
      filterSelect.appendChild(opt);
    });
    filterSelect.value = currentVal;
  }

  // 2. Nueva Cita (#newDate)
  const newDateSelect = document.getElementById('newDate');
  if (newDateSelect) {
    const currentVal = newDateSelect.value;
    newDateSelect.innerHTML = '';
    const activeDates = dates.filter(d => d.is_active);
    activeDates.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.label;
      newDateSelect.appendChild(opt);
    });
    if (activeDates.some(d => d.id === currentVal)) {
      newDateSelect.value = currentVal;
    } else if (activeDates.length > 0) {
      newDateSelect.value = activeDates[0].id;
    }
  }

  // 3. Edición de Cita (#editDate)
  const editDateSelect = document.getElementById('editDate');
  if (editDateSelect) {
    const currentVal = editDateSelect.value;
    editDateSelect.innerHTML = '';
    dates.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.label}${d.is_active ? '' : ' (Pausada)'}`;
      editDateSelect.appendChild(opt);
    });
    if (currentVal) editDateSelect.value = currentVal;
  }
}

// Renderizar tabla de citas
function renderAppointmentsTable(appointments) {
  const tbody = document.getElementById('appointmentsTableBody');
  const totalCountEl = document.getElementById('tableTotalCount');
  totalCountEl.textContent = appointments.length;

  if (appointments.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="text-center py-12 text-slate-400">
          <i class="fa-regular fa-folder-open text-3xl mb-2 text-slate-300"></i>
          <p class="font-medium">No se encontraron citas con los filtros seleccionados.</p>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = appointments.map((apt, index) => {
    const time12h = formatTime12h(apt.time_slot);
    const dateFormatted = apt.date === '2025-11-04' ? 'Martes 04/Nov' : (apt.date === '2025-11-05' ? 'Miércoles 05/Nov' : apt.date);

    // Estado Badge
    let statusBadge = '';
    if (apt.status === 'confirmada') {
      statusBadge = `<span class="px-2.5 py-1 text-xs font-bold rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200">Confirmada</span>`;
    } else if (apt.status === 'reprogramada') {
      statusBadge = `<span class="px-2.5 py-1 text-xs font-bold rounded-full bg-amber-100 text-amber-800 border border-amber-200">Reprogramada</span>`;
    } else if (apt.status === 'cancelada') {
      statusBadge = `<span class="px-2.5 py-1 text-xs font-bold rounded-full bg-red-100 text-red-800 border border-red-200">Cancelada</span>`;
    } else if (apt.status === 'asistio') {
      statusBadge = `<span class="px-2.5 py-1 text-xs font-bold rounded-full bg-blue-100 text-blue-800 border border-blue-200">Asistió</span>`;
    } else if (apt.status === 'no_asistio') {
      statusBadge = `<span class="px-2.5 py-1 text-xs font-bold rounded-full bg-slate-200 text-slate-800 border border-slate-300">No Asistió</span>`;
    } else {
      statusBadge = `<span class="px-2.5 py-1 text-xs font-bold rounded-full bg-slate-100 text-slate-700">${apt.status}</span>`;
    }

    // Notificado Badge
    const notifiedBadge = apt.notified_at
      ? `<span title="Notificado el ${new Date(apt.notified_at).toLocaleTimeString()}" class="inline-flex items-center text-xs font-medium text-emerald-600 gap-1"><i class="fa-solid fa-check-double text-emerald-500"></i> Enviado</span>`
      : `<span class="inline-flex items-center text-xs font-medium text-slate-400 gap-1"><i class="fa-regular fa-clock"></i> Pendiente</span>`;

    const digitsOnly = String(apt.phone_number).replace(/[^0-9]/g, '');

    return `
      <tr class="hover:bg-blue-50/40 transition-colors">
        <td class="py-3.5 px-4 font-mono text-xs text-slate-400 text-center font-bold">${apt.id}</td>
        
        <td class="py-3.5 px-4">
          <div class="font-bold text-slate-900">${escapeHtml(apt.candidate_name)}</div>
          ${apt.notes ? `<div class="text-[11px] text-slate-400 truncate max-w-xs" title="${escapeHtml(apt.notes)}">${escapeHtml(apt.notes)}</div>` : ''}
        </td>

        <td class="py-3.5 px-4">
          <a href="https://wa.me/${digitsOnly}" target="_blank" rel="noopener noreferrer" title="Abrir chat en WhatsApp" class="inline-flex items-center space-x-1.5 font-medium text-slate-800 hover:text-emerald-700 group transition">
            <i class="fa-brands fa-whatsapp text-emerald-600 text-sm group-hover:scale-110 transition-transform"></i>
            <span class="group-hover:underline">${escapeHtml(apt.phone_number)}</span>
          </a>
        </td>

        <td class="py-3.5 px-4">
          <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200">
            ${escapeHtml(apt.position)}
          </span>
        </td>

        <td class="py-3.5 px-4">
          <div class="font-bold text-slate-800">${dateFormatted}</div>
          <div class="text-xs text-blue-600 font-semibold flex items-center gap-1">
            <i class="fa-regular fa-clock text-[10px]"></i>
            ${time12h} (${apt.time_slot})
          </div>
        </td>

        <td class="py-3.5 px-4 text-center">
          ${statusBadge}
        </td>

        <td class="py-3.5 px-4 text-center">
          ${notifiedBadge}
        </td>

        <td class="py-3.5 px-4 text-right space-x-1.5">
          <button onclick="openEditModal(${apt.id})" title="Editar / Reprogramar cita" class="p-1.5 text-blue-600 hover:bg-blue-100 rounded-lg transition">
            <i class="fa-solid fa-pen-to-square"></i>
          </button>
          <button onclick="resendNotification(${apt.id})" title="Reenviar ticket por WhatsApp" class="p-1.5 text-emerald-600 hover:bg-emerald-100 rounded-lg transition">
            <i class="fa-solid fa-paper-plane"></i>
          </button>
          <button onclick="cancelAppointment(${apt.id})" title="Cancelar cita y liberar cupo" class="p-1.5 text-red-500 hover:bg-red-100 rounded-lg transition">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// Configurar event listeners
function setupEventListeners() {
  // Búsqueda con debounce
  let searchTimeout = null;
  document.getElementById('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.filters.search = e.target.value;
      fetchAppointments();
    }, 250);
  });

  // Filtros
  document.getElementById('filterDate').addEventListener('change', (e) => {
    state.filters.date = e.target.value;
    fetchAppointments();
  });

  document.getElementById('filterPosition').addEventListener('change', (e) => {
    state.filters.position = e.target.value;
    fetchAppointments();
  });

  document.getElementById('filterStatus').addEventListener('change', (e) => {
    state.filters.status = e.target.value;
    fetchAppointments();
  });

  document.getElementById('btnRefresh').addEventListener('click', () => {
    fetchAppointments();
    fetchStats();
    showToast('Datos actualizados', 'info');
  });

  // Reiniciar WhatsApp
  document.getElementById('btnRestartWa').addEventListener('click', async () => {
    if (confirm('¿Deseas reiniciar la conexión de WhatsApp?')) {
      try {
        await fetch('/api/whatsapp/restart', { method: 'POST' });
        showToast('Reiniciando conexión de WhatsApp...', 'info');
      } catch (e) {
        showToast('Error al reiniciar WhatsApp', 'error');
      }
    }
  });

  // Modal de Edición
  document.getElementById('btnCloseEditModal').addEventListener('click', closeEditModal);
  document.getElementById('btnCancelEdit').addEventListener('click', closeEditModal);
  document.getElementById('editDate').addEventListener('change', onEditDateChange);
  document.getElementById('editForm').addEventListener('submit', handleSaveEdit);

  // Modal de Nueva Cita
  document.getElementById('btnOpenNewModal').addEventListener('click', openNewModal);
  document.getElementById('btnCloseNewModal').addEventListener('click', closeNewModal);
  document.getElementById('btnCancelNew').addEventListener('click', closeNewModal);
  document.getElementById('newDate').addEventListener('change', onNewDateChange);
  document.getElementById('newForm').addEventListener('submit', handleSaveNew);

  // Modal de Gestión de Fechas
  const btnOpenDates = document.getElementById('btnOpenDatesModal');
  if (btnOpenDates) btnOpenDates.addEventListener('click', openDatesModal);
  const btnCloseDates = document.getElementById('btnCloseDatesModal');
  if (btnCloseDates) btnCloseDates.addEventListener('click', closeDatesModal);
  const btnDoneDates = document.getElementById('btnDoneDatesModal');
  if (btnDoneDates) btnDoneDates.addEventListener('click', closeDatesModal);
  const addDateForm = document.getElementById('addDateForm');
  if (addDateForm) addDateForm.addEventListener('submit', handleAddDate);

  // Auto-completar abreviatura de fecha
  const newDateIn = document.getElementById('newDateInput');
  if (newDateIn) {
    newDateIn.addEventListener('change', (e) => {
      const val = e.target.value;
      if (val) {
        const parts = val.split('-');
        if (parts.length === 3) {
          const shortIn = document.getElementById('newDateShortInput');
          if (shortIn && !shortIn.value) {
            shortIn.value = `${parts[2]}/${parts[1]}`;
          }
        }
      }
    });
  }

  // Cerrar modales al hacer clic en el fondo oscuro
  ['editModal', 'newModal', 'datesModal'].forEach(modalId => {
    const modalEl = document.getElementById(modalId);
    if (modalEl) {
      modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl) modalEl.classList.add('hidden');
      });
    }
  });

  // Notificación de descarga de respaldo
  const btnBackup = document.getElementById('btnDownloadBackup');
  if (btnBackup) {
    btnBackup.addEventListener('click', () => {
      showToast('📦 Generando y descargando copia de seguridad de la base de datos...', 'info');
    });
  }
}

// ==========================================
// GESTIÓN DINÁMICA DE FECHAS (MODAL Y API)
// ==========================================

async function openDatesModal() {
  document.getElementById('datesModal').classList.remove('hidden');
  await fetchDates();
}

function closeDatesModal() {
  document.getElementById('datesModal').classList.add('hidden');
}

async function fetchDates() {
  try {
    const res = await fetch('/api/dates');
    const data = await res.json();
    if (data.success) {
      if (state.config) state.config.dates = data.dates;
      updateDateDropdowns(data.dates);
      renderDatesTable(data.dates);
    }
  } catch (err) {
    console.error('Error al cargar fechas:', err);
    showToast('Error al cargar lista de fechas', 'error');
  }
}

function renderDatesTable(dates) {
  const tbody = document.getElementById('datesTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!dates || dates.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center py-6 text-slate-400">No hay fechas configuradas</td></tr>`;
    return;
  }

  dates.forEach(d => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-50 transition';

    const isActive = d.is_active === true || d.is_active === 1;
    const statusBadge = isActive
      ? `<span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800">Activa</span>`
      : `<span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-100 text-slate-600">Pausada</span>`;

    const actionBtn = isActive
      ? `<button onclick="toggleDateStatus('${d.id}', false)" class="px-2.5 py-1 text-[11px] font-bold rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-800 transition">Pausar</button>`
      : `<button onclick="toggleDateStatus('${d.id}', true)" class="px-2.5 py-1 text-[11px] font-bold rounded-lg bg-emerald-100 hover:bg-emerald-200 text-emerald-800 transition">Activar</button>`;

    tr.innerHTML = `
      <td class="py-2.5 px-3 font-mono font-semibold text-slate-800">${escapeHtml(d.id)}</td>
      <td class="py-2.5 px-3 font-medium text-slate-800">${escapeHtml(d.label)}</td>
      <td class="py-2.5 px-3 text-center text-slate-500">${escapeHtml(d.short || '-')}</td>
      <td class="py-2.5 px-3 text-center">${statusBadge}</td>
      <td class="py-2.5 px-3 text-right">${actionBtn}</td>
    `;
    tbody.appendChild(tr);
  });
}

// Global para los botones inline
window.toggleDateStatus = async function(dateId, newActive) {
  try {
    const res = await fetch(`/api/dates/${dateId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: newActive })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Fecha ${dateId} ${newActive ? 'activada' : 'pausada'} correctamente`, 'success');
      await fetchDates();
      await fetchStats();
    } else {
      showToast(`Error: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast('Error al actualizar estado de la fecha', 'error');
  }
};

async function handleAddDate(e) {
  e.preventDefault();
  const id = document.getElementById('newDateInput').value;
  const label = document.getElementById('newDateLabelInput').value;
  const short = document.getElementById('newDateShortInput').value;

  const btn = document.getElementById('btnSubmitAddDate');
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Guardando...`;

  try {
    const res = await fetch('/api/dates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, label, short })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Error al agregar fecha');
    }

    showToast(`✅ Fecha agregada: ${label} (${id})`, 'success');
    document.getElementById('addDateForm').reset();
    await fetchDates();
    await fetchStats();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-plus"></i> <span>Habilitar Fecha en WhatsApp y Panel</span>`;
  }
}

// ABRIR MODAL DE EDICIÓN Y REPROGRAMACIÓN
async function openEditModal(id) {
  try {
    const res = await fetch(`/api/appointments/${id}`);
    const data = await res.json();
    if (!data.success) {
      showToast('Error al cargar la cita', 'error');
      return;
    }

    const apt = data.appointment;
    document.getElementById('editId').value = apt.id;
    document.getElementById('editCandidateName').value = apt.candidate_name;
    document.getElementById('editPhoneNumber').value = apt.phone_number;
    document.getElementById('editPosition').value = apt.position;
    document.getElementById('editDate').value = apt.date;
    document.getElementById('editStatus').value = apt.status;
    document.getElementById('editNotes').value = apt.notes || '';
    document.getElementById('editNotifyCandidate').checked = true;

    // Cargar turnos disponibles para esa fecha incluyendo el turno actual de la cita
    await loadSlotsForSelect('editTimeSlot', apt.date, apt.time_slot);

    document.getElementById('editModal').classList.remove('hidden');
  } catch (err) {
    console.error('Error al abrir modal de edición:', err);
    showToast('No se pudo abrir la cita', 'error');
  }
}

function closeEditModal() {
  document.getElementById('editModal').classList.add('hidden');
}

// Al cambiar la fecha en el modal de edición, recalcular turnos libres
async function onEditDateChange(e) {
  const newDate = e.target.value;
  await loadSlotsForSelect('editTimeSlot', newDate, null);
}

// GUARDAR EDICIÓN Y REPROGRAMAR CON AVISO POR WHATSAPP
async function handleSaveEdit(e) {
  e.preventDefault();
  const id = document.getElementById('editId').value;
  const payload = {
    candidate_name: document.getElementById('editCandidateName').value,
    phone_number: document.getElementById('editPhoneNumber').value,
    position: document.getElementById('editPosition').value,
    date: document.getElementById('editDate').value,
    time_slot: document.getElementById('editTimeSlot').value,
    status: document.getElementById('editStatus').value,
    notes: document.getElementById('editNotes').value,
    notifyCandidate: document.getElementById('editNotifyCandidate').checked
  };

  const btn = document.getElementById('btnSaveEdit');
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Guardando y Notificando...`;

  try {
    const res = await fetch(`/api/appointments/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Error al actualizar cita');
    }

    closeEditModal();
    if (data.notificationSent) {
      showToast(`✅ Cita reprogramada y aviso enviado con éxito por WhatsApp a ${payload.candidate_name}`, 'success');
    } else if (payload.notifyCandidate) {
      showToast(`⚠️ Cita actualizada en sistema. (WhatsApp no envió mensaje: ${data.notificationError || 'no conectado'})`, 'warning');
    } else {
      showToast(`✅ Cita actualizada correctamente (sin notificación solicitada)`, 'success');
    }

    fetchAppointments();
    fetchStats();
  } catch (err) {
    console.error('Error guardando edición:', err);
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> <span>Guardar y Notificar</span>`;
  }
}

// ABRIR MODAL NUEVA CITA MANUAL
async function openNewModal() {
  document.getElementById('newName').value = '';
  document.getElementById('newPhone').value = '';
  document.getElementById('newNotes').value = '';
  const dateVal = document.getElementById('newDate').value || '2025-11-04';
  await loadSlotsForSelect('newTimeSlot', dateVal, null);
  document.getElementById('newModal').classList.remove('hidden');
}

function closeNewModal() {
  document.getElementById('newModal').classList.add('hidden');
}

async function onNewDateChange(e) {
  await loadSlotsForSelect('newTimeSlot', e.target.value, null);
}

async function handleSaveNew(e) {
  e.preventDefault();
  const payload = {
    candidate_name: document.getElementById('newName').value,
    phone_number: document.getElementById('newPhone').value,
    position: document.getElementById('newPosition').value,
    date: document.getElementById('newDate').value,
    time_slot: document.getElementById('newTimeSlot').value,
    notes: document.getElementById('newNotes').value,
    sendNotification: document.getElementById('newNotifyCandidate').checked
  };

  const btn = document.getElementById('btnSaveNew');
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Registrando...`;

  try {
    const res = await fetch('/api/appointments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Error al crear cita');
    }

    closeNewModal();
    showToast(`🎉 Cita agendada exitosamente para ${payload.candidate_name}`, 'success');
    fetchAppointments();
    fetchStats();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-check"></i> <span>Agendar Cita</span>`;
  }
}

// Cargar turnos en un select con indicador de disponibilidad
async function loadSlotsForSelect(selectId, date, currentSlot) {
  const select = document.getElementById(selectId);
  select.innerHTML = '<option value="">Cargando turnos...</option>';

  try {
    const res = await fetch(`/api/slots?date=${encodeURIComponent(date)}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    const availableSet = new Set(data.available);
    select.innerHTML = '';

    data.allSlots.forEach(slot => {
      const isAvailable = availableSet.has(slot);
      const isCurrent = slot === currentSlot;
      const time12 = formatTime12h(slot);

      const option = document.createElement('option');
      option.value = slot;

      if (isCurrent) {
        option.textContent = `⭐ ${time12} (${slot}) - Turno Actual Asignado`;
        option.selected = true;
      } else if (isAvailable) {
        option.textContent = `🟢 ${time12} (${slot}) - Disponible`;
      } else {
        option.textContent = `🔴 ${time12} (${slot}) - Ocupado`;
        option.disabled = true;
      }

      select.appendChild(option);
    });

    if (!currentSlot && data.available.length > 0) {
      select.value = data.available[0];
    }
  } catch (err) {
    console.error('Error cargando slots:', err);
    select.innerHTML = '<option value="">Error al cargar turnos</option>';
  }
}

// Reenviar notificación manual vía WhatsApp
async function resendNotification(id) {
  if (!confirm('¿Deseas reenviar el ticket y recordatorio de la entrevista por WhatsApp a este candidato?')) {
    return;
  }

  showToast('Enviando notificación por WhatsApp...', 'info');
  try {
    const res = await fetch(`/api/whatsapp/notify/${id}`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('✅ Mensaje enviado exitosamente vía WhatsApp', 'success');
      fetchAppointments();
    } else {
      showToast(`⚠️ No se pudo enviar: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast('Error de conexión al enviar WhatsApp', 'error');
  }
}

// Cancelar cita
async function cancelAppointment(id) {
  const reason = prompt('Ingrese el motivo de la cancelación de la cita:');
  if (reason === null) return;

  try {
    const res = await fetch(`/api/appointments/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason || 'Cancelado administrativamente', notifyCandidate: true })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Cita cancelada y cupo liberado', 'warning');
      fetchAppointments();
      fetchStats();
    } else {
      showToast(`Error: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast('Error cancelando la cita', 'error');
  }
}

// Sistema de Notificaciones Toast
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  
  let bgClass = 'bg-slate-900 text-white';
  let icon = '<i class="fa-solid fa-circle-info text-blue-400"></i>';

  if (type === 'success') {
    bgClass = 'bg-emerald-800 text-white';
    icon = '<i class="fa-solid fa-circle-check text-emerald-300"></i>';
  } else if (type === 'error') {
    bgClass = 'bg-red-800 text-white';
    icon = '<i class="fa-solid fa-triangle-exclamation text-red-300"></i>';
  } else if (type === 'warning') {
    bgClass = 'bg-amber-800 text-white';
    icon = '<i class="fa-solid fa-triangle-exclamation text-amber-300"></i>';
  }

  toast.className = `${bgClass} pointer-events-auto px-4 py-3 rounded-xl shadow-xl flex items-center space-x-3 text-sm animate-scaleIn border border-white/10 max-w-md`;
  toast.innerHTML = `
    <span class="text-base">${icon}</span>
    <span class="flex-1 font-medium">${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 250);
  }, 4500);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
