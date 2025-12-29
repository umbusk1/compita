// api/resetear-password.js - Cambiar contraseña con token
import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ 
      success: false, 
      error: 'Método no permitido' 
    });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({
        success: false,
        error: 'Token y contraseña son requeridos'
      });
    }

    // Validar longitud de contraseña
    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'La contraseña debe tener al menos 8 caracteres'
      });
    }

    // Verificar el token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET || 'compita-secret-2024');
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Token inválido o expirado. Solicita uno nuevo.'
      });
    }

    // Verificar que sea un token de recuperación
    if (decoded.tipo !== 'recuperacion') {
      return res.status(400).json({
        success: false,
        error: 'Token inválido'
      });
    }

    // Buscar usuario
    const usuarios = await sql`
      SELECT id, email, token_confirmacion 
      FROM usuarios 
      WHERE id = ${decoded.id}
      AND email = ${decoded.email}
    `;

    if (usuarios.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Usuario no encontrado'
      });
    }

    const usuario = usuarios[0];

    // Verificar que el token coincida con el guardado
    if (usuario.token_confirmacion !== token) {
      return res.status(400).json({
        success: false,
        error: 'Token inválido o ya fue usado'
      });
    }

    // Hashear nueva contraseña
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Actualizar contraseña y limpiar token
    await sql`
      UPDATE usuarios 
      SET 
        password_hash = ${passwordHash},
        token_confirmacion = NULL,
        updated_at = NOW()
      WHERE id = ${usuario.id}
    `;

    return res.status(200).json({
      success: true,
      mensaje: 'Contraseña actualizada exitosamente'
    });

  } catch (error) {
    console.error('Error reseteando password:', error);
    return res.status(500).json({
      success: false,
      error: 'Error al actualizar contraseña'
    });
  }
}

export const config = {
  maxDuration: 10,
};