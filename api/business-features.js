// api/business-features.js - Gestión de recursos Business / Enterprise
import { neon } from '@neondatabase/serverless';
import Anthropic from '@anthropic-ai/sdk';

// ============================================================================
// HELPERS
// ============================================================================

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
    'Cibao Norte':    ['santiago', 'puerto plata', 'espaillat', 'valverde', 'moca', 'cabral y baez', 'del norte', 'edenorte'],
    'Cibao Sur':      ['la vega', 'monsenor nouel', 'sanchez ramirez', 'bonao', 'cotui'],
    'Cibao Nordeste': ['duarte', 'samana', 'maria trinidad', 'san francisco de macoris', 'nagua'],
    'Cibao Noroeste': ['dajabon', 'montecristi', 'santiago rodriguez', 'mao'],
    'El Valle':       ['elias pina', 'san juan', 'comendador'],
    'Enriquillo':     ['barahona', 'baoruco', 'independencia', 'pedernales', 'neiba', 'del sur'],
    'Higuamo':        ['san pedro de macoris', 'el seibo', 'hato mayor'],
    'Ozama':          ['santo domingo', 'distrito nacional', 'd.n.', 'ozama', 'del este', 'edeeste', 'edes'],
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

/**
 * Devuelve las capacidades y límites según el plan.
 * enterprise = tratado igual que enterprise_platinum (compatibilidad con Wilkin).
 */
function capacidadesPlan(plan) {
  const esPlatinum = ['enterprise_platinum', 'enterprise'].includes(plan);
  const esGold     = plan === 'enterprise_gold';
  const esBusiness = ['business', 'free_trial'].includes(plan);

  return {
    // Botones 1 y 2
    zip_ilimitado:             esPlatinum || esGold,
    analisis_ilimitado:        esPlatinum || esGold,
    zip_limite:                esBusiness ? 10 : (esPlatinum || esGold ? 9999 : 0),
    analisis_limite:           esBusiness ?  5 : (esPlatinum || esGold ? 9999 : 0),
    // Botón 3 — Agente 033
    agente_033_disponible:     esPlatinum || esGold,
    agente_033_ilimitado:      esPlatinum,
    agente_033_limite_mes:     esGold ? 5 : (esPlatinum ? 9999 : 0),
    // Botón 4 — Agente Sprint (Coach + Reporte) + KanbanBonsai IA
    // Todos comparten el mismo contador agente_sprint en uso_mensual
    agente_sprint_disponible:  esPlatinum,
    agente_sprint_limite_mes:  esPlatinum ? 5 : 0,
  };
}

