/*
COMPITA - Análisis Diario y Notificaciones (Endpoint Vercel)
=============================================================
✨ ACTUALIZACIÓN: Filtro por familias UNSPSC para optimizar costos de Claude AI
✨ ACTUALIZACIÓN: Fix stemming español (no stemizar vocal+s)
✨ ACTUALIZACIÓN: Re-evaluación automática al cambiar palabras clave/exclusiones
*/

import Anthropic from '@anthropic-ai/sdk';
import pkg from 'pg';
const { Pool } = pkg;
import { Resend } from 'resend';

// ============================================================================
// CONFIGURACIÓN
// ============================================================================

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const resend = new Resend(process.env.RESEND_API_KEY);
const DASHBOARD_URL = 'https://compita.umbusk.com/oportunidades.html';

// ============================================================================
// HANDLER PRINCIPAL
// ============================================================================

export default async function handler(req, res) {
  // ── Re-evaluación al cambiar perfil (llamado desde perfil.js) ──────────────
  if (req.method === 'POST' && req.query.action === 'reanalizar') {
    const authHeader = req.headers.authorization;
    const expectedToken = process.env.CRON_SECRET;
    // Acepta tanto el token de cron como el JWT del usuario (perfil.js lo envía)
    if (!authHeader) return res.status(403).json({ error: 'No autorizado' });
    return await handleReanalizar(req, res);
  }

  // ── Análisis diario (cron) ─────────────────────────────────────────────────
  const authHeader = req.headers.authorization;
  const expectedToken = process.env.CRON_SECRET;

  if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
    console.log('❌ Intento de acceso no autorizado');
    return res.status(403).json({ error: 'No autorizado' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const inicioTotal = Date.now();

  console.log('\n🔄 COMPITA - ANÁLISIS Y NOTIFICACIONES DIARIAS\n');

  try {
    const { resultados, empresasProcesadas } = await analizarDiario();

    let emailsEnviados = 0;
    if (resultados.length > 0) {
      emailsEnviados = await enviarNotificaciones(resultados);
    } else {
      console.log('⚠️  No hay resultados para notificar\n');
    }

    const duracionTotal = ((Date.now() - inicioTotal) / 1000).toFixed(1);

    return res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      empresas_procesadas: empresasProcesadas,
      emails_enviados: emailsEnviados,
      duracion_segundos: parseFloat(duracionTotal),
      detalle: resultados.map(r => ({
        empresa: r.nombre,
        plan: r.plan,
        oportunidades: r.alta + r.media,
        alta: r.alta,
        media: r.media
      }))
    });

  } catch (error) {
    console.error('\n❌ ERROR GENERAL:', error);
    return res.status(500).json({
      success: false,
      error: 'Error en análisis y notificaciones',
      detalle: error.message
    });
  }
}

// ============================================================================
// RE-EVALUACIÓN AL CAMBIAR PERFIL
// ============================================================================

