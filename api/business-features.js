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
const { empresa_id, tipo, accion, referencia, clave_secreta } = req.body;

// ====================================================
// ACCIÓN ESPECIAL: RESETEAR CUPOS MENSUAL (para cron job)
// Se maneja ANTES de validar empresa_id
// ====================================================
if (accion === 'resetear-mensual') {
  // Verificar clave secreta de autorización
  if (clave_secreta !== process.env.CRON_SECRET_KEY) {
    return res.status(401).json({
      success: false,
      error: 'No autorizado'
    });
  }

  // Importar Stripe
  const stripe = (await import('stripe')).default(process.env.STRIPE_SECRET_KEY);

  // Obtener mes actual y mes anterior
  const primerDiaMes = new Date();
  primerDiaMes.setDate(1);
  primerDiaMes.setHours(0, 0, 0, 0);
  const mesActual = primerDiaMes.toISOString().split('T')[0];

  // NUEVO: Calcular mes anterior
  const primerDiaMesAnterior = new Date(primerDiaMes);
  primerDiaMesAnterior.setMonth(primerDiaMesAnterior.getMonth() - 1);
  const mesAnterior = primerDiaMesAnterior.toISOString().split('T')[0];

  // Obtener empresas CON su stripe_subscription_id
  const empresas = await sql`
    SELECT id, nombre, plan, stripe_subscription_id,
           limite_zips_mes, limite_analisis_mes
    FROM empresas
    WHERE activo = true
  `;

  let reseteadas = 0;
  let desactivadas = 0;
  let errores = 0;
  let cuposTransferidos = 0;

  // Procesar cada empresa
  for (const empresa of empresas) {
    try {
      // Variables para almacenar el resultado de la validación
      let suscripcionActiva = false;
      let zipLimite = 0;
      let analisisLimite = 0;

      // Si la empresa tiene stripe_subscription_id, validar con Stripe
      if (empresa.stripe_subscription_id) {
        try {
          const subscription = await stripe.subscriptions.retrieve(
            empresa.stripe_subscription_id
          );

          // Verificar estado de la suscripción
          if (subscription.status === 'active') {
            suscripcionActiva = true;

            // Asignar límites según el plan
            if (empresa.plan === 'business') {
              zipLimite = 10;
              analisisLimite = 5;
            } else if (empresa.plan === 'estandar') {
              zipLimite = 0;
              analisisLimite = 0;
            }
          } else if (subscription.status === 'trialing') {
            // Empresa en periodo de prueba
            suscripcionActiva = true;
            zipLimite = 10;
            analisisLimite = 5;
          } else {
            // Estados: past_due, canceled, incomplete, incomplete_expired, unpaid
            console.log(`❌ Empresa ${empresa.nombre} (ID: ${empresa.id}) - Suscripción ${subscription.status}`);

            // Desactivar la empresa en la BD
            await sql`
              UPDATE empresas
              SET activo = false
              WHERE id = ${empresa.id}
            `;
            desactivadas++;
            continue; // Saltar a la siguiente empresa
          }
        } catch (stripeError) {
          console.error(`Error consultando Stripe para empresa ${empresa.id}:`, stripeError.message);
          errores++;
          continue; // Saltar a la siguiente empresa
        }
      } else {
        // Si NO tiene stripe_subscription_id, usar valores de la tabla empresas
        suscripcionActiva = true;
        zipLimite = empresa.limite_zips_mes || 0;
        analisisLimite = empresa.limite_analisis_mes || 0;
      }

      // Solo crear registro si la suscripción está activa
      if (suscripcionActiva) {
        // Verificar si ya existe registro para este mes
        const existe = await sql`
          SELECT id FROM uso_mensual
          WHERE empresa_id = ${empresa.id} AND mes = ${mesActual}
        `;

        if (existe.length === 0) {
          // NUEVO: Obtener cupos sobrantes del mes anterior
          let zipAdicionalesSobrantes = 0;
          let analisisAdicionalesSobrantes = 0;

          const mesAnteriorData = await sql`
            SELECT
              descargas_zip_usadas,
              analisis_ia_usados,
              zip_adicionales,
              analisis_adicionales,
              zip_limite_mes,
              analisis_limite_mes
            FROM uso_mensual
            WHERE empresa_id = ${empresa.id} AND mes = ${mesAnterior}
          `;

          if (mesAnteriorData.length > 0) {
            const anterior = mesAnteriorData[0];

            // CALCULAR CUPOS ADICIONALES DE ZIP QUE SOBRARON
            // ¿Cuántos adicionales usó? = max(0, usados - limite_base)
            const zipAdicionalesUsados = Math.max(0, anterior.descargas_zip_usadas - anterior.zip_limite_mes);
            // ¿Cuántos le quedan? = adicionales_que_tenia - adicionales_usados
            zipAdicionalesSobrantes = Math.max(0, anterior.zip_adicionales - zipAdicionalesUsados);

            // CALCULAR CUPOS ADICIONALES DE ANÁLISIS QUE SOBRARON
            const analisisAdicionalesUsados = Math.max(0, anterior.analisis_ia_usados - anterior.analisis_limite_mes);
            analisisAdicionalesSobrantes = Math.max(0, anterior.analisis_adicionales - analisisAdicionalesUsados);

            if (zipAdicionalesSobrantes > 0 || analisisAdicionalesSobrantes > 0) {
              cuposTransferidos++;
            }
          }

          // Crear nuevo registro para el mes CON los cupos sobrantes
          await sql`
            INSERT INTO uso_mensual
            (empresa_id, mes, descargas_zip_usadas, analisis_ia_usados,
             zip_adicionales, analisis_adicionales, zip_limite_mes, analisis_limite_mes)
            VALUES
            (${empresa.id}, ${mesActual}, 0, 0,
             ${zipAdicionalesSobrantes}, ${analisisAdicionalesSobrantes},
             ${zipLimite}, ${analisisLimite})
          `;
          reseteadas++;
        }
      }
    } catch (error) {
      console.error(`Error procesando empresa ${empresa.id}:`, error);
      errores++;
    }
  }

  // Respuesta con información completa
  console.log(`✅ Reseteo mensual completado para ${mesActual}`);
  console.log(`   - ${reseteadas} empresas reseteadas`);
  console.log(`   - ${cuposTransferidos} empresas con cupos transferidos`);
  console.log(`   - ${desactivadas} empresas desactivadas`);
  console.log(`   - ${errores} errores`);

  return res.status(200).json({
    success: true,
    message: 'Reseteo mensual completado',
    mes: mesActual,
    empresas_reseteadas: reseteadas,
    empresas_con_cupos_transferidos: cuposTransferidos,
    empresas_desactivadas: desactivadas,
    errores: errores
  });
}

