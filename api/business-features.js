// api/business-features.js - Gestión de recursos Business (ZIP y Análisis IA)
import { neon } from '@neondatabase/serverless';

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
    // ========== OBTENER EMPRESA_ID Y ACCIÓN ==========
    const { empresa_id, tipo, accion, referencia } = req.body;

    if (!empresa_id) {
      return res.status(400).json({ success: false, error: 'Falta empresa_id' });
    }

    // ========== OBTENER DATOS DE LA EMPRESA ==========
    const empresa = await sql`
      SELECT plan, limite_zips_mes, limite_analisis_mes
      FROM empresas
      WHERE id = ${empresa_id}
      LIMIT 1
    `;

    if (empresa.length === 0) {
      return res.status(404).json({ success: false, error: 'Empresa no encontrada' });
    }

    const { plan, limite_zips_mes, limite_analisis_mes } = empresa[0];

    // ========== VERIFICAR QUE SEA PLAN BUSINESS O ENTERPRISE ==========
    if (!['business', 'enterprise'].includes(plan)) {
      return res.status(403).json({
        success: false,
        error: 'Esta funcionalidad está disponible solo para planes Business y Enterprise',
        upgrade_required: true
      });
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
    // ACCIÓN: VALIDAR CUPO
    // ====================================================
    if (accion === 'validar') {
      let cupoDisponible = false;
      let cuposRestantes = 0;

      if (tipo === 'zip') {
        cuposRestantes = limite_zips_mes - uso.descargas_zip_usadas;
        cupoDisponible = cuposRestantes > 0;
      } else if (tipo === 'analisis') {
        cuposRestantes = limite_analisis_mes - uso.analisis_ia_usados;
        cupoDisponible = cuposRestantes > 0;
      }

      return res.status(200).json({
        success: true,
        permitido: cupoDisponible,
        cupos_restantes: Math.max(0, cuposRestantes),
        tipo: tipo
      });
    }

    // ====================================================
    // ACCIÓN: REGISTRAR USO DE CUPO
    // ====================================================
    if (accion === 'registrar') {
      if (tipo === 'zip') {
        // Verificar límite
        if (uso.descargas_zip_usadas >= limite_zips_mes) {
          return res.status(403).json({
            success: false,
            error: 'Límite alcanzado',
            cupos_disponibles: 0
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
          cupos_restantes: limite_zips_mes - uso.descargas_zip_usadas - 1
        });
      }

      if (tipo === 'analisis') {
        // Verificar límite
        if (uso.analisis_ia_usados >= limite_analisis_mes) {
          return res.status(403).json({
            success: false,
            error: 'Límite alcanzado',
            cupos_disponibles: 0
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
          cupos_restantes: limite_analisis_mes - uso.analisis_ia_usados - 1
        });
      }
    }

    // Si llegamos aquí, falta algún parámetro
    return res.status(400).json({
      success: false,
      error: 'Parámetros inválidos. Se requiere: empresa_id, tipo (zip/analisis), accion (validar/registrar)'
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