async function handleReanalizar(req, res) {
  const { empresa_id } = req.body;

  if (!empresa_id) {
    return res.status(400).json({ error: 'empresa_id requerido' });
  }

  try {
    // Obtener perfil actualizado de la empresa
    const empresaRes = await pool.query(`
      SELECT e.id, e.nombre, e.descripcion, e.palabras_clave, e.exclusiones,
             e.monto_minimo_alta, e.plan, e.familias_unspsc, e.regiones_interes, e.website
      FROM empresas e
      WHERE e.id = $1
    `, [empresa_id]);

    if (empresaRes.rows.length === 0) {
      return res.status(404).json({ error: 'Empresa no encontrada' });
    }

    const empresa = empresaRes.rows[0];

    // Obtener todos los resultados existentes de la empresa que aún no han vencido
    const resultadosRes = await pool.query(`
      SELECT r.id, r.referencia, r.descripcion, r.fecha_presentacion,
             r.monto_estimado, r.estado, r.relevancia, r.unidad_compras,
             r.que, r.quien, r.razon
      FROM resultados r
      WHERE r.empresa_id = $1
        AND (r.fecha_presentacion IS NULL OR r.fecha_presentacion > NOW())
    `, [empresa_id]);

    const resultados = resultadosRes.rows;
    console.log(`🔄 Re-evaluando ${resultados.length} resultados para ${empresa.nombre}`);

    let actualizados = 0;
    let descartados = 0;

    for (const resultado of resultados) {
      // Re-ejecutar etapa 1 (keywords + exclusiones) con el perfil actualizado
      const licitacionSimulada = {
        descripcion:        resultado.descripcion,
        fecha_presentacion: resultado.fecha_presentacion,
        estado:             resultado.estado || 'Publicado',
        monto_estimado:     resultado.monto_estimado,
        referencia:         resultado.referencia,
        unidad_compras:     resultado.unidad_compras,
      };

      const etapa1 = await procesarEtapa1(licitacionSimulada, empresa);

      if (!etapa1.pasa_etapa1) {
        // Ya no pasa el filtro → marcar como DESCARTADA
        await pool.query(`
          UPDATE resultados
          SET relevancia = 'DESCARTADA',
              razon = $1
          WHERE id = $2
        `, [`Re-evaluado: ${etapa1.razon}`, resultado.id]);
        descartados++;
        continue;
      }

      // Pasa etapa 1 → re-aplicar lógica de monto y región
      let nuevaRelevancia = resultado.relevancia === 'DESCARTADA' ? 'MEDIA' : resultado.relevancia;
      let nuevaRazon = resultado.razon;

      const montoMinimo = empresa.monto_minimo_alta || 500000;
      const montoOportunidad = parseFloat(resultado.monto_estimado || 0);

      if (nuevaRelevancia === 'ALTA' && montoOportunidad < montoMinimo) {
        nuevaRelevancia = 'MEDIA';
        nuevaRazon = `Monto ${montoOportunidad.toLocaleString()} DOP menor al mínimo. ${nuevaRazon}`;
      }

      // FIX: chequeo de región en re-evaluación (antes faltaba completamente)
      const regionesEmpresaReeval = Array.isArray(empresa.regiones_interes)
        ? empresa.regiones_interes.filter(r => r !== 'Nacional')
        : [];

      if (regionesEmpresaReeval.length > 0 && nuevaRelevancia === 'ALTA') {
        const regionRes = await pool.query(`
          SELECT region FROM instituciones_region
          WHERE unidad_compras = $1 LIMIT 1
        `, [resultado.unidad_compras || '']);

        const regionLicitacion = regionRes.rows.length > 0
          ? regionRes.rows[0].region
          : null;

        if (
          regionLicitacion
          && regionLicitacion !== 'Nacional'
          && !regionesEmpresaReeval.includes(regionLicitacion)
        ) {
          nuevaRelevancia = 'MEDIA';
          nuevaRazon = `Región ${regionLicitacion} fuera del área configurada. ${nuevaRazon}`;
        }
      }

      if (nuevaRelevancia !== resultado.relevancia || nuevaRazon !== resultado.razon) {
        await pool.query(`
          UPDATE resultados
          SET relevancia = $1, razon = $2
          WHERE id = $3
        `, [nuevaRelevancia, nuevaRazon, resultado.id]);
        actualizados++;
      }
    }

    console.log(`✅ Re-evaluación completada: ${actualizados} actualizados, ${descartados} descartados`);

    return res.status(200).json({
      success: true,
      mensaje: `Re-evaluación completada`,
      actualizados,
      descartados,
      total: resultados.length
    });

  } catch (error) {
    console.error('❌ Error en re-evaluación:', error);
    return res.status(500).json({ error: 'Error en re-evaluación', detalle: error.message });
  }
}

// ============================================================================
// UTILIDAD: Stemming seguro para español
// No stemiza palabras que terminan en vocal+s (cursos, recursos, sistemas...)
// Solo stemiza si termina en consonante+s (análisis no aplica por longitud)
// ============================================================================

function obtenerRaiz(palabra) {
  if (palabra.length <= 4) return palabra; // palabras muy cortas: sin stemming
  if (/[aeiouáéíóúü]s$/i.test(palabra)) return palabra; // vocal+s: sin stemming
  if (palabra.endsWith('s')) return palabra.slice(0, -1); // consonante+s: stemming
  return palabra;
}

// ============================================================================
// ETAPA 1: Filtro por palabras clave, exclusiones, fecha y estado
// ============================================================================

