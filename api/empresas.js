// api/empresas.js - Gestión de empresas (antes clientes.js)
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);

  try {
    // ========== GET: Obtener empresas ==========
    if (req.method === 'GET') {
      const { id } = req.query;

      if (id) {
        const empresa = await sql`
          SELECT * FROM empresas WHERE id = ${id}
        `;

        if (empresa.length === 0) {
          return res.status(404).json({
            success: false,
            error: 'Empresa no encontrada'
          });
        }

        return res.status(200).json({
          success: true,
          empresa: empresa[0]
        });
      }

      const empresas = await sql`
        SELECT * FROM empresas
        WHERE activo = true
        ORDER BY nombre
      `;

      return res.status(200).json({
        success: true,
        empresas
      });
    }

    // ========== POST: Crear empresa ==========
    if (req.method === 'POST') {
      const {
        nombre,
        dominio,
        descripcion,
        palabras_clave,
        exclusiones,
        monto_minimo_alta
      } = req.body;

      if (!nombre) {
        return res.status(400).json({
          success: false,
          error: 'El nombre es requerido'
        });
      }

      const montoAlta = monto_minimo_alta || 500000;

      const result = await sql`
        INSERT INTO empresas (
          nombre,
          dominio,
          descripcion,
          palabras_clave,
          exclusiones,
          monto_minimo_alta,
          plan,
          activo
        )
        VALUES (
          ${nombre},
          ${dominio || ''},
          ${descripcion || ''},
          ${palabras_clave || []},
          ${exclusiones || []},
          ${montoAlta},
          'free_trial',
          true
        )
        RETURNING *
      `;

      return res.status(201).json({
        success: true,
        empresa: result[0]
      });
    }

    // ========== PUT: Actualizar empresa ==========
    if (req.method === 'PUT') {
      const { id } = req.query;
      const {
        nombre,
        dominio,
        descripcion,
        palabras_clave,
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
        UPDATE empresas
        SET
          nombre = ${nombre},
          dominio = ${dominio || ''},
          descripcion = ${descripcion || ''},
          palabras_clave = ${palabras_clave || []},
          exclusiones = ${exclusiones || []},
          monto_minimo_alta = ${monto_minimo_alta || 500000},
          activo = ${activo !== undefined ? activo : true},
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}
        RETURNING *
      `;

      if (result.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Empresa no encontrada'
        });
      }

      return res.status(200).json({
        success: true,
        empresa: result[0]
      });
    }

    // ========== DELETE: Desactivar empresa ==========
    if (req.method === 'DELETE') {
      const { id } = req.query;

      if (!id) {
        return res.status(400).json({
          success: false,
          error: 'ID requerido'
        });
      }

      const result = await sql`
        UPDATE empresas
        SET activo = false, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}
        RETURNING *
      `;

      if (result.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Empresa no encontrada'
        });
      }

      return res.status(200).json({
        success: true,
        mensaje: 'Empresa desactivada correctamente'
      });
    }

    return res.status(405).json({
      success: false,
      error: 'Método no permitido'
    });

  } catch (error) {
    console.error('Error en API empresas:', error);
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