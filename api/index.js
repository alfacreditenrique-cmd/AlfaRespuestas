// Punto de entrada serverless para Vercel
process.env.VERCEL = process.env.VERCEL || '1';
process.env.SERVERLESS = 'true';
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp';
process.env.DISABLE_TUNNEL = 'true';

const { app } = require('../src/server');

module.exports = app;
module.exports.default = app;