async function procesarEtapa1(oportunidad, empresa) {
  if (!oportunidad.fecha_presentacion) {
    return { pasa_etapa1: false, razon: 'Sin fecha de presentación' };
  }

  let fechaLimite;
  try {
    fechaLimite = new Date(oportunidad.fecha_presentacion);
    if (isNaN(fechaLimite.getTime())) {
      return { pasa_etapa1: false, razon: 'Fecha inválida' };
    }
  } catch (err) {
    return { pasa_etapa1: false, razon: 'Fecha inválida' };
  }

  const ahora = new Date();
  if (fechaLimite < ahora) {
    return { pasa_etapa1: false, razon: 'Fecha de presentación vencida' };
  }

  // ── Parsing de palabras clave (usa array nativo de PostgreSQL) ─────────────
  const palabrasClave = (
    Array.isArray(empresa.palabras_clave)
      ? empresa.palabras_clave
      : (empresa.palabras_clave || '').split(',')
  ).map(p => p.trim().toLowerCase()).filter(p => p.length > 0);

  const textoCompleto = (oportunidad.descripcion || '').toLowerCase();

  // ── Matching con stemming seguro ───────────────────────────────────────────
  let palabraEncontrada = null;
  const tieneCoincidencia = palabrasClave.some(palabra => {
    const esExpresion = palabra.includes(' ');
    let regex;

    if (esExpresion) {
      // Expresión multi-palabra → búsqueda exacta de la frase completa
      const expresionEscapada = palabra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(expresionEscapada, 'i');
    } else {
      // Palabra simple → stemming seguro
      const raiz = obtenerRaiz(palabra);
      const palabraEscapada = raiz.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Si hubo stemming, acepta con o sin s final; si no, coincidencia exacta
      regex = raiz !== palabra
        ? new RegExp('\\b' + palabraEscapada + 's?\\b', 'i')
        : new RegExp('\\b' + palabraEscapada + '\\b', 'i');
    }

    const encontrada = regex.test(textoCompleto);
    if (encontrada) { palabraEncontrada = palabra; return true; }
    return false;
  });

  if (!tieneCoincidencia) {
    return { pasa_etapa1: false, razon: 'No contiene palabras clave relevantes' };
  }

  // ── Exclusiones con la misma lógica ───────────────────────────────────────
  if (empresa.exclusiones && empresa.exclusiones.length > 0) {
    const exclusiones = (
      Array.isArray(empresa.exclusiones)
        ? empresa.exclusiones
        : (empresa.exclusiones || '').split(',')
    ).map(e => e.trim().toLowerCase()).filter(e => e.length > 0);

    for (const exclusion of exclusiones) {
      const esExpresion = exclusion.includes(' ');
      let regex;

      if (esExpresion) {
        const expresionEscapada = exclusion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(expresionEscapada, 'i');
      } else {
        const raiz = obtenerRaiz(exclusion);
        const palabraEscapada = raiz.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = raiz !== exclusion
          ? new RegExp('\\b' + palabraEscapada + 's?\\b', 'i')
          : new RegExp('\\b' + palabraEscapada + '\\b', 'i');
      }

      if (regex.test(textoCompleto)) {
        return {
          pasa_etapa1: false,
          razon: `Contiene exclusión: ${exclusion}`
        };
      }
    }
  }

  const estado = oportunidad.estado || '';
  if (!estado) {
    return { pasa_etapa1: false, razon: 'Sin estado definido' };
  }

  return { pasa_etapa1: true, palabra_encontrada: palabraEncontrada };
}

// ============================================================================
// OBTENER REGIÓN DE LA LICITACIÓN
// ============================================================================

async function obtenerRegionLicitacion(unidad_compras) {
  if (!unidad_compras) return null;

  const directa = await pool.query(`
    SELECT region FROM instituciones_region
    WHERE unidad_compras = $1 LIMIT 1
  `, [unidad_compras]);

  if (directa.rows.length > 0) return directa.rows[0].region;

  const porMunicipio = await pool.query(`
    SELECT region FROM regiones_rd
    WHERE $1 ILIKE '%' || municipio || '%'
    ORDER BY LENGTH(municipio) DESC LIMIT 1
  `, [unidad_compras]);

  if (porMunicipio.rows.length > 0) return porMunicipio.rows[0].region;

  return null;
}

// ============================================================================
// ANÁLISIS CON IA (Claude)
// ============================================================================

