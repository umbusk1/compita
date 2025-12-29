// api/confirmar-email.js - Confirmar email del usuario
import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  
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
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Token de confirmación requerido'
      });
    }

    // Verificar el token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET || 'compita-secret-2024');
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Token inválido o expirado'
      });
    }

    // Buscar usuario con ese token
    const usuarios = await sql`
      SELECT id, email, email_confirmado 
      FROM usuarios 
      WHERE email = ${decoded.email} 
      AND token_confirmacion = ${token}
    `;

    if (usuarios.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Usuario no encontrado o token inválido'
      });
    }

    const usuario = usuarios[0];

    // Si ya está confirmado
    if (usuario.email_confirmado) {
      return res.status(200).json({
        success: true,
        mensaje: 'El email ya estaba confirmado',
        ya_confirmado: true
      });
    }

    // Confirmar el email
    await sql`
      UPDATE usuarios 
      SET 
        email_confirmado = true,
        token_confirmacion = NULL,
        updated_at = NOW()
      WHERE id = ${usuario.id}
    `;

    return res.status(200).json({
      success: true,
      mensaje: 'Email confirmado exitosamente',
      ya_confirmado: false
    });

  } catch (error) {
    console.error('Error confirmando email:', error);
    return res.status(500).json({
      success: false,
      error: 'Error al confirmar email'
    });
  }
}

export const config = {
  maxDuration: 10,
};