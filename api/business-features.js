// api/business-features.js - Gestión de recursos Business (ZIP y Análisis IA)
import { neon } from '@neondatabase/serverless';

// ============================================================
// FUNCIÓN: Inferir región geográfica desde nombre de institución
// ============================================================
function obtenerRegionLicitacion(unidad_compras) {
  if (!unidad_compras) return 'Nacional';

  const texto = unidad_compras.toLowerCase();

  const mapeo = {
    'Cibao Norte':    ['santiago', 'puerto plata', 'espaillat', 'valverde', 'moca',
                       'cabral y báez', 'del norte', 'edenorte'],
    'Cibao Sur':      ['la vega', 'monseñor nouel', 'sánchez ramírez', 'bonao', 'cotuí'],
    'Cibao Nordeste': ['duarte', 'samaná', 'maría trinidad', 'san francisco de macorís', 'nagua'],
    'Cibao Noroeste': ['dajabón', 'montecristi', 'santiago rodríguez', 'mao'],
    'El Valle':       ['elías piña', 'san juan', 'comendador'],
    'Enriquillo':     ['barahona', 'baoruco', 'independencia', 'pedernales', 'neiba', 'del sur'],
    'Higuamo':        ['san pedro de macorís', 'el seibo', 'hato mayor'],
    'Ozama':          ['santo domingo', 'distrito nacional', 'd.n.', 'ozama', 'del este',
                       'edeeste', 'edes'],
    'Valdesia':       ['san cristóbal', 'peravia', 'azua', 'ocoa', 'baní', 'bani'],
    'Yuma':           ['la romana', 'la altagracia', 'higüey', 'higuey'],
  };

  for (const [region, palabras] of Object.entries(mapeo)) {
    for (const palabra of palabras) {
      if (texto.includes(palabra)) return region;
    }
  }

  return 'Nacional';
}

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
    const { empresa_id, tipo, accion, referencia, clave_secreta } = req.body;

    // ====================================================
    // ACCIÓN ESPECIAL: RESETEAR CUPOS MENSUAL
    // ====================================================
    if (accion === 'resetear-mensual') {
      if (clave_secreta !== process.env.CRON_SECRET_KEY) {
        return res.status(401).json({ success: false, error: 'No autorizado' });
      }

      const stripe = (await import('stripe')).default(process.env.STRIPE_SECRET_KEY);

      const primerDiaMes = new Date();
      primerDiaMes.setDate(1);
      primerDiaMes.setHours(0, 0, 0, 0);
      const mesActual = primerDiaMes.toISOString().split('T')[0];

      const primerDiaMesAnterior = new Date(primerDiaMes);
      primerDiaMesAnterior.setMonth(primerDiaMesAnterior.getMonth() - 1);
      const mesAnterior = primerDiaMesAnterior.toISOString().split('T')[0];

      const empresas = await sql`
        SELECT id, nombre, plan, stripe_subscription_id,
               limite_zips_mes, limite_analisis_mes
        FROM empresas
        WHERE activo = true
      `;

      let reseteadas = 0;
      let desactivadas = 0;
      let cancelacionesProgramadas = 0;
      let errores = 0;
      let cuposTransferidos = 0;

      for (const empresa of empresas) {
        try {
          let suscripcionActiva = false;
          let zipLimite = 0;
          let analisisLimite = 0;

          if (empresa.stripe_subscription_id) {
            try {
              const subscription = await stripe.subscriptions.retrieve(
                empresa.stripe_subscription_id
              );

              if (subscription.status === 'active') {
                if (subscription.cancel_at_period_end === true) {
                  await sql`UPDATE empresas SET activo = false WHERE id = ${empresa.id}`;
                  cancelacionesProgramadas++;
                  continue;
                }
                suscripcionActiva = true;
                if (empresa.plan === 'business') { zipLimite = 10; analisisLimite = 5; }
                else if (empresa.plan === 'estandar') { zipLimite = 0; analisisLimite = 0; }
              } else if (subscription.status === 'trialing') {
                suscripcionActiva = true;
                zipLimite = 10;
                analisisLimite = 5;
              } else {
                await sql`UPDATE empresas SET activo = false WHERE id = ${empresa.id}`;
                desactivadas++;
                continue;
              }
            } catch (stripeError) {
              console.error(`Error Stripe empresa ${empresa.id}:`, stripeError.message);
              errores++;
              continue;
            }
          } else {
            suscripcionActiva = true;
            zipLimite = empresa.limite_zips_mes || 0;
            analisisLimite = empresa.limite_analisis_mes || 0;
          }

          if (suscripcionActiva) {
            const existe = await sql`
              SELECT id FROM uso_mensual
              WHERE empresa_id = ${empresa.id} AND mes = ${mesActual}
            `;

            if (existe.length === 0) {
              let zipAdicionalesSobrantes = 0;
              let analisisAdicionalesSobrantes = 0;

              const mesAnteriorData = await sql`
                SELECT descargas_zip_usadas, analisis_ia_usados,
                       zip_adicionales, analisis_adicionales,
                       zip_limite_mes, analisis_limite_mes
                FROM uso_mensual
                WHERE empresa_id = ${empresa.id} AND mes = ${mesAnterior}
              `;

              if (mesAnteriorData.length > 0) {
                const anterior = mesAnteriorData[0];
                const zipAdicionalesUsados = Math.max(0, anterior.descargas_zip_usadas - anterior.zip_limite_mes);
                zipAdicionalesSobrantes = Math.max(0, anterior.zip_adicionales - zipAdicionalesUsados);
                const analisisAdicionalesUsados = Math.max(0, anterior.analisis_ia_usados - anterior.analisis_limite_mes);
                analisisAdicionalesSobrantes = Math.max(0, anterior.analisis_adicionales - analisisAdicionalesUsados);
                if (zipAdicionalesSobrantes > 0 || analisisAdicionalesSobrantes > 0) cuposTransferidos++;
              }

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

      return res.status(200).json({
        success: true,
        message: 'Reseteo mensual completado',
        mes: mesActual,
        empresas_reseteadas: reseteadas,
        empresas_con_cupos_transferidos: cuposTransferidos,
        empresas_desactivadas: desactivadas,
        empresas_cancelacion_programada: cancelacionesProgramadas,
        errores: errores
      });
    }

    // ========== VALIDAR EMPRESA_ID ==========
    if (!empresa_id) {
      return res.status(400).json({ success: false, error: 'Falta empresa_id' });
    }

    const empresa = await sql`
      SELECT plan, limite_zips_mes, limite_analisis_mes
      FROM empresas WHERE id = ${empresa_id} LIMIT 1
    `;

    if (empresa.length === 0) {
      return res.status(404).json({ success: false, error: 'Empresa no encontrada' });
    }

    const { plan } = empresa[0];
    const limite_zips_mes = empresa[0].limite_zips_mes || 10;
    const limite_analisis_mes = empresa[0].limite_analisis_mes || 5;

    if (!['business', 'enterprise', 'free_trial'].includes(plan)) {
      return res.status(403).json({
        success: false,
        error: 'Esta funcionalidad está disponible permanentemente solo para planes Business y Enterprise',
        upgrade_required: true
      });
    }

    const primerDiaMes = new Date();
    primerDiaMes.setDate(1);
    primerDiaMes.setHours(0, 0, 0, 0);
    const mesActual = primerDiaMes.toISOString().split('T')[0];

    let usoMensual = await sql`
      SELECT * FROM uso_mensual
      WHERE empresa_id = ${empresa_id} AND mes = ${mesActual} LIMIT 1
    `;

    if (usoMensual.length === 0) {
      usoMensual = await sql`
        INSERT INTO uso_mensual (empresa_id, mes, descargas_zip_usadas, analisis_ia_usados)
        VALUES (${empresa_id}, ${mesActual}, 0, 0)
        RETURNING *
      `;
    }

    const uso = usoMensual[0];

    // ====================================================
    // ACCIÓN: VERIFICAR LÍMITES
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
        limite = limite_zips_mes + (uso.zip_adicionales || 0);
        cuposRestantes = limite - usados;
        cupoDisponible = cuposRestantes > 0;
      } else if (tipo === 'analisis') {
        usados = uso.analisis_ia_usados;
        limite = limite_analisis_mes + (uso.analisis_adicionales || 0);
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
    // ACCIÓN: REGISTRAR USO DE CUPO (ZIP)
    // ====================================================
    if (tipo === 'zip') {
      const limite_total = limite_zips_mes + (uso.zip_adicionales || 0);
      if (uso.descargas_zip_usadas >= limite_total) {
        return res.status(403).json({ success: false, error: 'Límite alcanzado', cupos_disponibles: 0 });
      }
      await sql`
        UPDATE uso_mensual
        SET descargas_zip_usadas = descargas_zip_usadas + 1, updated_at = CURRENT_TIMESTAMP
        WHERE empresa_id = ${empresa_id} AND mes = ${mesActual}
      `;
      return res.status(200).json({
        success: true,
        message: 'Descarga ZIP registrada',
        cupos_restantes: limite_total - uso.descargas_zip_usadas - 1
      });
    }

    // ====================================================
    // ACCIÓN: REGISTRAR USO DE CUPO (ANÁLISIS)
    // ====================================================
    if (tipo === 'analisis') {
      const limite_total = limite_analisis_mes + (uso.analisis_adicionales || 0);
      if (uso.analisis_ia_usados >= limite_total) {
        return res.status(403).json({ success: false, error: 'Límite alcanzado', cupos_disponibles: 0 });
      }
      await sql`
        UPDATE uso_mensual
        SET analisis_ia_usados = analisis_ia_usados + 1, updated_at = CURRENT_TIMESTAMP
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
      const perfilEmpresa = await sql`
        SELECT palabras_clave, exclusiones, monto_minimo_alta, regiones_interes
        FROM empresas WHERE id = ${empresa_id} LIMIT 1
      `;

      if (perfilEmpresa.length === 0) {
        return res.status(404).json({ success: false, error: 'Empresa no encontrada' });
      }

      const perfil = perfilEmpresa[0];
      const palabrasClave = perfil.palabras_clave || [];
      const exclusiones = perfil.exclusiones || [];
      const montoMinimoAlta = perfil.monto_minimo_alta || 500000;

      const familiasActivas = await sql`
        SELECT familia_codigo FROM empresas_familias_unspsc
        WHERE empresa_id = ${empresa_id} AND activo = true
      `;
      const familiasCodigos = familiasActivas.map(f => f.familia_codigo);

      // Parsear regiones (vienen como {Yuma} desde PostgreSQL)
      let regionesRaw = perfil.regiones_interes;
      let regionesArr = [];
      if (Array.isArray(regionesRaw)) {
        regionesArr = regionesRaw;
      } else if (typeof regionesRaw === 'string') {
        const s = regionesRaw.trim();
        if (s.startsWith('{')) {
          regionesArr = s.slice(1, -1).split(',')
            .map(x => x.replace(/^"|"$/g, '').trim())
            .filter(Boolean);
        } else if (s.startsWith('[')) {
          try { regionesArr = JSON.parse(s); } catch(e) { regionesArr = []; }
        }
      }
	  const regionesEmpresa = regionesArr.filter(
        r => r !== 'Nacional' && r !== 'Nacional (todo el país)'
      );
      const incluyeNacional = regionesArr.some(
        r => r === 'Nacional' || r === 'Nacional (todo el país)'
      );

      const hoy = new Date().toISOString().split('T')[0];
      const licitacionesAbiertas = await sql`
        SELECT id as licitacion_id, referencia, descripcion, monto_estimado,
               codigo_unspsc, familia_unspsc, fecha_presentacion, unidad_compras
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

      let contadorAlta = 0;
      let contadorMedia = 0;
      let contadorDescartadas = 0;

      for (const lic of licitacionesAbiertas) {
        const texto = `${lic.referencia} ${lic.descripcion}`.toLowerCase();
        const monto = parseFloat(lic.monto_estimado) || 0;
        const codigoUNSPSC = lic.codigo_unspsc || '';
        const familiaUNSPSC = lic.familia_unspsc || '';

        // A. Verificar exclusiones
        let esDescartada = false;
        for (const excl of exclusiones) {
          if (texto.includes(excl.toLowerCase())) { esDescartada = true; break; }
        }
        if (esDescartada) {
          await sql`
            DELETE FROM resultados
            WHERE empresa_id = ${empresa_id} AND licitacion_id = ${lic.licitacion_id}
          `;
          contadorDescartadas++;
          continue;
        }

        // B. Verificar coincidencia temática (UNSPSC o palabras clave)
        let coincideTema = false;
        let razon = '';

        for (const codigo of familiasCodigos) {
          if (codigoUNSPSC === codigo || familiaUNSPSC === codigo) {
            coincideTema = true;
            razon = `Coincide con categoría UNSPSC ${codigo}`;
            break;
          }
        }

        if (!coincideTema) {
          for (const palabra of palabrasClave) {
            if (texto.includes(palabra.toLowerCase())) {
              coincideTema = true;
              razon = `Coincide con palabra clave "${palabra}"`;
              break;
            }
          }
        }

        if (!coincideTema) {
          await sql`
            DELETE FROM resultados
            WHERE empresa_id = ${empresa_id} AND licitacion_id = ${lic.licitacion_id}
          `;
          continue;
        }

// C. Criterio de MONTO
        const cumpleMonto = monto >= montoMinimoAlta;

        // D. Criterio de REGIÓN
        let cumpleRegion = true;
        let regionLicitacion = 'Nacional';
        if (regionesEmpresa.length > 0) {
          regionLicitacion = obtenerRegionLicitacion(lic.unidad_compras);
          cumpleRegion = regionesEmpresa.includes(regionLicitacion);
        }

        // E. ALTA solo si cumple AMBOS: monto Y región
        let relevancia;
        if (cumpleMonto && cumpleRegion) {
          relevancia = 'ALTA';
          contadorAlta++;
          // Enriquecer razón con los dos criterios que la hacen ALTA
          const montoFmt = `RD$${monto.toLocaleString()}`;
          if (regionesEmpresa.length > 0) {
            razon += `. Monto ${montoFmt} supera mínimo configurado. Región ${regionLicitacion} dentro del área de operación.`;
          } else {
            razon += `. Monto ${montoFmt} supera mínimo configurado.`;
          }
        } else {
          relevancia = 'MEDIA';
          contadorMedia++;
          // Explicar por qué es MEDIA
          if (!cumpleMonto && !cumpleRegion) {
            razon = `Región ${regionLicitacion} fuera del área configurada y monto por debajo del mínimo. ${razon}`;
          } else if (!cumpleMonto) {
            razon += `. Monto RD$${monto.toLocaleString()} por debajo del mínimo configurado.`;
          } else if (!cumpleRegion) {
            razon = `Región ${regionLicitacion} fuera del área configurada. ${razon}`;
          }
        }

        // F. Guardar o actualizar en resultados
        const existe = await sql`
          SELECT id FROM resultados
          WHERE empresa_id = ${empresa_id} AND licitacion_id = ${lic.licitacion_id} LIMIT 1
        `;

        if (existe.length > 0) {
          await sql`
            UPDATE resultados
            SET relevancia = ${relevancia}, razon = ${razon},
                razon_inclusion = ${razon}, fecha_analisis = CURRENT_TIMESTAMP,
                compatible = true, origen = 're-analisis'
            WHERE empresa_id = ${empresa_id} AND licitacion_id = ${lic.licitacion_id}
          `;
        } else {
          const queVal = (lic.descripcion || '').substring(0, 99);
          const quienVal = (lic.unidad_compras || '').substring(0, 99);
          const refVal = (lic.referencia || '').substring(0, 254);

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
               ${lic.monto_estimado}, ${lic.fecha_presentacion}::date,
               ${lic.fecha_presentacion}::date, ${lic.unidad_compras || ''},
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, false, true, false, 're-analisis', false)
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

    return res.status(400).json({
      success: false,
      error: 'Parámetros inválidos'
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