async function analizarConIA(oportunidad, empresa) {
  const regionLicitacion = await obtenerRegionLicitacion(oportunidad.unidad_compras);

  const regionesEmpresa = Array.isArray(empresa.regiones_interes)
    ? empresa.regiones_interes.filter(r => r !== 'Nacional')
    : [];

const seccionFeedback = descartadasRecientes.length > 0 ? `

**LICITACIONES QUE ESTE CLIENTE RECHAZÓ — no clasificar similares como ALTA:**
${descartadasRecientes.slice(0, 5).map((d, i) => `${i + 1}. ${(d || '').substring(0, 120)}`).join('\n')}
Si la licitación actual es temáticamente similar a alguna de las anteriores, clasifícala como BAJA.
` : '';

  const seccionGeografica = (!regionLicitacion && regionesEmpresa.length > 0)
    ? `
**ANÁLISIS GEOGRÁFICO (solo si aplica):**
La institución "${oportunidad.unidad_compras}" es de alcance nacional.
Busca en la descripción cualquier señal geográfica (nombres de municipios,
provincias, regiones, o frases como "en la provincia de X", "en la zona Y").
Si encuentras una señal clara, indícala en REGIÓN. Si no hay señal, responde "Nacional".
Las regiones oficiales de RD son: Ozama, Cibao Norte, Cibao Sur, Cibao Nordeste,
Cibao Noroeste, Valdesia, El Valle, Enriquillo, Yuma, Higuamo.
` : '';

  const formatoRegion = (!regionLicitacion && regionesEmpresa.length > 0)
    ? '\nREGIÓN: [nombre de región oficial o "Nacional"]'
    : '';

const prompt = `Eres un analista experto en licitaciones públicas. Analiza esta oportunidad para determinar:

1. **RELEVANCIA**: ¿Qué tan relevante es para el cliente?
   - ALTA: Coincidencia directa y fuerte con servicios/productos principales del cliente
   - MEDIA: Relacionado o parcialmente alineado con servicios del cliente
   - BAJA: Poco relevante o fuera del alcance

2. **QUÉ**: Extrae en máximo 5 palabras el objeto principal de la licitación
3. **QUIÉN**: Extrae la entidad que licita (nombre de la institución/unidad)
4. **RAZÓN**: Justificación breve (máximo 2 líneas)
${seccionFeedback}
${seccionGeografica}
**REGLA ANTI-FALSO-POSITIVO (crítica):**
NO clasifiques como ALTA una licitación basándote solo en palabras genéricas como "equipos", "instrumentos", "materiales", "suministros" o "servicios". Exige que la licitación describa específicamente el tipo de producto o servicio que el cliente distribuye o presta. Si la coincidencia es solo por una palabra genérica y el contexto real de la licitación apunta a otro sector (tecnología de oficina, construcción, industria alimentaria, textiles, etc.), clasifica como BAJA.

**IMPORTANTE**: Evalúa SOLO la relevancia temática. El sistema aplicará filtros adicionales de monto y región automáticamente.

**PERFIL DEL CLIENTE:**
${empresa.descripcion || 'Cliente sin descripción'}
${empresa.website ? `Sitio web: ${empresa.website}` : ''}

**PALABRAS CLAVE DEL CLIENTE:**
${Array.isArray(empresa.palabras_clave) ? empresa.palabras_clave.join(', ') : empresa.palabras_clave || 'Sin palabras clave'}|| 'Sin palabras clave'}

**OPORTUNIDAD:**
- Referencia: ${oportunidad.referencia || 'N/A'}
- Unidad de Compras: ${oportunidad.unidad_compras || 'N/A'}
- Descripción: ${oportunidad.descripcion || 'N/A'}
- Monto: ${Number(oportunidad.monto_estimado || 0).toLocaleString()} DOP
- Fecha Presentación: ${oportunidad.fecha_presentacion || 'N/A'}

**RESPONDE SOLO EN ESTE FORMATO:**
RELEVANCIA: [ALTA|MEDIA|BAJA]
QUÉ: [resumen en 5 palabras]
QUIÉN: [nombre de la entidad]
RAZÓN: [tu justificación aquí]${formatoRegion}`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });

    const respuesta = message.content[0].text;

    const relevanciaMatch = respuesta.match(/RELEVANCIA:\s*(ALTA|MEDIA|BAJA)/i);
    const queMatch        = respuesta.match(/QUÉ:\s*(.+)/i);
    const quienMatch      = respuesta.match(/QUIÉN:\s*(.+)/i);
    const razonMatch      = respuesta.match(/RAZÓN:\s*(.+)/i);
    const regionMatch     = respuesta.match(/REGIÓN:\s*(.+)/i);

    const regionInferida = regionMatch ? regionMatch[1].trim() : null;
    const regionFinal = regionLicitacion
      || (regionInferida && regionInferida !== 'Nacional' ? regionInferida : null);

    return {
      ...oportunidad,
      relevancia:        relevanciaMatch ? relevanciaMatch[1].toUpperCase() : 'MEDIA',
      que:               queMatch   ? queMatch[1].trim()   : oportunidad.descripcion?.substring(0, 50) || 'N/A',
      quien:             quienMatch ? quienMatch[1].trim() : oportunidad.unidad_compras || 'N/A',
      razon:             razonMatch ? razonMatch[1].trim() : 'Análisis IA no disponible',
      region_licitacion: regionFinal
    };

  } catch (error) {
    console.error('Error en análisis IA:', error);
    return {
      ...oportunidad,
      relevancia:        'MEDIA',
      que:               oportunidad.descripcion?.substring(0, 50) || 'N/A',
      quien:             oportunidad.unidad_compras || 'N/A',
      razon:             'Error en análisis IA',
      region_licitacion: regionLicitacion
    };
  }
}

// ============================================================================
// ANÁLISIS DIARIO
// ============================================================================

