// api/business-features.js - Gestión de recursos Business (ZIP y Análisis IA)
import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  // CORS
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
      return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    const token = authHeader.split(' ')[1];
    let decoded;

    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET || 'compita-secret-2024');
    } catch (error) {
      return res.status(401).json({ success: false, error: 'Token inválido' });
    }

    // ========== OBTENER DATOS DEL USUARIO ==========
    const usuario = await sql`
      SELECT u.id, u.empresa_id, e.plan, e.limite_zips_mes, e.limite_analisis_mes
      FROM usuarios u
      JOIN empresas e ON u.empresa_id = e.id
      WHERE u.email = ${decoded.email}
      LIMIT 1
    `;

    if (usuario.length === 0) {
      return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    }

    const { empresa_id, plan, limite_zips_mes, limite_analisis_mes } = usuario[0];

    // ========== VERIFICAR QUE SEA PLAN BUSINESS O ENTERPRISE ==========
    if (!['business', 'enterprise'].includes(plan)) {
      return res.status(403).json({
        success: false,
        error: 'Esta funcionalidad está disponible solo para planes Business y Enterprise',
        upgrade_required: true
      });
    }

    // ========== DETERMINAR ACCIÓN ==========
    const action = req.method === 'GET' ? req.query.action : req.body?.action;

    if (!action) {
      return res.status(400).json({ success: false, error: 'Falta parámetro "action"' });
    }

    // ========== OBTENER MES ACTUAL ==========
    const primerDiaMes = new Date();
    primerDiaMes.setDate(1);
    primerDiaMes.setHours(0, 0, 0, 0);
    const mesActual = primerDiaMes.toISOString().split('T')[0]; // YYYY-MM-01

    // ========== OBTENER O CREAR REGISTRO DE USO MENSUAL ==========
    let usoMensual = await sql`
      SELECT * FROM uso_mensual
      WHERE empresa_id = ${empresa_id} AND mes = ${mesActual}
      LIMIT 1
    `;

    if (usoMensual.length === 0) {
      // Crear registro para este mes
      usoMensual = await sql`
        INSERT INTO uso_mensual (empresa_id, mes, descargas_zip_usadas, analisis_ia_usados)
        VALUES (${empresa_id}, ${mesActual}, 0, 0)
        RETURNING *
      `;
    }

    const uso = usoMensual[0];

    // ====================================================
    // ACCIÓN 1: Verificar cupos disponibles (GET)
    // ====================================================
    if (action === 'verificar-cupos') {
      return res.status(200).json({
        success: true,
        plan: plan,
        cupos: {
          zip: {
            usados: uso.descargas_zip_usadas,
            limite: limite_zips_mes,
            disponibles: Math.max(0, limite_zips_mes - uso.descargas_zip_usadas)
          },
          analisis_ia: {
            usados: uso.analisis_ia_usados,
            limite: limite_analisis_mes,
            disponibles: Math.max(0, limite_analisis_mes - uso.analisis_ia_usados)
          }
        },
        mes_actual: mesActual
      });
    }

    // ====================================================
    // ACCIÓN 2: Usar cupo de descarga ZIP (POST)
    // ====================================================
    if (action === 'usar-zip') {
      const { referencia } = req.body;

      if (!referencia) {
        return res.status(400).json({ success: false, error: 'Falta referencia de licitación' });
      }

      // Verificar si tiene cupo disponible
      if (uso.descargas_zip_usadas >= limite_zips_mes) {
        return res.status(403).json({
          success: false,
          error: 'Has alcanzado el límite de descargas ZIP para este mes',
          cupos_disponibles: 0,
          limite: limite_zips_mes,
          usados: uso.descargas_zip_usadas
        });
      }

      // Incrementar contador
      await sql`
        UPDATE uso_mensual
        SET descargas_zip_usadas = descargas_zip_usadas + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE empresa_id = ${empresa_id} AND mes = ${mesActual}
      `;

      return res.status(200).json({
        success: true,
        message: 'Descarga ZIP registrada',
        cupos_restantes: limite_zips_mes - uso.descargas_zip_usadas - 1,
        referencia: referencia
      });
    }

    // ====================================================
    // ACCIÓN 3: Usar cupo de análisis IA (POST)
    // ====================================================
    if (action === 'usar-analisis') {
      const { referencia, licitacion_id } = req.body;

      if (!referencia || !licitacion_id) {
        return res.status(400).json({
          success: false,
          error: 'Faltan parámetros: referencia y licitacion_id'
        });
      }

      // Verificar si tiene cupo disponible
      if (uso.analisis_ia_usados >= limite_analisis_mes) {
        return res.status(403).json({
          success: false,
          error: 'Has alcanzado el límite de análisis IA para este mes',
          cupos_disponibles: 0,
          limite: limite_analisis_mes,
          usados: uso.analisis_ia_usados
        });
      }

      // Incrementar contador
      await sql`
        UPDATE uso_mensual
        SET analisis_ia_usados = analisis_ia_usados + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE empresa_id = ${empresa_id} AND mes = ${mesActual}
      `;

      return res.status(200).json({
        success: true,
        message: 'Análisis IA registrado',
        cupos_restantes: limite_analisis_mes - uso.analisis_ia_usados - 1,
        referencia: referencia,
        licitacion_id: licitacion_id
      });
    }

    // ====================================================
    // ACCIÓN 4: Consultar historial de uso (GET)
    // ====================================================
    if (action === 'historial') {
      const historial = await sql`
        SELECT
          mes,
          descargas_zip_usadas,
          analisis_ia_usados,
          created_at,
          updated_at
        FROM uso_mensual
        WHERE empresa_id = ${empresa_id}
        ORDER BY mes DESC
        LIMIT 12
      `;

      return res.status(200).json({
        success: true,
        historial: historial,
        limites_actuales: {
          zips: limite_zips_mes,
          analisis: limite_analisis_mes
        }
      });
    }

    // Si llegamos aquí, el action no es válido
    return res.status(400).json({
      success: false,
      error: 'Acción inválida. Use: verificar-cupos, usar-zip, usar-analisis, historial'
    });

  } catch (error) {
    console.error('Error en business-features:', error);
    return res.status(500).json({
      success: false,
      error: 'Error al procesar solicitud',
      detalles: error.message
    });
  }
}

export const config = {
  maxDuration: 10,
};