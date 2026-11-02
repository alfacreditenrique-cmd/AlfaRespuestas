#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const whatsappService = require('../src/whatsapp');
const { dispatcher } = require('../src/dispatcher');

async function main() {
  console.log('=======================================================');
  console.log('🚀 INICIANDO CONEXIÓN EN VIVO CON WHATSAPP Y DESPACHO');
  console.log('=======================================================');

  // 1. Iniciar socket en vivo
  console.log('📡 Conectando a WhatsApp...');
  await whatsappService.start();

  // 2. Esperar conexión CONNECTED (hasta 25 segundos)
  let attempts = 0;
  while (attempts < 25) {
    const status = whatsappService.getStatus();
    if (status.status === 'CONNECTED' && whatsappService.sock) {
      console.log(`✅ Conectado exitosamente como: ${status.connectionInfo?.name || 'ALFACREDIT'} (${status.connectionInfo?.id})`);
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
    attempts++;
  }

  const finalStatus = whatsappService.getStatus();
  if (finalStatus.status !== 'CONNECTED' || !whatsappService.sock) {
    console.error('❌ Error: No se pudo establecer conexión en vivo con WhatsApp. Estado:', finalStatus.status);
    process.exit(1);
  }

  // 3. Ejecutar despacho en vivo
  console.log('📨 Iniciando transmisión de los 20 mensajes en modo LIVE_SOCKET...');
  const results = await dispatcher.dispatch();

  console.log('\n=======================================================');
  console.log(`✅ DESPACHO EN VIVO FINALIZADO: ${results.summary.sent} enviados, ${results.summary.failed} fallidos`);
  console.log(`📡 Modo de ejecución: ${results.summary.mode}`);
  console.log('=======================================================');

  // Guardar log de resultados en vivo
  fs.writeFileSync(
    path.join(__dirname, '..', 'data', 'live_dispatch_results.json'),
    JSON.stringify(results, null, 2),
    'utf8'
  );

  // Mantener el socket abierto 5 segundos más para asegurar el flush de ACKs
  await new Promise(r => setTimeout(r, 5000));
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error en despacho en vivo:', err);
  process.exit(1);
});