async function analizarDiario() {
  console.log('\n📊 PASO 1: ANÁLISIS DE OPORTUNIDADES\n');

  try {
    const empresasRes = await pool.query(`
      SELECT e.id, e.nombre, e.descripcion, e.palabras_clave, e.exclusiones,
             e.monto_minimo_alta, e.plan, e.familias_unspsc, e.regiones_interes, e.website,
             u.email as owner_email, u.referido_codigo
      FROM empresas e
      JOIN usuarios u ON u.empresa_id = e.id
      WHERE u.activo = true AND e.palabras_clave IS NOT NULL
    `);

    const empresas = empresasRes.rows.filter(emp => {
      const pc = Array.isArray(emp.palabras_clave)
        ? emp.palabras_clave.join(', ')
        : (emp.palabras_clave || '');
      return pc.trim().length > 0;
    });

    console.log(`✅ ${empresas.length} empresas activas\n`);
    let empresasProcesadas = 0;

    if (empresas.length === 0) {
      return { resultados: [], empresasProcesadas: 0 };
    }

    const resultadosPorEmpresa = [];

    for (const empresa of empresas) {
      empresasProcesadas++;
      console.log(`\n📊 ${empresa.nombre} (${empresa.plan})`);

      const historialRes = await pool.query(
        'SELECT COUNT(*) as total FROM resultados WHERE empresa_id = $1',
        [empresa.id]
      );
      const esEmpresaNueva = parseInt(historialRes.rows[0].total) === 0;

      let licitaciones;
      if (esEmpresaNueva) {
        console.log('   🆕 Empresa nueva - Analizando mas recientes 400 licitaciones abiertas');
        const r = await pool.query(`
          SELECT * FROM licitaciones
          WHERE fecha_presentacion > NOW()
          ORDER BY scrapeado_en DESC LIMIT 400
        `);
        licitaciones = r.rows;
      } else {
        console.log('   📅 Empresa existente - Analizando licitaciones de hoy');
        const r = await pool.query(`
          SELECT * FROM licitaciones
          WHERE DATE(scrapeado_en) = CURRENT_DATE
          ORDER BY scrapeado_en DESC
        `);
        licitaciones = r.rows;
      }

      console.log(`   📊 Total a revisar: ${licitaciones.length}`);
      // Excluir procedimientos de excepción no competitivos (PEPU y PEEX)
	        const antePepuPeex = licitaciones.length;
	        licitaciones = licitaciones.filter(l => !/-(PEPU|PEEX)-/i.test(l.referencia || ''));
	        if (licitaciones.length < antePepuPeex) {
	          console.log(`   🚫 Excluidas PEPU/PEEX: ${antePepuPeex - licitaciones.length}`);
      }

      if (empresa.familias_unspsc && empresa.familias_unspsc.length > 0) {
        const antes = licitaciones.length;
        licitaciones = licitaciones.filter(lic => {
          if (lic.codigo_unspsc && lic.codigo_unspsc !== '99-99') {
            return empresa.familias_unspsc.includes(lic.codigo_unspsc);
          }
          return true;
        });
        console.log(`   ✂️  Filtradas por UNSPSC: ${antes} → ${licitaciones.length}`);
      } else {
        console.log(`   ⚠️  Sin familias UNSPSC configuradas`);
      }

      if (licitaciones.length === 0) {
        console.log('   ⚠️  No hay licitaciones después del filtro UNSPSC');
        continue;
      }

      const yaAnalizadasRes = await pool.query(`
        SELECT DISTINCT referencia FROM resultados
        WHERE empresa_id = $1 AND referencia = ANY($2)
      `, [empresa.id, licitaciones.map(l => l.referencia)]);

      const referenciasAnalizadas = new Set(yaAnalizadasRes.rows.map(r => r.referencia));
      const licitacionesPorAnalizar = licitaciones.filter(l => !referenciasAnalizadas.has(l.referencia));

      console.log(`   Ya analizadas: ${referenciasAnalizadas.size} | Por analizar: ${licitacionesPorAnalizar.length}`);

      if (licitacionesPorAnalizar.length === 0) {
        console.log(`   ⏭️  Todo ya analizado`);
        continue;
      }

      // Recopilar ejemplos de licitaciones que este cliente rechazó (feedback negativo)
	        const descartadasFeedbackRes = await pool.query(`
	          SELECT l.descripcion FROM resultados r
	          JOIN licitaciones l ON r.licitacion_id = l.id
	          WHERE r.empresa_id = $1 AND r.descartada = TRUE
	          ORDER BY r.created_at DESC LIMIT 8
	        `, [empresa.id]);
	        const ejemplosDescartados = descartadasFeedbackRes.rows
        .map(r => r.descripcion).filter(Boolean);

      const paraAnalizarIA = [];
      for (const licitacion of licitacionesPorAnalizar) {
        const resultado = await procesarEtapa1(licitacion, empresa);
        if (resultado.pasa_etapa1) paraAnalizarIA.push(licitacion);
      }

      console.log(`   Pre-filtro: ${paraAnalizarIA.length}/${licitacionesPorAnalizar.length} pasan a IA`);

      if (paraAnalizarIA.length === 0) continue;

      console.log(`   🤖 Analizando con IA...`);
      const oportunidades = [];

      for (let i = 0; i < paraAnalizarIA.length; i++) {
        const licitacion = paraAnalizarIA[i];
        process.stdout.write(`   [${i+1}/${paraAnalizarIA.length}]\r`);

        async function analizarConIA(oportunidad, empresa, descartadasRecientes = []) {

        const montoMinimo = empresa.monto_minimo_alta || 500000;
        const montoOportunidad = parseFloat(analisis.monto_estimado || 0);

        if (analisis.relevancia === 'ALTA' && montoOportunidad < montoMinimo) {
          analisis.relevancia = 'MEDIA';
          analisis.razon = `Monto ${montoOportunidad.toLocaleString()} DOP menor al mínimo. ${analisis.razon}`;
        }

        const regionesEmpresa = Array.isArray(empresa.regiones_interes)
          ? empresa.regiones_interes.filter(r => r !== 'Nacional')
          : [];

        if (
          analisis.relevancia === 'ALTA'
          && regionesEmpresa.length > 0
          && analisis.region_licitacion
          && analisis.region_licitacion !== 'Nacional'   // FIX: Nacional siempre válido
          && !regionesEmpresa.includes(analisis.region_licitacion)
        ) {
          analisis.relevancia = 'MEDIA';
          analisis.razon = `Región ${analisis.region_licitacion} fuera del área configurada. ${analisis.razon}`;
        }

        oportunidades.push(analisis);
      }

      const alta  = oportunidades.filter(o => o.relevancia === 'ALTA');
      const media = oportunidades.filter(o => o.relevancia === 'MEDIA');
      const baja  = oportunidades.filter(o => o.relevancia === 'BAJA');

      console.log(`\n   Resultados: ALTA=${alta.length}, MEDIA=${media.length}, BAJA=${baja.length}`);

      if (oportunidades.length > 0) {
        await guardarAnalisisEnBD(empresa.id, licitacionesPorAnalizar, oportunidades);
      }

      resultadosPorEmpresa.push({
        empresa_id:          empresa.id,
        nombre:              empresa.nombre,
        email:               empresa.owner_email,
        plan:                empresa.plan,
        total:               oportunidades.length,
        alta:                alta.length,
        media:               media.length,
        baja:                baja.length,
        oportunidades_alta:  alta,
        oportunidades_media: media,
        referido_codigo:     empresa.referido_codigo || null,
      });
    }

    return { resultados: resultadosPorEmpresa, empresasProcesadas };

  } catch (error) {
    console.error('\n❌ Error en análisis:', error);
    throw error;
  }
}

// ============================================================================
// GUARDAR EN BD
// ============================================================================

async function guardarAnalisisEnBD(empresaId, licitaciones, oportunidades) {
  try {
    const alta  = oportunidades.filter(o => o.relevancia === 'ALTA').length;
    const media = oportunidades.filter(o => o.relevancia === 'MEDIA').length;
    const baja  = oportunidades.filter(o => o.relevancia === 'BAJA').length;

    const analisisRes = await pool.query(`
      INSERT INTO analisis (
        empresa_id, total_descripciones, total_alta, total_media, total_baja, porcentaje_alta
      ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
    `, [
      empresaId, licitaciones.length, alta, media, baja,
      licitaciones.length > 0 ? Math.round((alta / licitaciones.length) * 100) : 0
    ]);

    const analisisId = analisisRes.rows[0].id;

    for (const oportunidad of oportunidades) {
      const licitacionRes = await pool.query(
        'SELECT id FROM licitaciones WHERE referencia = $1 LIMIT 1',
        [oportunidad.referencia]
      );

      const licitacionId = licitacionRes.rows.length > 0 ? licitacionRes.rows[0].id : null;
      if (!licitacionId) {
        console.warn(`⚠️  No se encontró licitacion_id para: ${oportunidad.referencia}`);
        continue;
      }

      // No insertar si el usuario descartó esta licitación
	        const descartadaCheck = await pool.query(
	          'SELECT id FROM resultados WHERE empresa_id = $1 AND licitacion_id = $2 AND descartada = TRUE LIMIT 1',
	          [empresaId, licitacionId]
	        );
	        if (descartadaCheck.rows.length > 0) {
	          console.log(`   ⏭️  Saltando ${oportunidad.referencia} (descartada por usuario)`);
	          continue;
      }

      await pool.query(`
        INSERT INTO resultados (
          analisis_id, empresa_id, licitacion_id, referencia, unidad_compras,
          descripcion, fecha_presentacion, monto_estimado, estado,
          relevancia, que, quien, razon, origen, vista, notificada
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      `, [
        analisisId, empresaId, licitacionId,
        oportunidad.referencia || '',
        oportunidad.unidad_compras || '',
        oportunidad.descripcion || '',
        oportunidad.fecha_presentacion,
        oportunidad.monto_estimado || null,
        oportunidad.estado || '',
        oportunidad.relevancia,
        oportunidad.que || '',
        oportunidad.quien || '',
        oportunidad.razon || '',
        'automatico', false, false
      ]);
    }

  } catch (error) {
    console.error('❌ Error guardando en BD:', error);
  }
}

// ============================================================================
// ENVÍO DE EMAILS
// ============================================================================

async function enviarNotificaciones(resultados) {
  console.log('\n📧 PASO 2: ENVÍO DE NOTIFICACIONES\n');

  let emailsEnviados = 0;

  for (const resultado of resultados) {
    const { nombre, email, plan, alta, media } = resultado;

    if (alta + media === 0) {
      console.log(`   ⏭️  ${nombre}: Sin oportunidades relevantes`);
      continue;
    }

    if (!email) {
      console.log(`   ⚠️  ${nombre}: Sin email registrado`);
      continue;
    }

    const htmlBody = generarEmailSegunPlan(resultado);
    if (!htmlBody) {
      console.log(`   ⚠️  ${nombre}: Plan "${plan}" sin plantilla`);
      continue;
    }

    try {
      await resend.emails.send({
        from: 'Compita <notificaciones@compita.umbusk.com>',
        to: email,
        subject: `🎯 ${alta + media} nueva${alta + media > 1 ? 's' : ''} oportunidad${alta + media > 1 ? 'es' : ''} detectada${alta + media > 1 ? 's' : ''} para ${nombre}`,
        html: htmlBody
      });

      const todasReferencias = [
        ...resultado.oportunidades_alta,
        ...resultado.oportunidades_media
      ].map(o => o.referencia);

      if (todasReferencias.length > 0) {
        await pool.query(`
          UPDATE resultados SET notificada = true
          WHERE empresa_id = $1 AND referencia = ANY($2)
        `, [resultado.empresa_id, todasReferencias]);
      }

      emailsEnviados++;
      console.log(`   ✅ Email enviado a ${nombre} (${email}) — ${alta} ALTA, ${media} MEDIA`);

    } catch (error) {
      console.error(`   ❌ Error enviando email a ${nombre}:`, error.message);
    }
  }

  console.log(`\n📧 Total emails enviados: ${emailsEnviados}\n`);
  return emailsEnviados;
}

// ============================================================================
// GENERACIÓN DE EMAIL SEGÚN PLAN
// ============================================================================

function generarEmailSegunPlan(resultado) {
  const { plan, nombre, alta, media, oportunidades_alta, oportunidades_media, referido_codigo } = resultado;

  const linkReferido = referido_codigo
    ? `https://compita.umbusk.com/registro.html?ref=${referido_codigo}`
    : null;

  const footerReferido = linkReferido ? `
    <div style="margin-top:20px;padding:16px;background:#EEF2FF;border-radius:8px;text-align:center;">
      <p style="margin:0 0 8px 0;font-size:13px;color:#4F46E5;font-weight:bold;">🎁 ¿Conoces a alguien que necesite ganar licitaciones?</p>
      <p style="margin:0 0 12px 0;font-size:12px;color:#6B7280;">Invítalos a Compita y obtén un mes gratis cuando se suscriban.</p>
      <a href="${linkReferido}" style="display:inline-block;background:#4F46E5;color:white;padding:8px 20px;text-decoration:none;border-radius:6px;font-size:13px;font-weight:bold;">Compartir mi link →</a>
    </div>` : '';

  const footerFirma = `
    <p style="margin-top:30px;padding-top:20px;border-top:1px solid #E5E7EB;font-size:11px;color:#9CA3AF;text-align:center;">
      Compita - Sistema de Análisis de Licitaciones con IA
    </p>`;

  if (plan === 'trial_gratuito' || plan === 'free_trial') {
    return `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <h2 style="color:#4F46E5;">🎯 Nuevas Oportunidades Detectadas</h2>
        <p>Hola,</p>
        <p>Compita ha detectado <strong>${alta + media} nuevas oportunidades</strong> que podrían interesarte.</p>
        <div style="background:#F3F4F6;padding:30px;border-radius:8px;text-align:center;margin:20px 0;">
          <p style="font-size:36px;font-weight:bold;margin:0;color:#4F46E5;">${alta + media}</p>
          <p style="margin:10px 0 0 0;color:#6B7280;font-size:18px;">oportunidades esperando</p>
        </div>
        <a href="${DASHBOARD_URL}" style="display:inline-block;background:#4F46E5;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;margin:20px 0;font-weight:bold;">Ver en Dashboard →</a>
        <p style="margin-top:30px;padding-top:20px;border-top:1px solid #E5E7EB;font-size:12px;color:#6B7280;">💡 Actualiza a un plan de pago para recibir detalles completos en el email.</p>
        ${footerReferido}${footerFirma}
      </div>`;
  }

  if (plan === 'estandar') {
    const todasOportunidades = [...oportunidades_alta, ...oportunidades_media];
    return `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <h2 style="color:#4F46E5;">🎯 Nuevas Oportunidades - Resumen</h2>
        <p>Hola,</p>
        <p>Compita encontró <strong>${alta} de ALTA</strong> y <strong>${media} de MEDIA</strong> relevancia:</p>
        ${todasOportunidades.slice(0, 5).map(op => `
          <div style="border-left:4px solid ${op.relevancia === 'ALTA' ? '#10B981' : '#F59E0B'};padding:12px 15px;margin:15px 0;background:#F9FAFB;border-radius:4px;">
            <p style="margin:0;font-weight:bold;color:${op.relevancia === 'ALTA' ? '#10B981' : '#F59E0B'};font-size:12px;">${op.relevancia}</p>
            <p style="margin:8px 0 5px 0;font-weight:bold;font-size:15px;color:#1F2937;">${op.referencia}</p>
            <p style="margin:5px 0;color:#6B7280;font-size:14px;">${op.que}</p>
            <div style="display:flex;justify-content:space-between;margin-top:8px;">
              <span style="font-size:14px;font-weight:bold;color:#4F46E5;">${Number(op.monto_estimado || 0).toLocaleString()} DOP</span>
              <span style="font-size:13px;color:#6B7280;">Cierre: ${op.fecha_presentacion || 'N/A'}</span>
            </div>
          </div>`).join('')}
        ${todasOportunidades.length > 5 ? `<p style="color:#6B7280;text-align:center;">+ ${todasOportunidades.length - 5} más en el dashboard</p>` : ''}
        <a href="${DASHBOARD_URL}" style="display:block;background:#4F46E5;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;margin:20px auto;text-align:center;font-weight:bold;">Ver Todas en Dashboard →</a>
        ${footerReferido}${footerFirma}
      </div>`;
  }

  if (plan === 'business') {
    const todasOportunidades = [...oportunidades_alta, ...oportunidades_media];
    return `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <h2 style="color:#4F46E5;">🎯 Nuevas Oportunidades - Análisis Completo</h2>
        <p>Hola,</p>
        <p>Compita encontró <strong>${alta} de ALTA</strong> y <strong>${media} de MEDIA</strong> relevancia:</p>
        ${todasOportunidades.map(op => `
          <div style="border:1px solid #E5E7EB;border-radius:8px;padding:15px;margin:15px 0;background:white;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
              <span style="background:${op.relevancia === 'ALTA' ? '#10B981' : '#F59E0B'};color:white;padding:4px 12px;border-radius:4px;font-size:12px;font-weight:bold;">${op.relevancia}</span>
              <span style="font-size:18px;font-weight:bold;color:#1F2937;">${Number(op.monto_estimado || 0).toLocaleString()} DOP</span>
            </div>
            <p style="margin:8px 0;font-weight:bold;font-size:16px;color:#111827;">${op.referencia}</p>
            <p style="margin:8px 0;color:#4B5563;"><strong>Qué:</strong> ${op.que}</p>
            <p style="margin:8px 0;color:#4B5563;"><strong>Quién:</strong> ${op.quien}</p>
            <p style="margin:8px 0;color:#4B5563;"><strong>Cierre:</strong> ${op.fecha_presentacion || 'N/A'}</p>
            <div style="background:#F9FAFB;padding:12px;border-radius:4px;margin-top:12px;">
              <p style="margin:0 0 5px 0;font-size:13px;color:#6B7280;font-weight:bold;">Por qué es relevante:</p>
              <p style="margin:0;font-size:13px;color:#374151;line-height:1.5;">${op.razon}</p>
            </div>
          </div>`).join('')}
        <a href="${DASHBOARD_URL}" style="display:block;background:#10B981;color:white;padding:14px 28px;text-decoration:none;border-radius:6px;margin:20px auto;text-align:center;font-weight:bold;font-size:16px;">Ir al Dashboard →</a>
        ${footerReferido}${footerFirma}
      </div>`;
  }

  return '';
}

// ============================================================================
// CONFIGURACIÓN VERCEL
// ============================================================================

export const config = {
  maxDuration: 300,
};