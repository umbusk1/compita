// api/empresa.js
// Gestión del perfil de empresa del usuario logueado (GET y POST)
import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
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

    // ========== GET: Obtener empresa del usuario ==========
    if (req.method === 'GET') {
      const empresa = await sql`
        SELECT
          e.id,
          e.nombre,
          e.dominio,
          e.descripcion,
          e.palabras_clave,
          e.exclusiones,
          e.monto_minimo_alta,
          e.plan,
          e.trial_inicio,
          e.trial_fin,
          e.activo
        FROM empresas e
        WHERE e.id = ${decoded.empresa_id}
        LIMIT 1
      `;

      if (empresa.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Empresa no encontrada'
        });
      }

      const empresaData = empresa[0];

      // Convertir palabras_clave de array a string si es necesario
      let palabrasClaveStr = empresaData.palabras_clave;
      if (Array.isArray(palabrasClaveStr)) {
        palabrasClaveStr = palabrasClaveStr.join(', ');
      }

      // Convertir exclusiones de array a string si es necesario
      let exclusionesStr = empresaData.exclusiones;
      if (Array.isArray(exclusionesStr)) {
        exclusionesStr = exclusionesStr.join(', ');
      }

      return res.status(200).json({
        success: true,
        empresa: {
          id: empresaData.id,
          nombre: empresaData.nombre,
          dominio: empresaData.dominio,
          descripcion: empresaData.descripcion || '',
          palabras_clave: palabrasClaveStr || '',
          exclusiones: exclusionesStr || '',
          monto_minimo_alta: empresaData.monto_minimo_alta || 500000,
          plan: empresaData.plan,
          trial_inicio: empresaData.trial_inicio,
          trial_fin: empresaData.trial_fin,
          activo: empresaData.activo
        }
      });
    }

    // ========== POST: Actualizar empresa del usuario ==========
    if (req.method === 'POST') {
      const { nombre, descripcion, palabras_clave, exclusiones, monto_minimo_alta } = req.body;

      if (!nombre || nombre.trim().length === 0) {
        return res.status(400).json({
          success: false,
          error: 'El nombre de la empresa es requerido'
        });
      }

      const resultado = await sql`
        UPDATE empresas
        SET
          nombre = ${nombre.trim()},
          descripcion = ${descripcion?.trim() || ''},
          palabras_clave = ${palabras_clave || []},
          exclusiones = ${exclusiones || []},
          monto_minimo_alta = ${monto_minimo_alta || 500000}
        WHERE id = ${decoded.empresa_id}
        RETURNING id, nombre, descripcion, palabras_clave, exclusiones, monto_minimo_alta
      `;

      if (resultado.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Empresa no encontrada'
        });
      }

      return res.status(200).json({
        success: true,
        mensaje: 'Perfil actualizado correctamente',
        empresa: resultado[0]
      });
    }

    return res.status(405).json({
      success: false,
      error: 'Método no permitido'
    });

  } catch (error) {
    console.error('Error en API empresa:', error);
    return res.status(500).json({
      success: false,
      error: 'Error al procesar solicitud'
    });
  }
}

export const config = {
  maxDuration: 10,
};