// ========== VALIDAR EMPRESA_ID (para otras acciones) ==========
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

        const { plan } = empresa[0];
	    const limite_zips_mes = empresa[0].limite_zips_mes || 10;
    	const limite_analisis_mes = empresa[0].limite_analisis_mes || 5;

    // ========== VERIFICAR QUE SEA PLAN BUSINESS O ENTERPRISE ==========
    if (!['business', 'enterprise', 'free_trial'].includes(plan)) {
      return res.status(403).json({
        success: false,
        error: 'Esta funcionalidad está disponible permanentemente solo para planes Business y Enterprise',
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
  let usados = 0;
  let limite = 0;

  if (tipo === 'zip') {
    usados = uso.descargas_zip_usadas;
    limite = limite_zips_mes + (uso.zip_adicionales || 0);  // ✅ SUMA ADICIONALES
    cuposRestantes = limite - usados;
    cupoDisponible = cuposRestantes > 0;
  } else if (tipo === 'analisis') {
    usados = uso.analisis_ia_usados;
    limite = limite_analisis_mes + (uso.analisis_adicionales || 0);  // ✅ SUMA ADICIONALES
    cuposRestantes = limite - usados;
    cupoDisponible = cuposRestantes > 0;
  }

  return res.status(200).json({
    success: true,
    permitido: cupoDisponible,
    cupos_restantes: Math.max(0, cuposRestantes),
    usados: usados,
    limite: limite,
    tipo: tipo
  });
}

    // ====================================================
    // ACCIÓN: REGISTRAR USO DE CUPO
    // ====================================================
if (tipo === 'zip') {
  const limite_total = limite_zips_mes + (uso.zip_adicionales || 0);  // ✅ INCLUYE ADICIONALES

  // Verificar límite
  if (uso.descargas_zip_usadas >= limite_total) {
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
    cupos_restantes: limite_total - uso.descargas_zip_usadas - 1
  });
}

if (tipo === 'analisis') {
  const limite_total = limite_analisis_mes + (uso.analisis_adicionales || 0);  // ✅ INCLUYE ADICIONALES

  // Verificar límite
  if (uso.analisis_ia_usados >= limite_total) {
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
    cupos_restantes: limite_total - uso.analisis_ia_usados - 1
  });
}

