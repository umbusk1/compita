// api/business-features.js - Gestión de recursos Business (ZIP y Análisis IA)
import { neon } from '@neondatabase/serverless';
import Anthropic from '@anthropic-ai/sdk';

function normalizar(t) {
  return (t||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
}

function construirRegex(palabra) {
  palabra = normalizar(palabra);
  const esExpresion = palabra.includes(' ');
  const escapada = palabra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (esExpresion) return new RegExp(escapada, 'i');
  const raiz = (/[aeiouáéíóúü]s$/i.test(palabra) || palabra.length <= 4)
    ? palabra
    : (palabra.endsWith('s') ? palabra.slice(0, -1) : palabra);
  const raizEscapada = raiz.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('\\b' + raizEscapada + 's?\\b', 'i');
}

function obtenerRegionLicitacion(unidad_compras, descripcion) {
  const mapeo = {
    'Cibao Norte':    ['santiago', 'puerto plata', 'espaillat', 'valverde', 'moca',
                       'cabral y baez', 'del norte', 'edenorte'],
    'Cibao Sur':      ['la vega', 'monsenor nouel', 'sanchez ramirez', 'bonao', 'cotui'],
    'Cibao Nordeste': ['duarte', 'samana', 'maria trinidad', 'san francisco de macoris', 'nagua'],
    'Cibao Noroeste': ['dajabon', 'montecristi', 'santiago rodriguez', 'mao'],
    'El Valle':       ['elias pina', 'san juan', 'comendador'],
    'Enriquillo':     ['barahona', 'baoruco', 'independencia', 'pedernales', 'neiba', 'del sur'],
    'Higuamo':        ['san pedro de macoris', 'el seibo', 'hato mayor'],
    'Ozama':          ['santo domingo', 'distrito nacional', 'd.n.', 'ozama', 'del este',
                       'edeeste', 'edes'],
    'Valdesia':       ['san cristobal', 'peravia', 'azua', 'ocoa', 'bani'],
    'Yuma':           ['la romana', 'la altagracia', 'higuey'],
  };
  const textoUnidad = normalizar((unidad_compras || '').toLowerCase());
  for (const [region, palabras] of Object.entries(mapeo)) {
    for (const palabra of palabras) {
      if (textoUnidad.includes(palabra)) return region;
    }
  }
  const textoDesc = normalizar((descripcion || '').toLowerCase());
  for (const [region, palabras] of Object.entries(mapeo)) {
    for (const palabra of palabras) {
      const regex = new RegExp('\\b' + palabra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      if (regex.test(textoDesc)) return region;
    }
  }
  return 'Nacional';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

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
        FROM empresas WHERE activo = true
      `;
      let reseteadas = 0, desactivadas = 0, cancelacionesProgramadas = 0,
          errores = 0, cuposTransferidos = 0;
      for (const empresa of empresas) {
        try {
          let suscripcionActiva = false, zipLimite = 0, analisisLimite = 0;
          if (empresa.stripe_subscription_id) {
            try {
              const subscription = await stripe.subscriptions.retrieve(empresa.stripe_subscription_id);
              if (subscription.status === 'active') {
                if (subscription.cancel_at_period_end === true) {
                  await sql`UPDATE empresas SET activo = false WHERE id = ${empresa.id}`;
                  cancelacionesProgramadas++; continue;
                }
                suscripcionActiva = true;
                if (empresa.plan === 'business')  { zipLimite = 10; analisisLimite = 5; }
                else if (empresa.plan === 'estandar') { zipLimite = 0; analisisLimite = 0; }
              } else if (subscription.status === 'trialing') {
                suscripcionActiva = true; zipLimite = 10; analisisLimite = 5;
              } else {
                await sql`UPDATE empresas SET activo = false WHERE id = ${empresa.id}`;
                desactivadas++; continue;
              }
            } catch (stripeError) {
              console.error(`Error Stripe empresa ${empresa.id}:`, stripeError.message);
              errores++; continue;
            }
          } else {
            suscripcionActiva = true;
            zipLimite = empresa.limite_zips_mes || 0;
            analisisLimite = empresa.limite_analisis_mes || 0;
          }
          if (suscripcionActiva) {
            const existe = await sql`
              SELECT id FROM uso_mensual WHERE empresa_id = ${empresa.id} AND mes = ${mesActual}
            `;
            if (existe.length === 0) {
              let zipSobrantes = 0, analisisSobrantes = 0;
              const anterior = await sql`
                SELECT descargas_zip_usadas, analisis_ia_usados,
                       zip_adicionales, analisis_adicionales,
                       zip_limite_mes, analisis_limite_mes
                FROM uso_mensual WHERE empresa_id = ${empresa.id} AND mes = ${mesAnterior}
              `;
              if (anterior.length > 0) {
                const a = anterior[0];
                const zipUsadosExtra = Math.max(0, a.descargas_zip_usadas - a.zip_limite_mes);
                zipSobrantes = Math.max(0, a.zip_adicionales - zipUsadosExtra);
                const analisisUsadosExtra = Math.max(0, a.analisis_ia_usados - a.analisis_limite_mes);
                analisisSobrantes = Math.max(0, a.analisis_adicionales - analisisUsadosExtra);
                if (zipSobrantes > 0 || analisisSobrantes > 0) cuposTransferidos++;
              }
              await sql`
                INSERT INTO uso_mensual
                (empresa_id, mes, descargas_zip_usadas, analisis_ia_usados,
                 zip_adicionales, analisis_adicionales, zip_limite_mes, analisis_limite_mes)
                VALUES (${empresa.id}, ${mesActual}, 0, 0,
                 ${zipSobrantes}, ${analisisSobrantes}, ${zipLimite}, ${analisisLimite})
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
        success: true, message: 'Reseteo mensual completado', mes: mesActual,
        empresas_reseteadas: reseteadas,
        empresas_con_cupos_transferidos: cuposTransferidos,
        empresas_desactivadas: desactivadas,
        empresas_cancelacion_programada: cancelacionesProgramadas,
        errores
      });
    }

    // ========== VALIDAR EMPRESA_ID ==========
    if (!empresa_id) return res.status(400).json({ success: false, error: 'Falta empresa_id' });

    const empresa = await sql`
      SELECT plan, limite_zips_mes, limite_analisis_mes FROM empresas WHERE id = ${empresa_id} LIMIT 1
    `;
    if (empresa.length === 0) return res.status(404).json({ success: false, error: 'Empresa no encontrada' });

    const { plan } = empresa[0];
    const limite_zips_mes = empresa[0].limite_zips_mes || 10;
    const limite_analisis_mes = empresa[0].limite_analisis_mes || 5;

    if (!['business', 'enterprise', 'free_trial'].includes(plan)) {
      return res.status(403).json({
        success: false,
        error: 'Esta funcionalidad esta disponible solo para planes Business y Enterprise',
        upgrade_required: true
      });
    }

    const primerDiaMes = new Date();
    primerDiaMes.setDate(1);
    primerDiaMes.setHours(0, 0, 0, 0);
    const mesActual = primerDiaMes.toISOString().split('T')[0];

    let usoMensual = await sql`
      SELECT * FROM uso_mensual WHERE empresa_id = ${empresa_id} AND mes = ${mesActual} LIMIT 1
    `;
    if (usoMensual.length === 0) {
      usoMensual = await sql`
        INSERT INTO uso_mensual (empresa_id, mes, descargas_zip_usadas, analisis_ia_usados)
        VALUES (${empresa_id}, ${mesActual}, 0, 0) RETURNING *
      `;
    }
    const uso = usoMensual[0];

    // ====================================================
    // ACCIÓN: VERIFICAR LÍMITES
    // ====================================================
    if (accion === 'verificar-limites') {
      return res.status(200).json({
        success: true,
        zip_usados: uso.descargas_zip_usadas,        zip_limite: limite_zips_mes,
        zip_disponibles: Math.max(0, limite_zips_mes - uso.descargas_zip_usadas),
        analisis_usados: uso.analisis_ia_usados,     analisis_limite: limite_analisis_mes,
        analisis_disponibles: Math.max(0, limite_analisis_mes - uso.analisis_ia_usados)
      });
    }

    // ====================================================
    // ACCIÓN: VALIDAR CUPO
    // ====================================================
    if (accion === 'validar') {
      let cupoDisponible = false, cuposRestantes = 0, usados = 0, limite = 0;
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
        success: true, permitido: cupoDisponible,
        cupos_restantes: Math.max(0, cuposRestantes), usados, limite, tipo
      });
    }

    // ====================================================
    // ACCIÓN: REGISTRAR USO DE CUPO (ZIP)
    // ====================================================
    if (tipo === 'zip') {
      const limite_total = limite_zips_mes + (uso.zip_adicionales || 0);
      if (uso.descargas_zip_usadas >= limite_total) {
        return res.status(403).json({ success: false, error: 'Limite alcanzado', cupos_disponibles: 0 });
      }
      await sql`
        UPDATE uso_mensual SET descargas_zip_usadas = descargas_zip_usadas + 1,
        updated_at = CURRENT_TIMESTAMP WHERE empresa_id = ${empresa_id} AND mes = ${mesActual}
      `;
      return res.status(200).json({
        success: true, message: 'Descarga ZIP registrada',
        cupos_restantes: limite_total - uso.descargas_zip_usadas - 1
      });
    }

    // ====================================================
    // ACCIÓN: REGISTRAR USO DE CUPO (ANÁLISIS)
    // ====================================================
    if (tipo === 'analisis') {
      const limite_total = limite_analisis_mes + (uso.analisis_adicionales || 0);
      if (uso.analisis_ia_usados >= limite_total) {
        return res.status(403).json({ success: false, error: 'Limite alcanzado', cupos_disponibles: 0 });
      }
      await sql`
        UPDATE uso_mensual SET analisis_ia_usados = analisis_ia_usados + 1,
        updated_at = CURRENT_TIMESTAMP WHERE empresa_id = ${empresa_id} AND mes = ${mesActual}
      `;
      return res.status(200).json({
        success: true, message: 'Analisis IA registrado',
        cupos_restantes: limite_total - uso.analisis_ia_usados - 1
      });
    }

    // ====================================================
    // ACCIÓN: COACH LICITADOR
    // Solo Enterprise. Cupo propio (coach_usados en uso_mensual).
    // ====================================================
    if (accion === 'coach-licitador') {

      // Solo Enterprise
      if (plan !== 'enterprise') {
        return res.status(403).json({
          success: false,
          error: 'El Coach Licitador esta disponible solo en el Plan Enterprise',
          upgrade_required: true
        });
      }

      const { licitacion } = req.body;
      if (!referencia || !licitacion) {
        return res.status(400).json({ success: false, error: 'referencia y licitacion requeridos' });
      }

      // Verificar cupo de coach (columna coach_usados en uso_mensual)
      // El limite Enterprise es ilimitado — registramos para métricas
      const coachUsados = uso.coach_usados || 0;

      // Leer perfil licitador de la empresa
      const documentos = await sql`
        SELECT codigo, nombre, es_permanente, fecha_vencimiento
        FROM perfil_licitador
        WHERE empresa_id = ${empresa_id}
        ORDER BY grupo ASC, orden ASC
      `;

      // Leer análisis de pliego previo si existe
      const analisisPrevio = await sql`
        SELECT analisis_json FROM analisis_pliegos
        WHERE empresa_id = ${empresa_id} AND referencia = ${referencia}
        LIMIT 1
      `;
      const analisisPliego = analisisPrevio.length > 0
        ? JSON.parse(analisisPrevio[0].analisis_json)
        : null;

      // Clasificar documentos del perfil
      const hoy = new Date(); hoy.setHours(0,0,0,0);
      const permanentes   = [];
      const vigentes      = [];
      const porVencer     = []; // ≤30 días
      const sinRegistrar  = [];
      const vencidos      = [];

      for (const doc of documentos) {
        if (doc.es_permanente) { permanentes.push(doc.nombre); continue; }
        if (!doc.fecha_vencimiento) { sinRegistrar.push(doc.nombre); continue; }
        const venc = new Date(doc.fecha_vencimiento);
        const diff = Math.round((venc - hoy) / 86400000);
        if (diff < 0)       vencidos.push(`${doc.nombre} (vencio hace ${Math.abs(diff)} dias)`);
        else if (diff <= 30) porVencer.push(`${doc.nombre} (vence en ${diff} dias)`);
        else                vigentes.push(doc.nombre);
      }

      // Construir sección de análisis del pliego para el prompt
      const seccionPliego = analisisPliego ? `
## ANÁLISIS DEL PLIEGO (ya realizado)
- Viabilidad: ${analisisPliego.viabilidad?.veredicto || 'No disponible'}
- Garantias: ${analisisPliego.viabilidad?.garantias || 'No especificado'}
- Experiencia previa requerida: ${analisisPliego.viabilidad?.experiencia_previa || 'No especificado'}
- Certificaciones exigidas: ${analisisPliego.certificaciones_iso?.exige_iso === 'SI' ? analisisPliego.certificaciones_iso.listado?.join(', ') : 'Ninguna'}
- Requisitos clave: ${analisisPliego.requisitos?.slice(0,3).join(' | ') || 'No disponible'}
- Riesgos identificados: ${analisisPliego.riesgos?.slice(0,2).join(' | ') || 'Ninguno'}
` : `
## ANÁLISIS DEL PLIEGO
No se ha analizado el pliego de esta licitación. Basa tu evaluación en los datos disponibles y señalalo en las condiciones.
`;

      const prompt = `Eres el Coach Licitador de Compita, un asistente experto en licitaciones públicas de República Dominicana. Tu rol es evaluar si una empresa debe participar en una licitación específica, basándote en su perfil documental y las características de la licitación.

## PERFIL LICITADOR DE LA EMPRESA
- Documentos permanentes (${permanentes.length}): ${permanentes.join(', ') || 'Ninguno'}
- Documentos vigentes (${vigentes.length}): ${vigentes.join(', ') || 'Ninguno'}
- Por vencer en ≤30 dias (${porVencer.length}): ${porVencer.join(', ') || 'Ninguno'}
- Sin registrar (${sinRegistrar.length}): ${sinRegistrar.join(', ') || 'Ninguno'}
- Vencidos (${vencidos.length}): ${vencidos.join(', ') || 'Ninguno'}
${seccionPliego}
## LICITACIÓN
- Referencia: ${licitacion.referencia}
- Tipo: ${licitacion.tipo}
- Descripción: ${licitacion.descripcion}
- Entidad: ${licitacion.entidad}
- Monto estimado: RD$${Number(licitacion.monto || 0).toLocaleString('es-DO')}
- Días disponibles: ${licitacion.dias_disponibles}
- Mediana histórica para ${licitacion.tipo}: ${licitacion.mediana_dias || 'desconocida'} dias

## REGLAS DE VEREDICTO
- NO_GO si: hay documentos vencidos Y dias_disponibles < 10, O documentos criticos sin registrar (RPE, impuestos) con tiempo insuficiente para obtenerlos antes del cierre
- GO_RIESGO si: hay documentos por vencer O sin registrar no criticos, O dias_disponibles < mediana_historica pero > 0
- GO si: perfil completo o casi completo Y dias_disponibles >= mediana_historica

## INSTRUCCIONES
- El fundamento debe ser directo, en segunda persona, máximo 3 oraciones
- Los badges son etiquetas cortas (3-4 palabras máximo)
- Las condiciones deben ser acciones concretas o cosas a verificar, no generalidades
- Si no hay análisis del pliego, incluye como condición que se recomienda analizarlo
- Responde ÚNICAMENTE con el JSON, sin texto adicional

## FORMATO DE RESPUESTA (JSON estricto):
{
  "veredicto": "GO" | "GO_RIESGO" | "NO_GO",
  "fundamento": "texto directo en 2-3 oraciones",
  "badges": ["etiqueta 1", "etiqueta 2", "etiqueta 3"],
  "condiciones": [
    {"urgente": true, "texto": "accion concreta a tomar"},
    {"urgente": false, "texto": "cosa a verificar o considerar"}
  ]
}`;

      // Llamar a Claude
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      });

      // Parsear respuesta JSON
      let dictamen;
      try {
        const texto = message.content[0].text.trim();
        const jsonLimpio = texto.replace(/```json|```/g, '').trim();
        dictamen = JSON.parse(jsonLimpio);
      } catch {
        return res.status(500).json({
          success: false,
          error: 'Error al parsear respuesta del Coach'
        });
      }

      // Registrar uso del coach para métricas
      await sql`
        UPDATE uso_mensual
        SET coach_usados = COALESCE(coach_usados, 0) + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE empresa_id = ${empresa_id} AND mes = ${mesActual}
      `;

      return res.status(200).json({
        success: true,
        dictamen,
        analisis_pliego_disponible: analisisPliego !== null,
        coach_usados: coachUsados + 1
      });
    }

    // ====================================================
    // ACCIÓN: RE-ANALIZAR OPORTUNIDADES
    // ====================================================
    if (accion === 're-analizar') {
      const perfilEmpresa = await sql`
        SELECT palabras_clave, exclusiones, monto_minimo_alta, regiones_interes, familias_unspsc
        FROM empresas WHERE id = ${empresa_id} LIMIT 1
      `;
      if (perfilEmpresa.length === 0) {
        return res.status(404).json({ success: false, error: 'Empresa no encontrada' });
      }

      const perfil = perfilEmpresa[0];
      const palabrasClave = perfil.palabras_clave || [];
      const exclusiones   = perfil.exclusiones   || [];
      const montoMinimoAlta = perfil.monto_minimo_alta || 500000;

      const familiasCodigos = Array.isArray(perfil.familias_unspsc)
        ? perfil.familias_unspsc
        : [];

      let regionesRaw = perfil.regiones_interes;
      let regionesArr = [];
      if (Array.isArray(regionesRaw)) {
        regionesArr = regionesRaw;
      } else if (typeof regionesRaw === 'string') {
        const s = regionesRaw.trim();
        if (s.startsWith('{')) {
          regionesArr = s.slice(1, -1).split(',')
            .map(x => x.replace(/^"|"$/g, '').trim()).filter(Boolean);
        } else if (s.startsWith('[')) {
          try { regionesArr = JSON.parse(s); } catch(e) { regionesArr = []; }
        }
      }
      const regionesEmpresa = regionesArr.filter(
        r => r !== 'Nacional' && r !== 'Nacional (todo el país)'
      );

      const descartadasRows = await sql`
        SELECT licitacion_id FROM resultados
        WHERE empresa_id = ${empresa_id}
          AND descartada = TRUE
          AND licitacion_id IS NOT NULL
      `;
      const idsDescartados = new Set(descartadasRows.map(d => d.licitacion_id));

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
          success: true, message: 'No hay licitaciones abiertas para analizar',
          analizadas: 0, alta: 0, media: 0, descartadas: 0
        });
      }

      await sql`
        DELETE FROM resultados
        WHERE empresa_id = ${empresa_id}
          AND (descartada IS NULL OR descartada = FALSE)
      `;

      let contadorAlta = 0, contadorMedia = 0,
          contadorDescartadas = 0, contadorPepuPeex = 0;

      for (const lic of licitacionesAbiertas) {
        if (/-(PEPU|PEEX)-/i.test(lic.referencia || '')) {
          contadorPepuPeex++;
          continue;
        }
        if (idsDescartados.has(lic.licitacion_id)) {
          contadorDescartadas++;
          continue;
        }

        const texto = normalizar(`${lic.referencia} ${lic.descripcion}`.toLowerCase());
        const monto = parseFloat(lic.monto_estimado) || 0;
        const codigoUNSPSC = lic.codigo_unspsc || '';

        let esDescartada = false;
        for (const excl of exclusiones) {
          const regex = construirRegex(excl.toLowerCase());
          if (regex.test(texto)) { esDescartada = true; break; }
        }
        if (esDescartada) { contadorDescartadas++; continue; }

        if (familiasCodigos.length > 0 && codigoUNSPSC && codigoUNSPSC !== '99-99') {
          if (!familiasCodigos.includes(codigoUNSPSC)) {
            contadorDescartadas++;
            continue;
          }
        }

        let coincideTema = false, razon = '';
        for (const palabra of palabrasClave) {
          const regex = construirRegex(palabra.toLowerCase());
          if (regex.test(texto)) {
            coincideTema = true;
            razon = `Coincide con palabra clave "${palabra}"`;
            break;
          }
        }
        if (!coincideTema) continue;

        const cumpleMonto = monto >= montoMinimoAlta;

        let cumpleRegion = true, regionLicitacion = 'Nacional';
        const todasLasRegiones = regionesEmpresa.length === 0 || regionesEmpresa.length >= 10;
        if (!todasLasRegiones) {
          regionLicitacion = obtenerRegionLicitacion(lic.unidad_compras, lic.descripcion);
          if (regionLicitacion === 'Nacional') {
            cumpleRegion = false;
          } else {
            cumpleRegion = regionesEmpresa.includes(regionLicitacion);
          }
        }

        let relevancia;
        if (cumpleMonto && cumpleRegion) {
          relevancia = 'ALTA';
          contadorAlta++;
          const montoFmt = `RD$${monto.toLocaleString()}`;
          razon += regionesEmpresa.length > 0
            ? `. Monto ${montoFmt} supera minimo configurado. Region ${regionLicitacion} dentro del area de operacion.`
            : `. Monto ${montoFmt} supera minimo configurado.`;
        } else {
          relevancia = 'MEDIA';
          contadorMedia++;
          if (!cumpleMonto && !cumpleRegion) {
            const motivo = regionLicitacion === 'Nacional'
              ? 'Region no determinada (organismo nacional)'
              : `Region ${regionLicitacion} fuera del area configurada`;
            razon = `${motivo} y monto por debajo del minimo. ${razon}`;
          } else if (!cumpleMonto) {
            razon += `. Monto RD$${monto.toLocaleString()} por debajo del minimo configurado.`;
          } else {
            const motivo = regionLicitacion === 'Nacional'
              ? 'Region no determinada (organismo nacional)'
              : `Region ${regionLicitacion} fuera del area configurada`;
            razon = `${motivo}. ${razon}`;
          }
        }

        const queVal   = (lic.descripcion    || '').substring(0, 99);
        const quienVal = (lic.unidad_compras  || '').substring(0, 99);
        const refVal   = (lic.referencia      || '').substring(0, 254);

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

      return res.status(200).json({
        success: true,
        message: 'Re-analisis completado',
        analizadas: licitacionesAbiertas.length,
        alta: contadorAlta,
        media: contadorMedia,
        descartadas: contadorDescartadas,
        excluidas_pepu_peex: contadorPepuPeex
      });
    }

    return res.status(400).json({ success: false, error: 'Parametros invalidos' });

  } catch (error) {
    console.error('Error en business-features:', error);
    return res.status(500).json({
      success: false, error: 'Error al procesar solicitud', detalles: error.message
    });
  }
}

export const config = { maxDuration: 60 };