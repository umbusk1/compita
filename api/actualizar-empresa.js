// api/actualizar-empresa.js
// Actualiza el perfil de la empresa del usuario logueado
import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');

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

    // ========== VALIDAR DATOS ==========
    const { nombre, descripcion, palabras_clave, exclusiones, monto_minimo_alta } = req.body;

    if (!nombre || nombre.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'El nombre de la empresa es requerido'
      });
    }

    // ========== ACTUALIZAR EMPRESA ==========
    // IMPORTANTE: Actualizar SOLO la empresa del usuario logueado (empresa_id del token)
    
    const resultado = await sql`
      UPDATE empresas
      SET
        nombre = ${nombre.trim()},
        descripcion = ${descripcion?.trim() || ''},
        palabras_clave = ${palabras_clave || []},
        exclusiones = ${exclusiones || []},
        monto_minimo_alta = ${monto_minimo_alta || 500000},
        actualizado_en = NOW()
      WHERE id = ${decoded.empresa_id}
      RETURNING id, nombre, descripcion, palabras_clave, exclusiones, monto_minimo_alta
    `;

    if (resultado.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Empresa no encontrada'
      });
    }

    // ========== RESPUESTA ==========
    return res.status(200).json({
      success: true,
      mensaje: 'Perfil actualizado correctamente',
      empresa: resultado[0]
    });

  } catch (error) {
    console.error('Error actualizando empresa:', error);
    return res.status(500).json({
      success: false,
      error: 'Error al actualizar empresa'
    });
  }
}

export const config = {
  maxDuration: 10,
};