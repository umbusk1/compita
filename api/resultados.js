// api/resultados.js - Gestión de resultados con historial
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);

  try {
    // ========== GET: Obtener resultados ==========
    if (req.method === 'GET') {
      const { cliente_id, analisis_id, historial } = req.query;

      // CASO 1: Historial de análisis por cliente
      if (historial && cliente_id) {
        const analisis = await sql`
          SELECT
            id,
            created_at,
            total_descripciones,
            total_alta,
            total_media,
            total_baja,
            porcentaje_alta,
            notas
          FROM analisis
          WHERE cliente_id = ${cliente_id}
          ORDER BY created_at DESC
        `;

        return res.status(200).json({
          success: true,
          analisis
        });
      }

      // CASO 2: Resultados de un análisis específico
      if (analisis_id) {
        const resultados = await sql`
          SELECT * FROM resultados
          WHERE analisis_id = ${analisis_id}
          ORDER BY
            CASE
              WHEN relevancia = 'ALTA' THEN 1
              WHEN relevancia = 'MEDIA' THEN 2
              WHEN relevancia = 'BAJA' THEN 3
              ELSE 4
            END,
            id
        `;

        const analisisData = await sql`
          SELECT * FROM analisis WHERE id = ${analisis_id}
        `;

        if (analisisData.length === 0) {
          return res.status(404).json({
            success: false,
            error: 'Análisis no encontrado'
          });
        }

        const analisis = analisisData[0];

        // Calcular estadísticas correctas desde resultados
        const descartadas = resultados.filter(r => r.que === 'Descartada').length;
        const noDescartadas = resultados.filter(r => r.que !== 'Descartada').length;

        return res.status(200).json({
          success: true,
          estadisticas: {
            total: analisis.total_descripciones,
            alta: analisis.total_alta,
            media: analisis.total_media,
            baja: analisis.total_baja,
            descartadas_prefiltro: descartadas,
            analizadas_ia: noDescartadas
          },
          resultados
        });
      }

      // CASO 3: Todos los resultados de un cliente (último análisis)
      if (cliente_id) {
        const ultimoAnalisis = await sql`
          SELECT id FROM analisis
          WHERE cliente_id = ${cliente_id}
          ORDER BY created_at DESC
          LIMIT 1
        `;

        if (ultimoAnalisis.length === 0) {
          return res.status(200).json({
            success: true,
            estadisticas: {
              total: 0,
              alta: 0,
              media: 0,
              baja: 0,
              descartadas_prefiltro: 0,
              analizadas_ia: 0
            },
            resultados: [],
            mensaje: 'No hay análisis previos'
          });
        }

        const analisisId = ultimoAnalisis[0].id;

        const resultados = await sql`
          SELECT * FROM resultados
          WHERE analisis_id = ${analisisId}
          ORDER BY
            CASE
              WHEN relevancia = 'ALTA' THEN 1
              WHEN relevancia = 'MEDIA' THEN 2
              WHEN relevancia = 'BAJA' THEN 3
              ELSE 4
            END,
            id
        `;

        const analisisData = await sql`
          SELECT * FROM analisis WHERE id = ${analisisId}
        `;

        const analisis = analisisData[0];

        return res.status(200).json({
          success: true,
          analisis_reciente: analisis,
          estadisticas: {
            total: analisis.total_descripciones,
            alta: analisis.total_alta,
            media: analisis.total_media,
            baja: analisis.total_baja,
            descartadas_prefiltro: resultados.filter(r =>
              r.que === 'Descartada'
            ).length,
            analizadas_ia: resultados.filter(r =>
              r.que !== 'Descartada'
            ).length
          },
          resultados
        });
      }

      return res.status(400).json({
        success: false,
        error: 'Parámetros insuficientes'
      });
    }

    // ========== DELETE: Eliminar análisis ==========
    if (req.method === 'DELETE') {
      const { analisis_id } = req.query;

      if (!analisis_id) {
        return res.status(400).json({
          success: false,
          error: 'analisis_id requerido'
        });
      }

      // Primero eliminar los resultados
      await sql`DELETE FROM resultados WHERE analisis_id = ${analisis_id}`;

      // Luego eliminar el análisis
      await sql`DELETE FROM analisis WHERE id = ${analisis_id}`;

      return res.status(200).json({
        success: true,
        mensaje: 'Análisis eliminado correctamente'
      });
    }

    return res.status(405).json({
      success: false,
      error: 'Método no permitido'
    });

  } catch (error) {
    console.error('Error en API resultados:', error);
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
