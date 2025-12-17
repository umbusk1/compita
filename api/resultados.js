// api/resultados.js - Gestión de resultados y casos
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // LISTAR RESULTADOS con filtros
    if (req.method === 'GET') {
      const {
        cliente_id,
        relevancia,
        seleccionado,
        analisis_id,
        limite = 100
      } = req.query;

      let query = `
        SELECT
          r.*,
          c.nombre as cliente_nombre,
          a.fecha_analisis
        FROM resultados r
        JOIN clientes c ON r.cliente_id = c.id
        JOIN analisis a ON r.analisis_id = a.id
        WHERE 1=1
      `;

      const params = [];
      let paramIndex = 1;

      if (cliente_id) {
        query += ` AND r.cliente_id = $${paramIndex}`;
        params.push(cliente_id);
        paramIndex++;
      }

      if (relevancia) {
        query += ` AND r.relevancia = $${paramIndex}`;
        params.push(relevancia);
        paramIndex++;
      }

      if (seleccionado !== undefined) {
        query += ` AND r.seleccionado = $${paramIndex}`;
        params.push(seleccionado === 'true');
        paramIndex++;
      }

      if (analisis_id) {
        query += ` AND r.analisis_id = $${paramIndex}`;
        params.push(analisis_id);
        paramIndex++;
      }

      query += ` ORDER BY r.created_at DESC LIMIT $${paramIndex}`;
      params.push(limite);

      const resultados = await sql(query, params);

      return res.status(200).json({
        success: true,
        total: resultados.length,
        resultados
      });
    }

    // ACTUALIZAR estado de un resultado
    if (req.method === 'PUT') {
      const { id, seleccionado, estado, notas } = req.body;

      if (!id) {
        return res.status(400).json({
          success: false,
          error: 'ID es requerido'
        });
      }

      const campos = [];
      const valores = [];
      let paramIndex = 1;

      if (seleccionado !== undefined) {
        campos.push(`seleccionado = $${paramIndex}`);
        valores.push(seleccionado);
        paramIndex++;
      }

      if (estado) {
        campos.push(`estado = $${paramIndex}`);
        valores.push(estado);
        paramIndex++;
      }

      if (notas !== undefined) {
        campos.push(`notas = $${paramIndex}`);
        valores.push(notas);
        paramIndex++;
      }

      if (campos.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No hay campos para actualizar'
        });
      }

      valores.push(id);
      const query = `
        UPDATE resultados
        SET ${campos.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING *
      `;

      const resultado = await sql(query, valores);

      if (resultado.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Resultado no encontrado'
        });
      }

      return res.status(200).json({
        success: true,
        resultado: resultado[0],
        mensaje: 'Resultado actualizado exitosamente'
      });
    }

    // MARCAR MÚLTIPLES resultados
    if (req.method === 'POST' && req.body.action === 'marcar_multiple') {
      const { ids, seleccionado = true } = req.body;

      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Debe proporcionar un array de IDs'
        });
      }

      await sql`
        UPDATE resultados
        SET seleccionado = ${seleccionado}
        WHERE id = ANY(${ids})
      `;

      return res.status(200).json({
        success: true,
        mensaje: `${ids.length} resultados actualizados`
      });
    }

    // OBTENER RESUMEN por cliente
    if (req.method === 'POST' && req.body.action === 'resumen_cliente') {
      const { cliente_id } = req.body;

      if (!cliente_id) {
        return res.status(400).json({
          success: false,
          error: 'cliente_id es requerido'
        });
      }

      const resumen = await sql`
        SELECT
          COUNT(*) as total_analizados,
          SUM(CASE WHEN relevancia = 'ALTA' THEN 1 ELSE 0 END) as total_alta,
          SUM(CASE WHEN relevancia = 'MEDIA' THEN 1 ELSE 0 END) as total_media,
          SUM(CASE WHEN relevancia = 'BAJA' THEN 1 ELSE 0 END) as total_baja,
          SUM(CASE WHEN seleccionado = true THEN 1 ELSE 0 END) as total_seleccionados,
          COUNT(DISTINCT analisis_id) as total_analisis
        FROM resultados
        WHERE cliente_id = ${cliente_id}
      `;

      return res.status(200).json({
        success: true,
        resumen: resumen[0]
      });
    }

    return res.status(405).json({ error: 'Método no permitido' });

  } catch (error) {
    console.error('Error en API resultados:', error);
    return res.status(500).json({
      success: false,
      error: 'Error del servidor: ' + error.message
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