// ====================================================
    // ACCIÓN: RE-ANALIZAR OPORTUNIDADES
    // ====================================================
    if (accion === 're-analizar') {
      // 1. Obtener perfil de empresa (palabras_clave, exclusiones, monto_minimo)
      const perfilEmpresa = await sql`
        SELECT palabras_clave, exclusiones, monto_minimo_alta
        FROM empresas
        WHERE id = ${empresa_id}
        LIMIT 1
      `;

      if (perfilEmpresa.length === 0) {
        return res.status(404).json({ success: false, error: 'Empresa no encontrada' });
      }

      const perfil = perfilEmpresa[0];
      const palabrasClave = perfil.palabras_clave || [];
      const exclusiones = perfil.exclusiones || [];
      const montoMinimoAlta = perfil.monto_minimo_alta || 500000;

      // 2. Obtener familias UNSPSC activas de la empresa
      const familiasActivas = await sql`
        SELECT familia_codigo
        FROM empresas_familias_unspsc
        WHERE empresa_id = ${empresa_id} AND activo = true
      `;
      const familiasCodigos = familiasActivas.map(f => f.familia_codigo);

      // 3. Obtener licitaciones ABIERTAS (fecha_presentacion > hoy)
      const hoy = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const licitacionesAbiertas = await sql`
        SELECT
          id as licitacion_id,
          referencia,
          descripcion,
          monto_estimado,
          codigo_unspsc,
          familia_unspsc,
          fecha_presentacion,
          unidad_compras
        FROM licitaciones
        WHERE fecha_presentacion > ${hoy}::timestamp
        ORDER BY fecha_presentacion ASC
      `;

      if (licitacionesAbiertas.length === 0) {
        return res.status(200).json({
          success: true,
          message: 'No hay licitaciones abiertas para analizar',
          analizadas: 0, alta: 0, media: 0, descartadas: 0
        });
      }

      // 4. Re-calcular relevancia para cada licitación
      let contadorAlta = 0;
      let contadorMedia = 0;
      let contadorDescartadas = 0;

      for (const lic of licitacionesAbiertas) {
        const texto = `${lic.referencia} ${lic.descripcion}`.toLowerCase();
        const monto = parseFloat(lic.monto_estimado) || 0;
        const codigoUNSPSC = lic.codigo_unspsc || '';
        const familiaUNSPSC = lic.familia_unspsc || '';

        // A. Verificar exclusiones primero
        let esDescartada = false;
        for (const excl of exclusiones) {
          if (texto.includes(excl.toLowerCase())) {
            esDescartada = true;
            break;
          }
        }

        if (esDescartada) {
          // Eliminar de resultados si existe
          await sql`
            DELETE FROM resultados
            WHERE empresa_id = ${empresa_id}
            AND licitacion_id = ${lic.licitacion_id}
          `;
          contadorDescartadas++;
          continue;
        }

        // B. Calcular relevancia
        let relevancia = null;
        let razon = '';

        // B.1. Verificar familias UNSPSC (ALTA directa)
        let coincideFamilia = false;
        for (const codigo of familiasCodigos) {
          if (codigoUNSPSC === codigo || familiaUNSPSC === codigo) {
            coincideFamilia = true;
            razon = `Coincide con categoría UNSPSC ${codigo}`;
            break;
          }
        }

        if (coincideFamilia) {
          relevancia = 'ALTA';
          contadorAlta++;
        } else {
          // B.2. Verificar palabras clave (MEDIA)
          let palabraEncontrada = '';
          for (const palabra of palabrasClave) {
            if (texto.includes(palabra.toLowerCase())) {
              palabraEncontrada = palabra;
              break;
            }
          }

          if (palabraEncontrada) {
            relevancia = 'MEDIA';
            razon = `Coincide con palabra clave "${palabraEncontrada}"`;

            // B.3. Subir a ALTA si monto >= monto_minimo_alta
            if (monto >= montoMinimoAlta) {
              relevancia = 'ALTA';
              razon += `. Monto RD$${monto.toLocaleString()} supera mínimo configurado`;
              contadorAlta++;
            } else {
              contadorMedia++;
            }
          }
        }

        // C. Guardar o actualizar en tabla "resultados"
        if (relevancia) {
          // Verificar si ya existe un registro
          const existe = await sql`
            SELECT id FROM resultados
            WHERE empresa_id = ${empresa_id}
            AND licitacion_id = ${lic.licitacion_id}
            LIMIT 1
          `;

          if (existe.length > 0) {
            // ACTUALIZAR registro existente
            await sql`
              UPDATE resultados
              SET relevancia = ${relevancia},
                  razon = ${razon},
                  razon_inclusion = ${razon},
                  fecha_analisis = CURRENT_TIMESTAMP,
                  compatible = true,
                  origen = 're-analisis'
              WHERE empresa_id = ${empresa_id}
              AND licitacion_id = ${lic.licitacion_id}
            `;
			} else {
            // Truncar valores para columnas varchar(100)
            const queVal = (lic.descripcion || '').substring(0, 99);
            const quienVal = (lic.unidad_compras || '').substring(0, 99);
            const refVal = (lic.referencia || '').substring(0, 254);

            // INSERTAR nuevo registro
            await sql`
              INSERT INTO resultados
                (empresa_id, licitacion_id, referencia, descripcion, que, quien,
                 relevancia, razon, razon_inclusion, estado,
                 monto_estimado, fecha_cierre, fecha_presentacion, unidad_compras,
                 created_at, fecha_analisis, notificada, compatible, vista, origen, seleccionado)
              VALUES
                (${empresa_id}, ${lic.licitacion_id}, ${refVal},
                 ${lic.descripcion || ''}, ${queVal}, ${quienVal},
                 ${relevancia}, ${razon}, ${razon}, 'pendiente',
                 ${lic.monto_estimado}, ${lic.fecha_presentacion}::date, ${lic.fecha_presentacion}::date, ${lic.unidad_compras || ''},
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, false, true, false, 're-analisis', false)
            `;
          }
        } else {
          // No es relevante, eliminar si existe
          await sql`
            DELETE FROM resultados
            WHERE empresa_id = ${empresa_id}
            AND licitacion_id = ${lic.licitacion_id}
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
  maxDuration: 30,
};