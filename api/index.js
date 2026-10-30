// Punto de entrada serverless para Vercel
process.env.VERCEL = process.env.VERCEL || '1';
process.env.SERVERLESS = 'true';
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp';
process.env.DISABLE_TUNNEL = 'true';

let appInstance = null;
let initError = null;

try {
  const serverModule = require('../src/server');
  appInstance = serverModule.app;
} catch (err) {
  initError = err;
  console.error('Fatal initialization error in Vercel Serverless:', err);
}

function handler(req, res) {
  if (initError) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      error: 'Vercel Serverless Initialization Error',
      message: initError.message,
      stack: initError.stack
    }, null, 2));
  }
  return appInstance(req, res);
}

// Compatibilidad con Express y tests
handler.listen = function (...args) {
  if (!appInstance) {
    throw initError || new Error('App instance not initialized');
  }
  return appInstance.listen(...args);
};

handler.app = appInstance;
handler.default = handler;

module.exports = handler;
