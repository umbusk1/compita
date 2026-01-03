// api/usuario.js - Obtener datos del usuario autenticado
import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      error: 'Método no permitido'
    });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // ========== VERIFICAR TOKEN ==========
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'No autorizado'
      });
    }

    const token = authHeader.split(' ')[1];
    let decoded;
    
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET || 'compita-secret-2024');
    } catch (error) {
      return res.status(401).json({
        success: false,
        error: 'Token inválido'
      });
    }

    // ========== OBTENER DATOS DEL USUARIO Y EMPRESA ==========
    const resultado = await sql`
      SELECT 
        u.id,
        u.email,
        u.empresa,
        u.rol,
        u.email_confirmado,
        u.activo,
        u.created_at,
        e.id as empresa_id,
        e.nombre as empresa_nombre,
        e.plan,
        e.trial_inicio,
        e.trial_fin,
        e.activo as empresa_activa
      FROM usuarios u
      JOIN empresas e ON u.empresa_id = e.id
      WHERE u.email = ${decoded.email}
      LIMIT 1
    `;

    if (resultado.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Usuario no encontrado'
      });
    }

    const usuario = resultado[0];

    // ========== VERIFICAR SI EL TRIAL EXPIRÓ ==========
    const ahora = new Date();
    const trialFin = new Date(usuario.trial_fin);
    const trialExpirado = usuario.plan === 'free_trial' && ahora > trialFin;

    // ========== RESPUESTA ==========
    return res.status(200).json({
      success: true,
      id: usuario.id,
      email: usuario.email,
      empresa: usuario.empresa_nombre,
      empresa_id: usuario.empresa_id,
      rol: usuario.rol,
      plan: usuario.plan,
      trial_inicio: usuario.trial_inicio,
      trial_fin: usuario.trial_fin,
      trial_expirado: trialExpirado,
      email_confirmado: usuario.email_confirmado,
      activo: usuario.activo && usuario.empresa_activa
    });

  } catch (error) {
    console.error('Error obteniendo usuario:', error);
    return res.status(500).json({
      success: false,
      error: 'Error al obtener datos del usuario'
    });
  }
}

export const config = {
  maxDuration: 5,
};