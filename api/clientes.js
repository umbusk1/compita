// api/clientes.js - CRUD de clientes con umbral de monto
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);

  try {
    // ========== GET: Obtener clientes ==========
    if (req.method === 'GET') {
      const { id } = req.query;

      if (id) {
        const cliente = await sql`
          SELECT * FROM clientes WHERE id = ${id}
        `;

        if (cliente.length === 0) {
          return res.status(404).json({
            success: false,
            error: 'Cliente no encontrado'
          });
        }

        return res.status(200).json({
          success: true,
          cliente: cliente[0]
        });
      }

      const clientes = await sql`
        SELECT * FROM clientes
        ORDER BY nombre
      `;

      return res.status(200).json({
        success: true,
        clientes
      });
    }

    // ========== POST: Crear cliente ==========
    if (req.method === 'POST') {
      const {
        nombre,
        descripcion,
        criterios_alta,
        criterios_media,
        exclusiones,
        monto_minimo_alta
      } = req.body;

      if (!nombre) {
        return res.status(400).json({
          success: false,
          error: 'El nombre es requerido'
        });
      }

      const montoAlta = monto_minimo_alta || 1000000; // Default 1 millón

      const result = await sql`
        INSERT INTO clientes (
          nombre,
          descripcion,
          criterios_alta,
          criterios_media,
          exclusiones,
          monto_minimo_alta,
          activo
        )
        VALUES (
          ${nombre},
          ${descripcion || ''},
          ${criterios_alta || []},
          ${criterios_media || []},
          ${exclusiones || []},
          ${montoAlta},
          true
        )
        RETURNING *
      `;

      return res.status(201).json({
        success: true,
        cliente: result[0]
      });
    }

    // ========== PUT: Actualizar cliente ==========
    if (req.method === 'PUT') {
      const { id } = req.query;
      const {
        nombre,
        descripcion,
        criterios_alta,
        criterios_media,
        exclusiones,
        monto_minimo_alta,
        activo
      } = req.body;

      if (!id) {
        return res.status(400).json({
          success: false,
          error: 'ID requerido'
        });
      }

      const result = await sql`
        UPDATE clientes
        SET
          nombre = ${nombre},
          descripcion = ${descripcion || ''},
          criterios_alta = ${criterios_alta || []},
          criterios_media = ${criterios_media || []},
          exclusiones = ${exclusiones || []},
          monto_minimo_alta = ${monto_minimo_alta || 1000000},
          activo = ${activo !== undefined ? activo : true},
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}
        RETURNING *
      `;

      if (result.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Cliente no encontrado'
        });
      }

      return res.status(200).json({
        success: true,
        cliente: result[0]
      });
    }

    // ========== DELETE: Eliminar cliente ==========
    if (req.method === 'DELETE') {
      const { id } = req.query;

      if (!id) {
        return res.status(400).json({
          success: false,
          error: 'ID requerido'
        });
      }

      // Soft delete
      const result = await sql`
        UPDATE clientes
        SET activo = false, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}
        RETURNING *
      `;

      if (result.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Cliente no encontrado'
        });
      }

      return res.status(200).json({
        success: true,
        mensaje: 'Cliente eliminado correctamente'
      });
    }

    return res.status(405).json({
      success: false,
      error: 'Método no permitido'
    });

  } catch (error) {
    console.error('Error en API clientes:', error);
    return res.status(500).json({
      success: false,
      error: error.message
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