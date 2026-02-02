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
    // ACCIÓN: VERIFICAR LÍMITES (para widget)
    // ====================================================
    if (accion === 'verificar-limites') {
      return res.status(200).json({
        success: true,
        zip_usados: uso.descargas_zip_usadas,
        zip_limite: limite_zips_mes,
        zip_disponibles: Math.max(0, limite_zips_mes - uso.descargas_zip_usadas),
        analisis_usados: uso.analisis_ia_usados,
        analisis_limite: limite_analisis_mes,
        analisis_disponibles: Math.max(0, limite_analisis_mes - uso.analisis_ia_usados)
      });
    }

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
// ====================================================
    // ACCIÓN: RE-ANALIZAR OPORTUNIDADES
    // ====================================================
    if (accion === 're-analizar') {
      // 1. Obtener perfil actualizado de la empresa
      const perfilEmpresa = await sql`
        SELECT
          palabras_clave,
          exclusiones,
          familias_unspsc,
          monto_minimo_alta
        FROM empresas
        WHERE id = ${empresa_id}
        LIMIT 1
      `;

      if (perfilEmpresa.length === 0) {
        return res.status(404).json({ success: false, error: 'Perfil de empresa no encontrado' });
      }

      const perfil = perfilEmpresa[0];
      const palabrasClave = perfil.palabras_clave || [];
      const exclusiones = perfil.exclusiones || [];
      const familiasUNSPSC = perfil.familias_unspsc || [];
      const montoMinimoAlta = perfil.monto_minimo_alta || 500000;

      // 2. Obtener licitaciones ABIERTAS (fecha_presentacion en el futuro)
      const hoy = new Date().toISOString();
      const licitacionesAbiertas = await sql`
        SELECT
          l.id as licitacion_id,
          l.referencia,
          l.que,
          l.monto_estimado,
          l.categorias,
          l.fecha_presentacion
        FROM licitaciones l
        WHERE l.fecha_presentacion > ${hoy}
        ORDER BY l.fecha_presentacion ASC
      `;

      if (licitacionesAbiertas.length === 0) {
        return res.status(200).json({
          success: true,
          message: 'No hay licitaciones abiertas para analizar',
          analizadas: 0
        });
      }

      // 3. Re-calcular relevancia para cada licitación
      let contadorAlta = 0;
      let contadorMedia = 0;
      let contadorDescartadas = 0;

      for (const licitacion of licitacionesAbiertas) {
        const texto = `${licitacion.referencia} ${licitacion.que}`.toLowerCase();
        const monto = parseFloat(licitacion.monto_estimado) || 0;
        const categoriasLic = licitacion.categorias || [];

        // A. Verificar exclusiones (descartada)
        let esDescartada = false;
        for (const excl of exclusiones) {
          if (texto.includes(excl.toLowerCase())) {
            esDescartada = true;
            break;
          }
        }

        if (esDescartada) {
          // Eliminar de oportunidades_empresas si existe
          await sql`
            DELETE FROM oportunidades_empresas
            WHERE empresa_id = ${empresa_id}
            AND licitacion_id = ${licitacion.licitacion_id}
          `;
          contadorDescartadas++;
          continue;
        }

        // B. Calcular relevancia
        let relevancia = null;
        let razon = '';

        // B.1. Verificar familias UNSPSC (ALTA)
        let coincideFamilia = false;
        for (const familia of familiasUNSPSC) {
          if (categoriasLic.includes(familia)) {
            coincideFamilia = true;
            razon = `Coincide con categoría UNSPSC ${familia}`;
            break;
          }
        }

        if (coincideFamilia) {
          relevancia = 'ALTA';
          contadorAlta++;
        } else {
          // B.2. Verificar palabras clave (MEDIA)
          let coincidePalabra = false;
          for (const palabra of palabrasClave) {
            if (texto.includes(palabra.toLowerCase())) {
              coincidePalabra = true;
              razon = `Coincide con palabra clave "${palabra}"`;
              break;
            }
          }

          if (coincidePalabra) {
            relevancia = 'MEDIA';

            // B.3. Subir a ALTA si monto >= monto_minimo_alta
            if (monto >= montoMinimoAlta) {
              relevancia = 'ALTA';
              razon += ` y monto supera RD$${montoMinimoAlta.toLocaleString()}`;
              contadorAlta++;
            } else {
              contadorMedia++;
            }
          }
        }

        // C. Guardar o actualizar en oportunidades_empresas
        if (relevancia) {
          // Verificar si ya existe
          const existe = await sql`
            SELECT resultado_id FROM oportunidades_empresas
            WHERE empresa_id = ${empresa_id}
            AND licitacion_id = ${licitacion.licitacion_id}
            LIMIT 1
          `;

          if (existe.length > 0) {
            // Actualizar
            await sql`
              UPDATE oportunidades_empresas
              SET relevancia = ${relevancia},
                  razon = ${razon},
                  fecha_analisis = CURRENT_TIMESTAMP
              WHERE empresa_id = ${empresa_id}
              AND licitacion_id = ${licitacion.licitacion_id}
            `;
          } else {
            // Insertar nueva
            await sql`
              INSERT INTO oportunidades_empresas
                (empresa_id, licitacion_id, relevancia, razon, fecha_analisis, notificada)
              VALUES
                (${empresa_id}, ${licitacion.licitacion_id}, ${relevancia}, ${razon}, CURRENT_TIMESTAMP, false)
            `;
          }
        } else {
          // No es relevante, eliminar si existe
          await sql`
            DELETE FROM oportunidades_empresas
            WHERE empresa_id = ${empresa_id}
            AND licitacion_id = ${licitacion.licitacion_id}
          `;
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Re-análisis completado',
        analizadas: licitacionesAbiertas.length,
        alta: contadorAlta,
        media: contadorMedia,
        descartadas: contadorDescartadas
      });
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