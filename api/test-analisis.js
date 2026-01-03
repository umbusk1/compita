// TEMPORAL - Solo para poblar BD inicial
// BORRAR después de usar

import handler from './analizar-notificar-v2.js';

export default async function testHandler(req, res) {
  // Simular autenticación válida
  req.headers.authorization = `Bearer ${process.env.CRON_SECRET}`;
  
  // Ejecutar el handler original
  return handler(req, res);
}

export const config = {
  maxDuration: 300,
};