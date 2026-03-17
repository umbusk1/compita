/*
COMPITA - Análisis Diario y Notificaciones (Endpoint Vercel)
=============================================================
Analiza licitaciones nuevas para cada empresa activa y envía emails personalizados.

✨ ACTUALIZACIÓN: Filtro por familias UNSPSC para optimizar costos de Claude AI

Fecha: 28 de enero 2026
Autor: Desarrollo para Moisesp/Compita
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
// HANDLER PRINCIPAL (Vercel Serverless Function)
// ============================================================================

export default async function handler(req, res) {
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

  console.log('\n🔄 ╔══════════════════════════════════════════════════════════╗');
  console.log('   COMPITA - ANÁLISIS Y NOTIFICACIONES DIARIAS');
  console.log('🔄 ╚══════════════════════════════════════════════════════════╝\n');

  try {
    const { resultados, empresasProcesadas } = await analizarDiario();

    let emailsEnviados = 0;
    if (resultados.length > 0) {
      emailsEnviados = await enviarNotificaciones(resultados);
    } else {
      console.log('⚠️  No hay resultados para notificar\n');
    }

    const duracionTotal = ((Date.now() - inicioTotal) / 1000).toFixed(1);

    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('📊 RESUMEN FINAL');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log(`✅ Empresas procesadas: ${empresasProcesadas}`);
    console.log(`📧 Notificaciones enviadas: ${emailsEnviados}`);
    console.log(`⏱️  Duración: ${duracionTotal} segundos`);
    console.log('╚══════════════════════════════════════════════════════════╝\n');

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
// FUNCIONES DE ANÁLISIS
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

  const palabrasClave = (
    Array.isArray(empresa.palabras_clave)
      ? empresa.palabras_clave
      : (empresa.palabras_clave || '').split(',')
  ).map(p => p.trim().toLowerCase()).filter(p => p.length > 0);

  const textoCompleto = (oportunidad.descripcion || '').toLowerCase();

  let palabraEncontrada = null;
    const tieneCoincidencia = palabrasClave.some(palabra => {
      const esExpresion = palabra.includes(' ');
      let regex;
      if (esExpresion) {
        // Expresión multi-palabra → buscar frase exacta sin stemming
        const expresionEscapada = palabra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(expresionEscapada, 'i');
      } else {
        // Palabra simple → stemming básico
        const raiz = palabra.endsWith('s') ? palabra.slice(0, -1) : palabra;
        const palabraEscapada = raiz.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp('\\b' + palabraEscapada + 's?\\b', 'i');
      }
      const encontrada = regex.test(textoCompleto);
      if (encontrada) { palabraEncontrada = palabra; return true; }
      return false;
  });

  if (!tieneCoincidencia) {
    return { pasa_etapa1: false, razon: 'No contiene palabras clave relevantes' };
  }

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
	        const raiz = exclusion.endsWith('s') ? exclusion.slice(0, -1) : exclusion;
	        const palabraEscapada = raiz.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	        regex = new RegExp('\\b' + palabraEscapada + 's?\\b', 'i');
	      }
	      if (regex.test(textoCompleto)) {
	        return {
	          pasa_etapa1: false,
	          razon: `Contiene exclusión: ${exclusion}`
	        };
	      }
    }

  const estado = oportunidad.estado || '';
  if (!estado) {
    return { pasa_etapa1: false, razon: 'Sin estado definido' };
  }

  return { pasa_etapa1: true };
}

// ============================================================================
// CAMBIO 2 — Nueva función: obtenerRegionLicitacion()
// Agrégala ANTES de la función analizarConIA()
// ============================================================================

async function obtenerRegionLicitacion(unidad_compras) {
  if (!unidad_compras) return null;

  // Primero: buscar en tabla de mapeo directo (instituciones_region)
  const directa = await pool.query(`
    SELECT region FROM instituciones_region
    WHERE unidad_compras = $1
    LIMIT 1
  `, [unidad_compras]);

  if (directa.rows.length > 0) {
    return directa.rows[0].region;
  }

  // Segundo: buscar por coincidencia de municipio (regiones_rd)
  const porMunicipio = await pool.query(`
    SELECT region FROM regiones_rd
    WHERE $1 ILIKE '%' || municipio || '%'
    ORDER BY LENGTH(municipio) DESC
    LIMIT 1
  `, [unidad_compras]);

  if (porMunicipio.rows.length > 0) {
    return porMunicipio.rows[0].region;
  }

  // Sin señal geográfica → institución nacional
  return null;
}

// ============================================================================
// CAMBIO 3 — Reemplaza la función analizarConIA() completa
// Agrega sección geográfica al prompt cuando la institución es nacional
// ============================================================================

async function analizarConIA(oportunidad, empresa) {

  // Obtener región de la licitación desde las tablas de referencia
  const regionLicitacion = await obtenerRegionLicitacion(oportunidad.unidad_compras);

  // Sección geográfica del prompt: solo se incluye si la institución
  // es nacional (sin región en tablas) Y la empresa tiene preferencias
  const regionesEmpresa = Array.isArray(empresa.regiones_interes)
    ? empresa.regiones_interes.filter(r => r !== 'Nacional')
    : [];

  const seccionGeografica = (!regionLicitacion && regionesEmpresa.length > 0)
    ? `
**ANÁLISIS GEOGRÁFICO (solo si aplica):**
La institución "${oportunidad.unidad_compras}" es de alcance nacional.
Busca en la descripción cualquier señal geográfica (nombres de municipios,
provincias, regiones, o frases como "en la provincia de X", "en la zona Y").
Si encuentras una señal clara, indícala en REGIÓN. Si no hay señal, responde "Nacional".
Las regiones oficiales de RD son: Ozama, Cibao Norte, Cibao Sur, Cibao Nordeste,
Cibao Noroeste, Valdesia, El Valle, Enriquillo, Yuma, Higuamo.
`
    : '';

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
${seccionGeografica}
**IMPORTANTE**: Evalúa SOLO la relevancia temática. El sistema aplicará filtros adicionales de monto y región automáticamente.

**PERFIL DEL CLIENTE:**
${empresa.descripcion || 'Cliente sin descripción'}

**PALABRAS CLAVE DEL CLIENTE:**
${Array.isArray(empresa.palabras_clave) ? empresa.palabras_clave.join(', ') : empresa.palabras_clave || 'Sin palabras clave'}

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
    const queMatch       = respuesta.match(/QUÉ:\s*(.+)/i);
    const quienMatch     = respuesta.match(/QUIÉN:\s*(.+)/i);
    const razonMatch     = respuesta.match(/RAZÓN:\s*(.+)/i);
    const regionMatch    = respuesta.match(/REGIÓN:\s*(.+)/i);

    // Región final: la de las tablas tiene prioridad; si no, la que infirió Claude
    const regionInferida = regionMatch ? regionMatch[1].trim() : null;
    const regionFinal = regionLicitacion
      || (regionInferida && regionInferida !== 'Nacional' ? regionInferida : null);

    return {
      ...oportunidad,
      relevancia:       relevanciaMatch ? relevanciaMatch[1].toUpperCase() : 'MEDIA',
      que:              queMatch   ? queMatch[1].trim()   : oportunidad.descripcion?.substring(0, 50) || 'N/A',
      quien:            quienMatch ? quienMatch[1].trim() : oportunidad.unidad_compras || 'N/A',
      razon:            razonMatch ? razonMatch[1].trim() : 'Análisis IA no disponible',
      region_licitacion: regionFinal   // nuevo campo para usar en el paso siguiente
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
  console.log('\n📊 PASO 1: ANÁLISIS DE OPORTUNIDADES');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  try {
    console.log('🏢 Obteniendo empresas activas...');

    const queryText = `
      SELECT
        e.id,
        e.nombre,
        e.descripcion,
        e.palabras_clave,
        e.exclusiones,
        e.monto_minimo_alta,
        e.plan,
        e.familias_unspsc,
        e.regiones_interes,
        u.email as owner_email,
        u.referido_codigo
      FROM empresas e
      JOIN usuarios u ON u.empresa_id = e.id
      WHERE u.activo = true
        AND e.palabras_clave IS NOT NULL
    `;

    const empresasRes = await pool.query(queryText);

    const empresas = empresasRes.rows.filter(emp => {
      let palabrasClave = emp.palabras_clave;
      if (Array.isArray(palabrasClave)) {
        palabrasClave = palabrasClave.join(', ');
      }
      return palabrasClave && palabrasClave.trim().length > 0;
    });

    console.log(`✅ ${empresas.length} empresas activas\n`);
    let empresasProcesadas = 0;

    if (empresas.length === 0) {
      console.log('⚠️  No hay empresas activas');
      return { resultados: [], empresasProcesadas: 0 };
    }

    const resultadosPorEmpresa = [];

    for (const empresa of empresas) {
      empresasProcesadas++;
      console.log(`\n📊 ${empresa.nombre} (${empresa.plan})`);

      const historialRes = await pool.query(`
        SELECT COUNT(*) as total
        FROM resultados
        WHERE empresa_id = $1
      `, [empresa.id]);

      const esEmpresaNueva = parseInt(historialRes.rows[0].total) === 0;

      let licitaciones;
      if (esEmpresaNueva) {
        console.log('   🆕 Empresa nueva - Analizando últimas 100 licitaciones abiertas');
        console.log('   💡 Tip: Configure familias UNSPSC para filtrar automáticamente');
        const licitacionesRes = await pool.query(`
          SELECT * FROM licitaciones
          WHERE fecha_presentacion > NOW()
          ORDER BY scrapeado_en DESC
          LIMIT 100
        `);
        licitaciones = licitacionesRes.rows;
      } else {
        console.log('   📅 Empresa existente - Analizando solo licitaciones de hoy');
        const licitacionesRes = await pool.query(`
          SELECT * FROM licitaciones
          WHERE DATE(scrapeado_en) = CURRENT_DATE
          ORDER BY scrapeado_en DESC
        `);
        licitaciones = licitacionesRes.rows;
      }

      console.log(`   📊 Total licitaciones a revisar: ${licitaciones.length}`);

      let licitacionesFiltradas = licitaciones;
      if (empresa.familias_unspsc && empresa.familias_unspsc.length > 0) {
        licitacionesFiltradas = licitaciones.filter(lic => {
          if (lic.codigo_unspsc && lic.codigo_unspsc !== '99-99') {
            return empresa.familias_unspsc.includes(lic.codigo_unspsc);
          }
          return true;
        });

        console.log(`   🏷️  Familias UNSPSC seleccionadas: ${empresa.familias_unspsc.join(', ')}`);
        console.log(`   ✂️  Filtradas por UNSPSC: ${licitaciones.length} → ${licitacionesFiltradas.length}`);

        licitaciones = licitacionesFiltradas;
      } else {
        console.log(`   ⚠️  Sin familias UNSPSC configuradas - analizando todas`);
      }

      if (licitaciones.length === 0) {
        console.log('   ⚠️  No hay licitaciones después del filtro UNSPSC');
        continue;
      }

      const yaAnalizadasRes = await pool.query(`
        SELECT DISTINCT referencia
        FROM resultados
        WHERE empresa_id = $1
          AND referencia = ANY($2)
      `, [empresa.id, licitaciones.map(l => l.referencia)]);

      const referenciasAnalizadas = new Set(
        yaAnalizadasRes.rows.map(r => r.referencia)
      );

      const licitacionesPorAnalizar = licitaciones.filter(
        l => !referenciasAnalizadas.has(l.referencia)
      );

      console.log(`   Ya analizadas: ${referenciasAnalizadas.size}`);
      console.log(`   Por analizar: ${licitacionesPorAnalizar.length}`);

      if (licitacionesPorAnalizar.length === 0) {
        console.log(`   ⏭️  Todo ya analizado`);
        continue;
      }

      const paraAnalizarIA = [];
      for (const licitacion of licitacionesPorAnalizar) {
        const resultado = await procesarEtapa1(licitacion, empresa);
        if (resultado.pasa_etapa1) {
          paraAnalizarIA.push(licitacion);
        }
      }

      console.log(`   Pre-filtro: ${paraAnalizarIA.length}/${licitacionesPorAnalizar.length} pasan a IA`);

      if (paraAnalizarIA.length === 0) {
        continue;
      }

      console.log(`   🤖 Analizando con IA...`);
      const oportunidades = [];

      for (let i = 0; i < paraAnalizarIA.length; i++) {
        const licitacion = paraAnalizarIA[i];
        process.stdout.write(`   [${i+1}/${paraAnalizarIA.length}]\r`);

        const analisis = await analizarConIA(licitacion, empresa);

		const montoMinimo = empresa.monto_minimo_alta || 500000;
        const montoOportunidad = parseFloat(analisis.monto_estimado || 0);

        // Degradación por monto (ya existía)
        if (analisis.relevancia === 'ALTA' && montoOportunidad < montoMinimo) {
          analisis.relevancia = 'MEDIA';
          analisis.razon = `Monto ${montoOportunidad.toLocaleString()} DOP menor al mínimo. ${analisis.razon}`;
        }

        // Degradación por región (nueva)
        const regionesEmpresa = Array.isArray(empresa.regiones_interes)
          ? empresa.regiones_interes.filter(r => r !== 'Nacional')
          : [];

        if (
          analisis.relevancia === 'ALTA'   // solo degrada ALTA
          && regionesEmpresa.length > 0    // empresa tiene preferencia regional
          && analisis.region_licitacion    // conocemos la región de la licitación
          && !regionesEmpresa.includes(analisis.region_licitacion) // no está en sus regiones
        ) {
          analisis.relevancia = 'MEDIA';
          analisis.razon = `Región ${analisis.region_licitacion} fuera del área de operación. ${analisis.razon}`;
        }

        oportunidades.push(analisis);
      }

      const alta = oportunidades.filter(o => o.relevancia === 'ALTA');
      const media = oportunidades.filter(o => o.relevancia === 'MEDIA');
      const baja = oportunidades.filter(o => o.relevancia === 'BAJA');

      console.log(`\n   Resultados: ALTA=${alta.length}, MEDIA=${media.length}, BAJA=${baja.length}`);

      if (oportunidades.length > 0) {
        await guardarAnalisisEnBD(empresa.id, licitacionesPorAnalizar, oportunidades);
      }

      resultadosPorEmpresa.push({
        empresa_id: empresa.id,
        nombre: empresa.nombre,
        email: empresa.owner_email,
        plan: empresa.plan,
        total: oportunidades.length,
        alta: alta.length,
        media: media.length,
        baja: baja.length,
        oportunidades_alta: alta,
        referido_codigo: empresa.referido_codigo || null,
        oportunidades_media: media
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
    const alta = oportunidades.filter(o => o.relevancia === 'ALTA').length;
    const media = oportunidades.filter(o => o.relevancia === 'MEDIA').length;
    const baja = oportunidades.filter(o => o.relevancia === 'BAJA').length;

    const analisisRes = await pool.query(`
      INSERT INTO analisis (
        empresa_id,
        total_descripciones,
        total_alta,
        total_media,
        total_baja,
        porcentaje_alta
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [
      empresaId,
      licitaciones.length,
      alta,
      media,
      baja,
      licitaciones.length > 0 ? Math.round((alta / licitaciones.length) * 100) : 0
    ]);

    const analisisId = analisisRes.rows[0].id;

    for (const oportunidad of oportunidades) {
      const licitacionRes = await pool.query(
        'SELECT id FROM licitaciones WHERE referencia = $1 LIMIT 1',
        [oportunidad.referencia]
      );

      const licitacionId = licitacionRes.rows.length > 0
        ? licitacionRes.rows[0].id
        : null;

      if (!licitacionId) {
        console.warn(`⚠️  No se encontró licitacion_id para referencia: ${oportunidad.referencia}`);
        continue;
      }

      await pool.query(`
        INSERT INTO resultados (
          analisis_id,
          empresa_id,
          licitacion_id,
          referencia,
          unidad_compras,
          descripcion,
          fecha_presentacion,
          monto_estimado,
          estado,
          relevancia,
          que,
          quien,
          razon,
          origen,
          vista,
          notificada
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      `, [
        analisisId,
        empresaId,
        licitacionId,
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
        'automatico',
        false,
        false
      ]);
    }

  } catch (error) {
    console.error('❌ Error guardando en BD:', error);
  }
}

// ============================================================================
// ENVÍO DE EMAILS  ← FUNCIÓN RESTAURADA
// ============================================================================

async function enviarNotificaciones(resultados) {
  console.log('\n📧 PASO 2: ENVÍO DE NOTIFICACIONES');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  let emailsEnviados = 0;

  for (const resultado of resultados) {
    const { nombre, email, plan, alta, media } = resultado;

    // Solo enviar si hay oportunidades de ALTA o MEDIA relevancia
    if (alta + media === 0) {
      console.log(`   ⏭️  ${nombre}: Sin oportunidades relevantes, omitiendo email`);
      continue;
    }

    if (!email) {
      console.log(`   ⚠️  ${nombre}: Sin email registrado, omitiendo`);
      continue;
    }

    const htmlBody = generarEmailSegunPlan(resultado);

    if (!htmlBody) {
      console.log(`   ⚠️  ${nombre}: Plan "${plan}" sin plantilla de email, omitiendo`);
      continue;
    }

    try {
      await resend.emails.send({
        from: 'Compita <notificaciones@compita.umbusk.com>',
        to: email,
        subject: `🎯 ${alta + media} nueva${alta + media > 1 ? 's' : ''} oportunidad${alta + media > 1 ? 'es' : ''} detectada${alta + media > 1 ? 's' : ''} para ${nombre}`,
        html: htmlBody
      });

      // Marcar oportunidades como notificadas en BD
      const todasReferencias = [
        ...resultado.oportunidades_alta,
        ...resultado.oportunidades_media
      ].map(o => o.referencia);

      if (todasReferencias.length > 0) {
        await pool.query(`
          UPDATE resultados
          SET notificada = true
          WHERE empresa_id = $1
            AND referencia = ANY($2)
        `, [resultado.empresa_id, todasReferencias]);
      }

      emailsEnviados++;
      console.log(`   ✅ Email enviado a ${nombre} (${email}) — ${alta} ALTA, ${media} MEDIA`);

    } catch (error) {
      console.error(`   ❌ Error enviando email a ${nombre} (${email}):`, error.message);
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

  // Footer de referido — aparece en todos los planes
  const linkReferido = referido_codigo
    ? `https://compita.umbusk.com/registro.html?ref=${referido_codigo}`
    : null;

  const footerReferido = linkReferido ? `
    <div style="margin-top: 20px; padding: 16px; background: #EEF2FF; border-radius: 8px; text-align: center;">
      <p style="margin: 0 0 8px 0; font-size: 13px; color: #4F46E5; font-weight: bold;">
        🎁 ¿Conoces a alguien que necesite ganar licitaciones?
      </p>
      <p style="margin: 0 0 12px 0; font-size: 12px; color: #6B7280;">
        Invítalos a Compita. Ellos obtienen 37 días de prueba gratis y tú recibes un mes gratis cuando se suscriban.
      </p>
      <a href="${linkReferido}"
         style="display: inline-block; background: #4F46E5; color: white; padding: 8px 20px; text-decoration: none; border-radius: 6px; font-size: 13px; font-weight: bold;">
        Compartir mi link de invitación →
      </a>
    </div>
  ` : '';

  const footerFirma = `
    <p style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #E5E7EB; font-size: 11px; color: #9CA3AF; text-align: center;">
      Compita - Sistema de Análisis de Licitaciones con IA
    </p>
  `;

  if (plan === 'trial_gratuito' || plan === 'free_trial') {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #4F46E5;">🎯 Nuevas Oportunidades Detectadas</h2>
        <p>Hola,</p>
        <p>Compita ha detectado <strong>${alta + media} nuevas oportunidades</strong> que podrían interesarte.</p>
        <div style="background: #F3F4F6; padding: 30px; border-radius: 8px; text-align: center; margin: 20px 0;">
          <p style="font-size: 36px; font-weight: bold; margin: 0; color: #4F46E5;">${alta + media}</p>
          <p style="margin: 10px 0 0 0; color: #6B7280; font-size: 18px;">oportunidades esperando</p>
        </div>
        <a href="${DASHBOARD_URL}" style="display: inline-block; background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px 0; font-weight: bold;">
          Ver en Dashboard →
        </a>
        <p style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #E5E7EB; font-size: 12px; color: #6B7280;">
          💡 Actualiza a un plan de pago para recibir detalles completos en el email.
        </p>
        ${footerReferido}
        ${footerFirma}
      </div>
    `;
  }

  if (plan === 'estandar') {
    const todasOportunidades = [...oportunidades_alta, ...oportunidades_media];

    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #4F46E5;">🎯 Nuevas Oportunidades - Resumen</h2>
        <p>Hola,</p>
        <p>Compita encontró <strong>${alta} de ALTA</strong> y <strong>${media} de MEDIA</strong> relevancia:</p>

        ${todasOportunidades.slice(0, 5).map(op => `
          <div style="border-left: 4px solid ${op.relevancia === 'ALTA' ? '#10B981' : '#F59E0B'}; padding: 12px 15px; margin: 15px 0; background: #F9FAFB; border-radius: 4px;">
            <p style="margin: 0; font-weight: bold; color: ${op.relevancia === 'ALTA' ? '#10B981' : '#F59E0B'}; font-size: 12px;">
              ${op.relevancia}
            </p>
            <p style="margin: 8px 0 5px 0; font-weight: bold; font-size: 15px; color: #1F2937;">${op.referencia}</p>
            <p style="margin: 5px 0; color: #6B7280; font-size: 14px;">${op.que}</p>
            <div style="display: flex; justify-content: space-between; margin-top: 8px;">
              <span style="font-size: 14px; font-weight: bold; color: #4F46E5;">${Number(op.monto_estimado || 0).toLocaleString()} DOP</span>
              <span style="font-size: 13px; color: #6B7280;">Cierre: ${op.fecha_presentacion || 'N/A'}</span>
            </div>
          </div>
        `).join('')}

        ${todasOportunidades.length > 5 ? `<p style="color: #6B7280; text-align: center; margin: 20px 0;">+ ${todasOportunidades.length - 5} oportunidades más en el dashboard</p>` : ''}

        <a href="${DASHBOARD_URL}" style="display: inline-block; background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 20px auto; display: block; text-align: center; font-weight: bold;">
          Ver Todas en Dashboard →
        </a>

        ${footerReferido}
        ${footerFirma}
      </div>
    `;
  }

  if (plan === 'business') {
    const todasOportunidades = [...oportunidades_alta, ...oportunidades_media];

    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #4F46E5;">🎯 Nuevas Oportunidades - Análisis Completo</h2>
        <p>Hola,</p>
        <p>Compita encontró <strong>${alta} de ALTA</strong> y <strong>${media} de MEDIA</strong> relevancia:</p>

        ${todasOportunidades.map(op => `
          <div style="border: 1px solid #E5E7EB; border-radius: 8px; padding: 15px; margin: 15px 0; background: white;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
              <span style="background: ${op.relevancia === 'ALTA' ? '#10B981' : '#F59E0B'}; color: white; padding: 4px 12px; border-radius: 4px; font-size: 12px; font-weight: bold;">
                ${op.relevancia}
              </span>
              <span style="font-size: 18px; font-weight: bold; color: #1F2937;">
                ${Number(op.monto_estimado || 0).toLocaleString()} DOP
              </span>
            </div>

            <p style="margin: 8px 0; font-weight: bold; font-size: 16px; color: #111827;">${op.referencia}</p>
            <p style="margin: 8px 0; color: #4B5563;"><strong>Qué:</strong> ${op.que}</p>
            <p style="margin: 8px 0; color: #4B5563;"><strong>Quién:</strong> ${op.quien}</p>
            <p style="margin: 8px 0; color: #4B5563;"><strong>Cierre:</strong> ${op.fecha_presentacion || 'N/A'}</p>

            <div style="background: #F9FAFB; padding: 12px; border-radius: 4px; margin-top: 12px;">
              <p style="margin: 0 0 5px 0; font-size: 13px; color: #6B7280; font-weight: bold;">Por qué es relevante:</p>
              <p style="margin: 0; font-size: 13px; color: #374151; line-height: 1.5;">${op.razon}</p>
            </div>
          </div>
        `).join('')}

        <a href="${DASHBOARD_URL}" style="display: inline-block; background: #10B981; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; margin: 20px auto; display: block; text-align: center; font-weight: bold; font-size: 16px;">
          Ir al Dashboard →
        </a>

        ${footerReferido}
        ${footerFirma}
      </div>
    `;
  }

  return '';
}

// ============================================================================
// CONFIGURACIÓN VERCEL
// ============================================================================

export const config = {
  maxDuration: 300,
};