// ============================================================================
// HANDLER
// ============================================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,x-kb-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sql = neon(process.env.DATABASE_URL);

  try {
    const { empresa_id, tipo, accion, referencia, clave_secreta } = req.body;

    // ====================================================
    // RESETEAR CUPOS MENSUAL (cron)
    // ====================================================
    if (accion === 'resetear-mensual') {
      if (clave_secreta !== process.env.CRON_SECRET_KEY) {
        return res.status(401).json({ success: false, error: 'No autorizado' });
      }
      const stripe = (await import('stripe')).default(process.env.STRIPE_SECRET_KEY);
      const primerDiaMes = new Date();
      primerDiaMes.setDate(1); primerDiaMes.setHours(0, 0, 0, 0);
      const mesActual = primerDiaMes.toISOString().split('T')[0];
      const primerDiaMesAnterior = new Date(primerDiaMes);
      primerDiaMesAnterior.setMonth(primerDiaMesAnterior.getMonth() - 1);
      const mesAnterior = primerDiaMesAnterior.toISOString().split('T')[0];

      const empresas = await sql`
        SELECT id, nombre, plan, stripe_subscription_id, limite_zips_mes, limite_analisis_mes
        FROM empresas WHERE activo = true
      `;
      let reseteadas = 0, desactivadas = 0, cancelacionesProgramadas = 0, errores = 0, cuposTransferidos = 0;

      for (const empresa of empresas) {
        try {
          const cap = capacidadesPlan(empresa.plan);
          let suscripcionActiva = false;
          let zipLimite      = cap.zip_limite;
          let analisisLimite = cap.analisis_limite;
          let a033Limite     = cap.agente_033_limite_mes;
          let sprintLimite   = cap.agente_sprint_limite_mes;

          if (empresa.stripe_subscription_id) {
            try {
              const sub = await stripe.subscriptions.retrieve(empresa.stripe_subscription_id);
              if (sub.status === 'active') {
                if (sub.cancel_at_period_end) {
                  await sql`UPDATE empresas SET activo = false WHERE id = ${empresa.id}`;
                  cancelacionesProgramadas++; continue;
                }
                suscripcionActiva = true;
              } else if (sub.status === 'trialing') {
                suscripcionActiva = true;
              } else {
                await sql`UPDATE empresas SET activo = false WHERE id = ${empresa.id}`;
                desactivadas++; continue;
              }
            } catch (e) {
              console.error(`Error Stripe empresa ${empresa.id}:`, e.message);
              errores++; continue;
            }
          } else {
            suscripcionActiva = true;
            if (empresa.limite_zips_mes)     zipLimite      = empresa.limite_zips_mes;
            if (empresa.limite_analisis_mes)  analisisLimite = empresa.limite_analisis_mes;
          }

          if (suscripcionActiva) {
            const existe = await sql`
              SELECT id FROM uso_mensual WHERE empresa_id = ${empresa.id} AND mes = ${mesActual}
            `;
            if (existe.length === 0) {
              let zipSobrantes = 0, analisisSobrantes = 0, a033Sobrantes = 0, sprintSobrantes = 0;
              const anterior = await sql`
                SELECT descargas_zip_usadas, analisis_ia_usados,
                       zip_adicionales, analisis_adicionales, zip_limite_mes, analisis_limite_mes,
                       agente_033_usados, agente_033_adicionales,
                       agente_sprint_usados, agente_sprint_adicionales
                FROM uso_mensual WHERE empresa_id = ${empresa.id} AND mes = ${mesAnterior}
              `;
              if (anterior.length > 0) {
                const a = anterior[0];
                const zipExtra = Math.max(0, a.descargas_zip_usadas - (a.zip_limite_mes || 0));
                zipSobrantes = Math.max(0, (a.zip_adicionales || 0) - zipExtra);
                const analisisExtra = Math.max(0, a.analisis_ia_usados - (a.analisis_limite_mes || 0));
                analisisSobrantes = Math.max(0, (a.analisis_adicionales || 0) - analisisExtra);
                const a033Extra = Math.max(0, (a.agente_033_usados || 0) - a033Limite);
                a033Sobrantes = Math.max(0, (a.agente_033_adicionales || 0) - a033Extra);
                const sprintExtra = Math.max(0, (a.agente_sprint_usados || 0) - sprintLimite);
                sprintSobrantes = Math.max(0, (a.agente_sprint_adicionales || 0) - sprintExtra);
                if (zipSobrantes > 0 || analisisSobrantes > 0 || a033Sobrantes > 0 || sprintSobrantes > 0)
                  cuposTransferidos++;
              }
              await sql`
                INSERT INTO uso_mensual
                  (empresa_id, mes, descargas_zip_usadas, analisis_ia_usados,
                   zip_adicionales, analisis_adicionales, zip_limite_mes, analisis_limite_mes,
                   agente_033_usados, agente_033_adicionales,
                   agente_sprint_usados, agente_sprint_adicionales)
                VALUES
                  (${empresa.id}, ${mesActual}, 0, 0,
                   ${zipSobrantes}, ${analisisSobrantes}, ${zipLimite}, ${analisisLimite},
                   0, ${a033Sobrantes}, 0, ${sprintSobrantes})
              `;
              reseteadas++;
            }
          }
        } catch (e) {
          console.error(`Error empresa ${empresa.id}:`, e);
          errores++;
        }
      }
      return res.status(200).json({
        success: true, message: 'Reseteo mensual completado', mes: mesActual,
        empresas_reseteadas: reseteadas, empresas_con_cupos_transferidos: cuposTransferidos,
        empresas_desactivadas: desactivadas, empresas_cancelacion_programada: cancelacionesProgramadas, errores
      });
    }

    // ====================================================
    // VALIDAR EMPRESA
    // ====================================================
    if (!empresa_id) return res.status(400).json({ success: false, error: 'Falta empresa_id' });

    const empresaRows = await sql`
      SELECT plan, limite_zips_mes, limite_analisis_mes FROM empresas WHERE id = ${empresa_id} LIMIT 1
    `;
    if (empresaRows.length === 0) return res.status(404).json({ success: false, error: 'Empresa no encontrada' });

    const { plan } = empresaRows[0];
    const cap = capacidadesPlan(plan);

    const planesPermitidos = ['business', 'enterprise', 'enterprise_gold', 'enterprise_platinum', 'free_trial'];
    if (!planesPermitidos.includes(plan)) {
      return res.status(403).json({
        success: false,
        error: 'Esta funcionalidad está disponible a partir del Plan Business',
        upgrade_required: true
      });
    }

    const primerDiaMes = new Date();
    primerDiaMes.setDate(1); primerDiaMes.setHours(0, 0, 0, 0);
    const mesActual = primerDiaMes.toISOString().split('T')[0];

    let usoRows = await sql`
      SELECT * FROM uso_mensual WHERE empresa_id = ${empresa_id} AND mes = ${mesActual} LIMIT 1
    `;
    if (usoRows.length === 0) {
      usoRows = await sql`
        INSERT INTO uso_mensual (empresa_id, mes, descargas_zip_usadas, analisis_ia_usados)
        VALUES (${empresa_id}, ${mesActual}, 0, 0) RETURNING *
      `;
    }
    const uso = usoRows[0];

    // ====================================================
    // VERIFICAR LÍMITES
    // ====================================================
    if (accion === 'verificar-limites') {
      return res.status(200).json({
        success: true,
        zip_usados:      uso.descargas_zip_usadas,
        zip_limite:      cap.zip_limite,
        zip_disponibles: cap.zip_ilimitado ? 9999 : Math.max(0, cap.zip_limite - uso.descargas_zip_usadas),
        analisis_usados:      uso.analisis_ia_usados,
        analisis_limite:      cap.analisis_limite,
        analisis_disponibles: cap.analisis_ilimitado ? 9999 : Math.max(0, cap.analisis_limite - uso.analisis_ia_usados),
      });
    }

// ── BLOQUE KB-ENTITLEMENTS — reemplazar el bloque existente completo ──────────
if (accion === 'kb-entitlements') {
  // Solo KB puede llamar este endpoint (secreto compartido)
  const kbSecret = req.headers['x-kb-secret'];
  if (!kbSecret || kbSecret !== process.env.COMPITA_KB_SECRET) {
    return res.status(401).json({ success: false, error: 'No autorizado' });
  }

  if (!cap.agente_sprint_disponible) {
    return res.status(200).json({
      success: true,
      tiene_acceso: false,
      razon: 'El plan actual no incluye KanbanBonsai IA. Requiere Enterprise PLATINUM.',
      upgrade_required: true,
    });
  }
  const usados    = uso.agente_sprint_usados || 0;
  const adicional = uso.agente_sprint_adicionales || 0;
  const limite    = cap.agente_sprint_limite_mes + adicional;
  const restantes = Math.max(0, limite - usados);
  return res.status(200).json({
    success: true,
    tiene_acceso: true,
    plan,
    usados,
    limite,
    restantes,
    ilimitado: false,
  });
}

// ── BLOQUE KB-CONSUMIR — reemplazar el bloque existente completo ──────────────
if (accion === 'kb-consumir') {
  // Solo KB puede llamar este endpoint (secreto compartido)
  const kbSecret = req.headers['x-kb-secret'];
  if (!kbSecret || kbSecret !== process.env.COMPITA_KB_SECRET) {
    return res.status(401).json({ success: false, error: 'No autorizado' });
  }

  if (!cap.agente_sprint_disponible) {
    return res.status(403).json({
      success: false,
      error: 'Generar Bonsai con IA requiere Plan Enterprise PLATINUM de Compita.',
      upgrade_required: true,
    });
  }
  const usados    = uso.agente_sprint_usados || 0;
  const adicional = uso.agente_sprint_adicionales || 0;
  const limite    = cap.agente_sprint_limite_mes + adicional;
  if (usados >= limite) {
    return res.status(403).json({
      success: false,
      error: `Alcanzaste el límite mensual de ${limite} usos de IA. Adquiere usos adicionales desde tu panel de Compita.`,
      cupos_disponibles: 0,
    });
  }
  await sql`
    UPDATE uso_mensual
    SET agente_sprint_usados = COALESCE(agente_sprint_usados, 0) + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE empresa_id = ${empresa_id} AND mes = ${mesActual}
  `;
  return res.status(200).json({
    success: true,
    message: 'Uso registrado',
    usados:    usados + 1,
    restantes: Math.max(0, limite - usados - 1),
  });
}

    // ====================================================
    // VALIDAR CUPO
    // ====================================================
    if (accion === 'validar') {
      let permitido = false, cuposRestantes = 0, usados = 0, limite = 0;

      if (tipo === 'zip') {
        if (cap.zip_ilimitado) { permitido = true; cuposRestantes = 9999; }
        else {
          usados = uso.descargas_zip_usadas;
          limite = cap.zip_limite + (uso.zip_adicionales || 0);
          cuposRestantes = limite - usados;
          permitido = cuposRestantes > 0;
        }

      } else if (tipo === 'analisis') {
        if (cap.analisis_ilimitado) { permitido = true; cuposRestantes = 9999; }
        else {
          usados = uso.analisis_ia_usados;
          limite = cap.analisis_limite + (uso.analisis_adicionales || 0);
          cuposRestantes = limite - usados;
          permitido = cuposRestantes > 0;
        }

      } else if (tipo === 'agente_033') {
        if (!cap.agente_033_disponible) {
          return res.status(403).json({
            success: false, permitido: false,
            error: 'El Agente 033 está disponible en los planes Enterprise GOLD y PLATINUM',
            upgrade_required: true
          });
        }
        if (cap.agente_033_ilimitado) { permitido = true; cuposRestantes = 9999; }
        else {
          usados = uso.agente_033_usados || 0;
          limite = cap.agente_033_limite_mes + (uso.agente_033_adicionales || 0);
          cuposRestantes = limite - usados;
          permitido = cuposRestantes > 0;
        }

      } else if (tipo === 'agente_sprint') {
        if (!cap.agente_sprint_disponible) {
          return res.status(403).json({
            success: false, permitido: false,
            error: 'El Agente Sprint está disponible solo en el Plan Enterprise PLATINUM',
            upgrade_required: true
          });
        }
        usados = uso.agente_sprint_usados || uso.coach_usados || 0;
        limite = cap.agente_sprint_limite_mes + (uso.agente_sprint_adicionales || 0);
        cuposRestantes = limite - usados;
        permitido = cuposRestantes > 0;
      }

      return res.status(200).json({
        success: true, permitido,
        cupos_restantes: Math.max(0, cuposRestantes), usados, limite, tipo
      });
    }

    // ====================================================
    // REGISTRAR USO — ZIP
    // ====================================================
    if (tipo === 'zip') {
      if (!cap.zip_ilimitado) {
        const limite_total = cap.zip_limite + (uso.zip_adicionales || 0);
        if (uso.descargas_zip_usadas >= limite_total) {
          return res.status(403).json({ success: false, error: 'Limite alcanzado', cupos_disponibles: 0 });
        }
      }
      await sql`UPDATE uso_mensual SET descargas_zip_usadas = descargas_zip_usadas + 1,
        updated_at = CURRENT_TIMESTAMP WHERE empresa_id = ${empresa_id} AND mes = ${mesActual}`;
      return res.status(200).json({ success: true, message: 'Descarga ZIP registrada' });
    }

    // ====================================================
    // REGISTRAR USO — ANÁLISIS IA
    // ====================================================
    if (tipo === 'analisis') {
      if (!cap.analisis_ilimitado) {
        const limite_total = cap.analisis_limite + (uso.analisis_adicionales || 0);
        if (uso.analisis_ia_usados >= limite_total) {
          return res.status(403).json({ success: false, error: 'Limite alcanzado', cupos_disponibles: 0 });
        }
      }
      await sql`UPDATE uso_mensual SET analisis_ia_usados = analisis_ia_usados + 1,
        updated_at = CURRENT_TIMESTAMP WHERE empresa_id = ${empresa_id} AND mes = ${mesActual}`;
      return res.status(200).json({ success: true, message: 'Analisis IA registrado' });
    }

    // ====================================================
    // REGISTRAR USO — AGENTE 033
    // ====================================================
    if (tipo === 'agente_033') {
      if (!cap.agente_033_disponible) {
        return res.status(403).json({ success: false, error: 'Agente 033 no disponible en este plan' });
      }
      if (!cap.agente_033_ilimitado) {
        const limite_total = cap.agente_033_limite_mes + (uso.agente_033_adicionales || 0);
        if ((uso.agente_033_usados || 0) >= limite_total) {
          return res.status(403).json({ success: false, error: 'Limite mensual del Agente 033 alcanzado', cupos_disponibles: 0 });
        }
      }
      await sql`UPDATE uso_mensual SET agente_033_usados = COALESCE(agente_033_usados, 0) + 1,
        updated_at = CURRENT_TIMESTAMP WHERE empresa_id = ${empresa_id} AND mes = ${mesActual}`;
      return res.status(200).json({ success: true, message: 'Agente 033 registrado' });
    }

    // ====================================================
    // COACH LICITADOR (Botón 4 — solo PLATINUM)
    // ====================================================
    if (accion === 'coach-licitador') {
      if (!cap.agente_sprint_disponible) {
        return res.status(403).json({
          success: false,
          error: 'El Coach Licitador está disponible solo en el Plan Enterprise PLATINUM',
          upgrade_required: true
        });
      }

      const sprintUsados = (uso.agente_sprint_usados ?? 0) + 0; // agente_sprint_usados es la fuente canónica
      const sprintLimite = cap.agente_sprint_limite_mes + (uso.agente_sprint_adicionales || 0);
      if (sprintUsados >= sprintLimite) {
        return res.status(403).json({
          success: false,
          error: `Has alcanzado tu límite mensual de ${cap.agente_sprint_limite_mes} usos del Agente Sprint. Puedes adquirir 5 usos adicionales por $10.`,
          upgrade_required: false,
          cupos_disponibles: 0
        });
      }

      const { licitacion } = req.body;
      if (!referencia || !licitacion) {
        return res.status(400).json({ success: false, error: 'referencia y licitacion requeridos' });
      }

      const documentos = await sql`
        SELECT codigo, nombre, es_permanente, fecha_vencimiento
        FROM perfil_licitador WHERE empresa_id = ${empresa_id} ORDER BY grupo ASC, orden ASC
      `;
      const analisisPrevio = await sql`
        SELECT analisis_json FROM analisis_pliegos
        WHERE empresa_id = ${empresa_id} AND referencia = ${referencia} LIMIT 1
      `;
      const analisisPliego = analisisPrevio.length > 0 ? JSON.parse(analisisPrevio[0].analisis_json) : null;

      const hoy = new Date(); hoy.setHours(0,0,0,0);
      const permanentes = [], vigentes = [], porVencer = [], sinRegistrar = [], vencidos = [];
      for (const doc of documentos) {
        if (doc.es_permanente) { permanentes.push(doc.nombre); continue; }
        if (!doc.fecha_vencimiento) { sinRegistrar.push(doc.nombre); continue; }
        const venc = new Date(doc.fecha_vencimiento);
        const diff = Math.round((venc - hoy) / 86400000);
        if (diff < 0)        vencidos.push(`${doc.nombre} (vencio hace ${Math.abs(diff)} dias)`);
        else if (diff <= 30)  porVencer.push(`${doc.nombre} (vence en ${diff} dias)`);
        else                  vigentes.push(doc.nombre);
      }

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
- NO_GO si: hay documentos vencidos Y dias_disponibles < 10, O documentos criticos sin registrar (RPE, impuestos) con tiempo insuficiente
- GO_RIESGO si: hay documentos por vencer O sin registrar no criticos, O dias_disponibles < mediana_historica pero > 0
- GO si: perfil completo o casi completo Y dias_disponibles >= mediana_historica

## INSTRUCCIONES
- El fundamento debe ser directo, en segunda persona, máximo 3 oraciones
- Los badges son etiquetas cortas (3-4 palabras máximo)
- Las condiciones deben ser acciones concretas, no generalidades
- Si no hay análisis del pliego, incluye: "Analizar en más detalle el pliego de condiciones para evaluar requisitos técnicos específicos"
- Responde ÚNICAMENTE con el JSON, sin texto adicional

## FORMATO (JSON estricto):
{
  "veredicto": "GO" | "GO_RIESGO" | "NO_GO",
  "fundamento": "texto directo en 2-3 oraciones",
  "badges": ["etiqueta 1", "etiqueta 2", "etiqueta 3"],
  "condiciones": [
    {"urgente": true, "texto": "accion concreta"},
    {"urgente": false, "texto": "cosa a verificar"}
  ]
}`;

      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      });

      let dictamen;
      try {
        const texto = message.content[0].text.trim();
        dictamen = JSON.parse(texto.replace(/```json|```/g, '').trim());
      } catch {
        return res.status(500).json({ success: false, error: 'Error al parsear respuesta del Coach' });
      }

      await sql`UPDATE uso_mensual
        SET agente_sprint_usados = COALESCE(agente_sprint_usados, 0) + 1,
            coach_usados         = COALESCE(coach_usados, 0) + 1,
            updated_at           = CURRENT_TIMESTAMP
        WHERE empresa_id = ${empresa_id} AND mes = ${mesActual}`;

      return res.status(200).json({
        success: true, dictamen,
        analisis_pliego_disponible: analisisPliego !== null,
        agente_sprint_usados: sprintUsados + 1,
        agente_sprint_restantes: Math.max(0, sprintLimite - sprintUsados - 1)
      });
    }

    // ====================================================
    // RE-ANALIZAR OPORTUNIDADES
    // ====================================================
    if (accion === 're-analizar') {
      const perfilEmpresa = await sql`
        SELECT palabras_clave, exclusiones, monto_minimo_alta, regiones_interes,
               familias_unspsc, usa_unspsc
        FROM empresas WHERE id = ${empresa_id} LIMIT 1
      `;
      if (perfilEmpresa.length === 0) return res.status(404).json({ success: false, error: 'Empresa no encontrada' });

      const perfil = perfilEmpresa[0];
      const palabrasClave   = perfil.palabras_clave || [];
      const exclusiones     = perfil.exclusiones   || [];
      const montoMinimoAlta = perfil.monto_minimo_alta || 500000;
      const familiasCodigos = Array.isArray(perfil.familias_unspsc) ? perfil.familias_unspsc : [];

      let regionesArr = [];
      const regionesRaw = perfil.regiones_interes;
      if (Array.isArray(regionesRaw)) {
        regionesArr = regionesRaw;
      } else if (typeof regionesRaw === 'string') {
        const s = regionesRaw.trim();
        if (s.startsWith('{')) {
          regionesArr = s.slice(1,-1).split(',').map(x => x.replace(/^"|"$/g,'').trim()).filter(Boolean);
        } else if (s.startsWith('[')) {
          try { regionesArr = JSON.parse(s); } catch { regionesArr = []; }
        }
      }
      const regionesEmpresa = regionesArr.filter(r => r !== 'Nacional' && r !== 'Nacional (todo el país)');

      const descartadasRows = await sql`
        SELECT licitacion_id FROM resultados
        WHERE empresa_id = ${empresa_id} AND descartada = TRUE AND licitacion_id IS NOT NULL
      `;
      const idsDescartados = new Set(descartadasRows.map(d => d.licitacion_id));

      const hoy = new Date().toISOString().split('T')[0];
      const licitacionesAbiertas = await sql`
        SELECT id as licitacion_id, referencia, descripcion, monto_estimado,
               codigo_unspsc, familia_unspsc, fecha_presentacion, unidad_compras
        FROM licitaciones WHERE fecha_presentacion > ${hoy}::timestamp ORDER BY fecha_presentacion ASC
      `;

      if (licitacionesAbiertas.length === 0) {
        return res.status(200).json({ success: true, message: 'No hay licitaciones abiertas', analizadas: 0, alta: 0, media: 0, descartadas: 0 });
      }

      await sql`DELETE FROM resultados WHERE empresa_id = ${empresa_id} AND (descartada IS NULL OR descartada = FALSE)`;

      let contadorAlta = 0, contadorMedia = 0, contadorDescartadas = 0, contadorPepuPeex = 0;

      for (const lic of licitacionesAbiertas) {
        if (/-(PEPU|PEEX|CD)-/i.test(lic.referencia || '')) { contadorPepuPeex++; continue; }
        if (idsDescartados.has(lic.licitacion_id)) { contadorDescartadas++; continue; }

        const texto = normalizar(`${lic.referencia} ${lic.descripcion} ${lic.unidad_compras || ''}`.toLowerCase());
        const monto = parseFloat(lic.monto_estimado) || 0;

        let esDescartada = false;
        for (const excl of exclusiones) {
          if (construirRegex(excl.toLowerCase()).test(texto)) { esDescartada = true; break; }
        }
        if (esDescartada) { contadorDescartadas++; continue; }

        if (perfil.usa_unspsc && familiasCodigos.length > 0) {
          const cod = lic.codigo_unspsc || '';
          if (cod && cod !== '99-99' && !familiasCodigos.includes(cod)) { contadorDescartadas++; continue; }
        }

        let coincideTema = false, razon = '';
        for (const palabra of palabrasClave) {
          if (construirRegex(palabra.toLowerCase()).test(texto)) {
            coincideTema = true; razon = `Coincide con palabra clave "${palabra}"`; break;
          }
        }
        if (!coincideTema) continue;

        const cumpleMonto = monto >= montoMinimoAlta;
        let cumpleRegion = true, regionLicitacion = 'Nacional';
        const todasLasRegiones = regionesEmpresa.length === 0 || regionesEmpresa.length >= 10;
        if (!todasLasRegiones) {
          regionLicitacion = obtenerRegionLicitacion(lic.unidad_compras, lic.descripcion);
          cumpleRegion = regionLicitacion === 'Nacional' ? false : regionesEmpresa.includes(regionLicitacion);
        }

        let relevancia;
        if (cumpleMonto && cumpleRegion) {
          relevancia = 'ALTA'; contadorAlta++;
          razon += regionesEmpresa.length > 0
            ? `. Monto RD$${monto.toLocaleString()} supera minimo. Region ${regionLicitacion} dentro del area.`
            : `. Monto RD$${monto.toLocaleString()} supera minimo configurado.`;
        } else {
          relevancia = 'MEDIA'; contadorMedia++;
          if (!cumpleMonto && !cumpleRegion) {
            const motivo = regionLicitacion === 'Nacional' ? 'Region no determinada' : `Region ${regionLicitacion} fuera del area`;
            razon = `${motivo} y monto por debajo del minimo. ${razon}`;
          } else if (!cumpleMonto) {
            razon += `. Monto RD$${monto.toLocaleString()} por debajo del minimo.`;
          } else {
            const motivo = regionLicitacion === 'Nacional' ? 'Region no determinada' : `Region ${regionLicitacion} fuera del area`;
            razon = `${motivo}. ${razon}`;
          }
        }

        await sql`
          INSERT INTO resultados
            (empresa_id, licitacion_id, referencia, descripcion, que, quien,
             relevancia, razon, razon_inclusion, estado,
             monto_estimado, fecha_cierre, fecha_presentacion, unidad_compras,
             created_at, fecha_analisis, notificada, compatible, vista, origen, seleccionado)
          VALUES
            (${empresa_id}, ${lic.licitacion_id}, ${(lic.referencia||'').substring(0,254)},
             ${lic.descripcion||''}, ${(lic.descripcion||'').substring(0,99)}, ${(lic.unidad_compras||'').substring(0,99)},
             ${relevancia}, ${razon}, ${razon}, 'pendiente',
             ${lic.monto_estimado}, ${lic.fecha_presentacion}::date,
             ${lic.fecha_presentacion}::date, ${lic.unidad_compras||''},
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, false, true, false, 're-analisis', false)
        `;
      }

      return res.status(200).json({
        success: true, message: 'Re-analisis completado',
        analizadas: licitacionesAbiertas.length, alta: contadorAlta, media: contadorMedia,
        descartadas: contadorDescartadas, excluidas_no_competitivas: contadorPepuPeex
      });
    }

    // ====================================================
    // ORGANIZADOR DE LA OFERTA (Botón 4 — solo PLATINUM)
    // ====================================================
    if (accion === 'organizador-oferta') {
      if (!cap.agente_sprint_disponible) {
        return res.status(403).json({
          success: false,
          error: 'El Organizador de la Oferta está disponible solo en el Plan Enterprise PLATINUM',
          upgrade_required: true
        });
      }

      const { licitacion, dictamen } = req.body;
      if (!referencia || !licitacion || !dictamen) {
        return res.status(400).json({ success: false, error: 'referencia, licitacion y dictamen requeridos' });
      }

      const empresaInfo = await sql`SELECT nombre, descripcion FROM empresas WHERE id = ${empresa_id} LIMIT 1`;
      const empresaDesc = empresaInfo.length > 0 ? empresaInfo[0].descripcion : '';

      const analisisPrevio = await sql`
        SELECT analisis_json FROM analisis_pliegos WHERE empresa_id = ${empresa_id} AND referencia = ${referencia} LIMIT 1
      `;
      const analisisPliego = analisisPrevio.length > 0 ? JSON.parse(analisisPrevio[0].analisis_json) : null;

      const seccionPliego = analisisPliego ? `
REQUISITOS DEL PLIEGO:
${analisisPliego.requisitos?.slice(0,5).map(r => `- ${r}`).join('\n') || '- No disponible'}
Garantías: ${analisisPliego.viabilidad?.garantias || 'No especificado'}
Experiencia previa: ${analisisPliego.viabilidad?.experiencia_previa || 'No especificado'}
Certificaciones: ${analisisPliego.certificaciones_iso?.exige_iso === 'SI' ? analisisPliego.certificaciones_iso.listado?.join(', ') : 'Ninguna'}
` : 'ANÁLISIS DEL PLIEGO: No disponible.';

      const condicionesTexto = (dictamen.condiciones || [])
        .map(c => `- ${c.urgente ? '[URGENTE] ' : ''}${c.texto}`).join('\n');

      const prompt = `Eres el Organizador de Oferta de Compita. Genera un plan de trabajo estructurado para que una empresa licitadora participe en una licitación pública específica de República Dominicana.

El output será pegado directamente en KanbanBonsai. Cada tarea debe ser concreta y específica para ESTA licitación.

LICITACIÓN:
- Referencia: ${referencia}
- Descripción: ${licitacion.descripcion}
- Entidad: ${licitacion.entidad}
- Tipo: ${licitacion.tipo}
- Monto: RD$${Number(licitacion.monto||0).toLocaleString()}
- Días disponibles: ${licitacion.diasDisponibles}
- Fecha límite: ${licitacion.fecha_presentacion || 'No especificada'}

EMPRESA: ${empresaDesc}
COACH: ${dictamen.veredicto}
${condicionesTexto}
${seccionPliego}

Responde ÚNICAMENTE con este formato:

PROYECTO: [nombre, máximo 8 palabras]
DESCRIPCIÓN: [2 líneas]

SPRINT 1 — Análisis y Evaluación
- [tarea]
- [tarea]
- [tarea]
- [tarea]

SPRINT 2 — Documentación Legal
- [tarea]
- [tarea]
- [tarea]
- [tarea]

SPRINT 3 — Oferta Técnica
- [tarea]
- [tarea]
- [tarea]
- [tarea]

SPRINT 4 — Oferta Económica
- [tarea]
- [tarea]
- [tarea]
- [tarea]

SPRINT 5 — Entrega y Seguimiento
- [tarea]
- [tarea]
- [tarea]`;

      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }]
      });

      return res.status(200).json({ success: true, prompt: message.content[0].text.trim() });
    }

    return res.status(400).json({ success: false, error: 'Parametros invalidos' });

  } catch (error) {
    console.error('Error en business-features:', error);
    return res.status(500).json({ success: false, error: 'Error al procesar solicitud', detalles: error.message });
  }
}

export const config = { maxDuration: 60 };