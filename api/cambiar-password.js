// api/auth/cambiar-password.js - Cambio de contraseña
import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

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
    const { email, password_actual, password_nueva } = req.body;

    // ========== VALIDACIONES ==========
    
    if (!email || !password_actual || !password_nueva) {
      return res.status(400).json({
        success: false,
        error: 'Todos los campos son requeridos'
      });
    }

    if (password_nueva.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'La nueva contraseña debe tener al menos 8 caracteres'
      });
    }

    // ========== BUSCAR USUARIO ==========
    
    const usuarios = await sql`
      SELECT id, email, password_hash
      FROM usuarios 
      WHERE email = ${email.toLowerCase()}
    `;

    if (usuarios.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Usuario no encontrado'
      });
    }

    const usuario = usuarios[0];

    // ========== VERIFICAR CONTRASEÑA ACTUAL ==========
    
    const passwordValido = await bcrypt.compare(password_actual, usuario.password_hash);

    if (!passwordValido) {
      return res.status(401).json({
        success: false,
        error: 'La contraseña actual es incorrecta'
      });
    }

    // ========== HASHEAR NUEVA CONTRASEÑA ==========
    
    const salt = await bcrypt.genSalt(10);
    const nuevoPasswordHash = await bcrypt.hash(password_nueva, salt);

    // ========== ACTUALIZAR CONTRASEÑA ==========
    
    await sql`
      UPDATE usuarios
      SET 
        password_hash = ${nuevoPasswordHash},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${usuario.id}
    `;

    // ========== RESPUESTA EXITOSA ==========
    
    return res.status(200).json({
      success: true,
      mensaje: 'Contraseña actualizada correctamente'
    });

  } catch (error) {
    console.error('Error cambiando contraseña:', error);
    
    return res.status(500).json({
      success: false,
      error: 'Error al cambiar contraseña. Por favor intenta nuevamente.'
    });
  }
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
  },
  maxDuration: 10,
};