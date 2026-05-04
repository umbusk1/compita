// api/resultados.js - Gestión de resultados con empresas
import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);

  try {

    // ========== POST: Guardar u obtener análisis de pliego ==========
    if (req.method === 'POST') {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Token no proporcionado' });
      }
      let decoded;
      try {
        decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
      } catch {
        return res.status(401).json({ success: false, error: 'Token invalido' });
      }
      const empresaId = decoded.empresaId;
      const { action, referencia, analisis } = req.body || {};

      // Guardar análisis de pliego (llamado desde oportunidades.html tras analizar)
      if (action === 'guardar_analisis_pliego') {
        if (!referencia || !analisis) {
          return res.status(400).json({ success: false, error: 'referencia y analisis requeridos' });
        }
        await sql`
          INSERT INTO analisis_pliegos (empresa_id, referencia, analisis_json)
          VALUES (${empresaId}, ${referencia}, ${JSON.stringify(analisis)})
          ON CONFLICT (empresa_id, referencia)
          DO UPDATE SET analisis_json = ${JSON.stringify(analisis)}, creado_en = NOW()
        `;
        return res.status(200).json({ success: true });
      }

      // Obtener análisis de pliego (llamado por el Coach antes de invocar a Claude)
      if (action === 'obtener_analisis_pliego') {
        if (!referencia) {
          return res.status(400).json({ success: false, error: 'referencia requerida' });
        }
        const rows = await sql`
          SELECT analisis_json, creado_en
          FROM analisis_pliegos
          WHERE empresa_id = ${empresaId} AND referencia = ${referencia}
          LIMIT 1
        `;
        if (rows.length === 0) {
          return res.status(200).json({ success: true, analisis: null });
        }
        return res.status(200).json({
          success: true,
          analisis: JSON.parse(rows[0].analisis_json),
          creado_en: rows[0].creado_en
        });
      }

      return res.status(400).json({ success: false, error: 'action no reconocida' });
    }

    // ========== GET: Obtener resultados ==========
    if (req.method === 'GET') {
      const { empresa_id, analisis_id, historial } = req.query;

      // CASO 1: Historial de análisis por empresa
      if (historial && empresa_id) {
        const analisis = await sql`
          SELECT
            id, created_at, total_descripciones,
            total_alta, total_media, total_baja,
            porcentaje_alta, notas
          FROM analisis
          WHERE empresa_id = ${empresa_id}
          ORDER BY created_at DESC
        `;
        return res.status(200).json({ success: true, analisis });
      }

      // CASO 2: Resultados de un análisis específico
      if (analisis_id) {
        const resultados = await sql`
          SELECT * FROM resultados
          WHERE analisis_id = ${analisis_id}
          ORDER BY
            CASE
              WHEN relevancia = 'ALTA'      THEN 1
              WHEN relevancia = 'MEDIA'     THEN 2
              WHEN relevancia = 'BAJA'      THEN 3
              WHEN relevancia = 'DESCARTADA' THEN 4
              ELSE 5
            END, id
        `;
        const analisisData = await sql`SELECT * FROM analisis WHERE id = ${analisis_id}`;
        if (analisisData.length === 0) {
          return res.status(404).json({ success: false, error: 'Analisis no encontrado' });
        }
        const analisis = analisisData[0];
        const descartadas  = resultados.filter(r => r.relevancia === 'DESCARTADA').length;
        const analizadasIA = resultados.filter(r => ['ALTA','MEDIA','BAJA'].includes(r.relevancia)).length;
        return res.status(200).json({
          success: true,
          estadisticas: {
            total: analisis.total_descripciones, alta: analisis.total_alta,
            media: analisis.total_media, baja: analisis.total_baja,
            descartadas_prefiltro: descartadas, analizadas_ia: analizadasIA
          },
          resultados
        });
      }

      // CASO 3: Todos los resultados de una empresa (último análisis)
      if (empresa_id) {
        const ultimoAnalisis = await sql`
          SELECT id FROM analisis
          WHERE empresa_id = ${empresa_id}
          ORDER BY created_at DESC LIMIT 1
        `;
        if (ultimoAnalisis.length === 0) {
          return res.status(200).json({
            success: true,
            estadisticas: { total:0, alta:0, media:0, baja:0, descartadas_prefiltro:0, analizadas_ia:0 },
            resultados: [],
            mensaje: 'No hay analisis previos'
          });
        }
        const analisisId = ultimoAnalisis[0].id;
        const resultados = await sql`
          SELECT * FROM resultados
          WHERE analisis_id = ${analisisId}
          ORDER BY
            CASE
              WHEN relevancia = 'ALTA'      THEN 1
              WHEN relevancia = 'MEDIA'     THEN 2
              WHEN relevancia = 'BAJA'      THEN 3
              WHEN relevancia = 'DESCARTADA' THEN 4
              ELSE 5
            END, id
        `;
        const analisisData = await sql`SELECT * FROM analisis WHERE id = ${analisisId}`;
        const analisis = analisisData[0];
        const descartadas  = resultados.filter(r => r.relevancia === 'DESCARTADA').length;
        const analizadasIA = resultados.filter(r => ['ALTA','MEDIA','BAJA'].includes(r.relevancia)).length;
        return res.status(200).json({
          success: true,
          analisis_reciente: analisis,
          estadisticas: {
            total: analisis.total_descripciones, alta: analisis.total_alta,
            media: analisis.total_media, baja: analisis.total_baja,
            descartadas_prefiltro: descartadas, analizadas_ia: analizadasIA
          },
          resultados
        });
      }

      return res.status(400).json({ success: false, error: 'Parametros insuficientes' });
    }

    // ========== DELETE: Eliminar análisis ==========
    if (req.method === 'DELETE') {
      const { analisis_id } = req.query;
      if (!analisis_id) {
        return res.status(400).json({ success: false, error: 'analisis_id requerido' });
      }
      await sql`DELETE FROM resultados WHERE analisis_id = ${analisis_id}`;
      await sql`DELETE FROM analisis   WHERE id          = ${analisis_id}`;
      return res.status(200).json({ success: true, mensaje: 'Analisis eliminado correctamente' });
    }

    return res.status(405).json({ success: false, error: 'Metodo no permitido' });

  } catch (error) {
    console.error('Error en API resultados:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export const config = {
  api: { bodyParser: { sizeLimit: '2mb' } },
  maxDuration: 10,
};