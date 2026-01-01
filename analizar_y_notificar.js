"""
COMPITA - Análisis Diario y Notificaciones
===========================================
Analiza licitaciones nuevas para cada empresa activa y envía emails personalizados.

Fecha: 01 de enero 2026
Autor: Desarrollo para Moisesp/Compita
"""

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

const DASHBOARD_URL = 'https://compita.umbusk.com/dashboard.html';
const LOGIN_URL = 'https://compita.umbusk.com/login.html';

// ============================================================================
// FUNCIONES DE ANÁLISIS (Reutilizadas de analizar-v4.js)
// ============================================================================

async function procesarEtapa1(oportunidad, empresa) {
  const ref = oportunidad.referencia || 'SIN-REF';

  if (!oportunidad.fecha_presentacion) {
    return { pasa_etapa1: false, razon: 'Sin fecha de presentación' };
  }

  let fechaLimite;
  try {
    const fechaOriginal = String(oportunidad.fecha_presentacion);
    const fechaLimpia = fechaOriginal.split('(')[0].trim();
    const soloFecha = fechaLimpia.split(' ')[0];
    const partes = soloFecha.split('/');

    if (partes.length === 3) {
      const dia = parseInt(partes[0], 10);
      const mes = parseInt(partes[1], 10) - 1;
      const anio = parseInt(partes[2], 10);
      fechaLimite = new Date(anio, mes, dia);
    } else {
      fechaLimite = new Date(oportunidad.fecha_presentacion);
    }

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

  // Convertir palabras_clave a string si es array
  let palabrasClaveStr = empresa.palabras_clave;
  if (Array.isArray(palabrasClaveStr)) {
    palabrasClaveStr = palabrasClaveStr.join(', ');
  }

  const palabrasClave = (palabrasClaveStr || '')
    .split(',')
    .map(p => p.trim().toLowerCase())
    .filter(p => p.length > 0);

  const textoCompleto = (oportunidad.descripcion || '').toLowerCase();

  let palabraEncontrada = null;
  const tieneCoincidencia = palabrasClave.some(palabra => {
    const raiz = palabra.endsWith('s') ? palabra.slice(0, -1) : palabra;
    const palabraEscapada = raiz.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('\\b' + palabraEscapada + 's?\\b', 'i');
    const encontrada = regex.test(textoCompleto);

    if (encontrada) {
      palabraEncontrada = palabra;
      return true;
    }
    return false;
  });

  if (!tieneCoincidencia) {
    return { pasa_etapa1: false, razon: 'No contiene palabras clave relevantes' };
  }

  if (empresa.exclusiones && empresa.exclusiones.length > 0) {
    const exclusiones = Array.isArray(empresa.exclusiones)
      ? empresa.exclusiones
      : empresa.exclusiones.split(',').map(e => e.trim()).filter(e => e.length > 0);

    const exclusionesLower = exclusiones.map(e => e.toLowerCase());

    for (const exclusion of exclusionesLower) {
      const raiz = exclusion.endsWith('s') ? exclusion.slice(0, -1) : exclusion;
      const palabraEscapada = raiz.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp('\\b' + palabraEscapada + 's?\\b', 'i');

      if (regex.test(textoCompleto)) {
        return {
          pasa_etapa1: false,
          razon: 'Contiene palabra de exclusión: ' + exclusion
        };
      }
    }
  }

  const estado = oportunidad.estado || '';
  if (!estado) {
    return { pasa_etapa1: false, razon: 'Sin estado definido' };
  }

  return { pasa_etapa1: true };
}

async function analizarConIA(oportunidad, empresa) {
  const prompt = `Eres un analista experto en licitaciones públicas. Analiza esta oportunidad para determinar:

1. **RELEVANCIA**: ¿Qué tan relevante es para el cliente?
   - ALTA: Coincidencia directa y fuerte con servicios/productos principales del cliente
   - MEDIA: Relacionado o parcialmente alineado con servicios del cliente
   - BAJA: Poco relevante o fuera del alcance

2. **QUÉ**: Extrae en máximo 5 palabras el objeto principal de la licitación
3. **QUIÉN**: Extrae la entidad que licita (nombre de la institución/unidad)
4. **RAZÓN**: Justificación breve (máximo 2 líneas)

**IMPORTANTE**: Evalúa SOLO la relevancia temática. El sistema aplicará filtros adicionales de monto automáticamente.

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
RAZÓN: [tu justificación aquí]`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });

    const respuesta = message.content[0].text;

    const relevanciaMatch = respuesta.match(/RELEVANCIA:\s*(ALTA|MEDIA|BAJA)/i);
    const queMatch = respuesta.match(/QUÉ:\s*(.+)/i);
    const quienMatch = respuesta.match(/QUIÉN:\s*(.+)/i);
    const razonMatch = respuesta.match(/RAZÓN:\s*(.+)/i);

    return {
      ...oportunidad,
      relevancia: relevanciaMatch ? relevanciaMatch[1].toUpperCase() : 'MEDIA',
      que: queMatch ? queMatch[1].trim() : oportunidad.descripcion?.substring(0, 50) || 'N/A',
      quien: quienMatch ? quienMatch[1].trim() : oportunidad.unidad_compras || 'N/A',
      razon: razonMatch ? razonMatch[1].trim() : 'Análisis IA no disponible'
    };

  } catch (error) {
    console.error('Error en análisis IA:', error);
    return {
      ...oportunidad,
      relevancia: 'MEDIA',
      que: oportunidad.descripcion?.substring(0, 50) || 'N/A',
      quien: oportunidad.unidad_compras || 'N/A',
      razon: 'Error en análisis IA'
    };
  }
}

// ============================================================================
// FUNCIÓN PRINCIPAL - ANÁLISIS DIARIO
// ============================================================================

async function analizarDiario() {
  console.log('\n' + '='*70);
  console.log('🎯 ANÁLISIS DIARIO DE OPORTUNIDADES');
  console.log('='*70 + '\n');

  try {
    // 1. Obtener empresas activas con email del owner
    console.log('📋 Obteniendo empresas activas...');
    const empresasRes = await pool.query(`
      SELECT e.*, u.email as owner_email
      FROM empresas e
      JOIN usuarios u ON u.empresa_id = e.id
      WHERE e.activo = true
      AND u.rol = 'owner'
    `);
    const empresas = empresasRes.rows;
    console.log(`✅ ${empresas.length} empresas activas encontradas\n`);

    if (empresas.length === 0) {
      console.log('⚠️  No hay empresas activas. Finalizando.');
      return [];
    }

    // 2. Obtener licitaciones de HOY
    console.log('📥 Obteniendo licitaciones scrapeadas hoy...');
    const licitacionesRes = await pool.query(`
      SELECT * FROM licitaciones
      WHERE DATE(scrapeado_en) = CURRENT_DATE
      ORDER BY scrapeado_en DESC
    `);
    const licitaciones = licitacionesRes.rows;
    console.log(`✅ ${licitaciones.length} licitaciones nuevas de hoy\n`);

    if (licitaciones.length === 0) {
      console.log('⚠️  No hay licitaciones nuevas hoy. Finalizando.');
      return [];
    }

    // 3. Analizar para cada empresa
    const resultadosPorEmpresa = [];

    for (const empresa of empresas) {
      console.log('='*70);
      console.log(`🏢 Analizando para: ${empresa.nombre}`);
      console.log(`   Plan: ${empresa.plan}`);
      console.log('='*70);

      // Etapa 1: Pre-filtrado
      const paraAnalizarIA = [];
      for (const licitacion of licitaciones) {
        const resultado = await procesarEtapa1(licitacion, empresa);
        if (resultado.pasa_etapa1) {
          paraAnalizarIA.push(licitacion);
        }
      }

      console.log(`📊 Pre-filtro: ${paraAnalizarIA.length}/${licitaciones.length} pasaron a análisis IA\n`);

      if (paraAnalizarIA.length === 0) {
        console.log('⚠️  Ninguna licitación pasó el pre-filtro\n');
        continue;
      }

      // Etapa 2: Análisis con Claude AI
      console.log('🤖 Analizando con Claude AI...');
      const oportunidades = [];

      for (let i = 0; i < paraAnalizarIA.length; i++) {
        const licitacion = paraAnalizarIA[i];
        console.log(`   [${i+1}/${paraAnalizarIA.length}] ${licitacion.referencia}...`);

        const analisis = await analizarConIA(licitacion, empresa);

        // Aplicar filtro de monto mínimo
        const montoMinimo = empresa.monto_minimo_alta || 500000;
        const montoOportunidad = parseFloat(analisis.monto_estimado || 0);

        if (analisis.relevancia === 'ALTA' && montoOportunidad < montoMinimo) {
          analisis.relevancia = 'MEDIA';
          analisis.razon = `Relevancia temática alta pero monto ${montoOportunidad.toLocaleString()} DOP menor a ${montoMinimo.toLocaleString()} DOP. ${analisis.razon}`;
        }

        oportunidades.push(analisis);
      }

      const alta = oportunidades.filter(o => o.relevancia === 'ALTA');
      const media = oportunidades.filter(o => o.relevancia === 'MEDIA');
      const baja = oportunidades.filter(o => o.relevancia === 'BAJA');

      console.log(`\n📈 Resultados:`);
      console.log(`   ALTA: ${alta.length}`);
      console.log(`   MEDIA: ${media.length}`);
      console.log(`   BAJA: ${baja.length}\n`);

      // Guardar resultados en BD
      if (oportunidades.length > 0) {
        await guardarAnalisisEnBD(empresa.id, licitaciones.length, oportunidades);
      }

      // Agregar a resultados
      resultadosPorEmpresa.push({
        empresa_id: empresa.id,
        nombre: empresa.nombre,
        email: empresa.owner_email, // Email del owner
        plan: empresa.plan,
        total: oportunidades.length,
        alta: alta.length,
        media: media.length,
        baja: baja.length,
        oportunidades_alta: alta,
        oportunidades_media: media
      });
    }

    return resultadosPorEmpresa;

  } catch (error) {
    console.error('\n❌ Error en análisis diario:', error);
    throw error;
  }
}

// ============================================================================
// GUARDAR EN BASE DE DATOS
// ============================================================================

async function guardarAnalisisEnBD(empresaId, totalLicitaciones, oportunidades) {
  console.log('💾 Guardando análisis en base de datos...');

  try {
    const alta = oportunidades.filter(o => o.relevancia === 'ALTA').length;
    const media = oportunidades.filter(o => o.relevancia === 'MEDIA').length;
    const baja = oportunidades.filter(o => o.relevancia === 'BAJA').length;

    // Crear registro de análisis
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
      totalLicitaciones,
      alta,
      media,
      baja,
      totalLicitaciones > 0 ? Math.round((alta / totalLicitaciones) * 100) : 0
    ]);

    const analisisId = analisisRes.rows[0].id;

    // Guardar cada resultado
    for (const oportunidad of oportunidades) {
      const fechaISO = convertirFechaParaDB(oportunidad.fecha_presentacion);

      await pool.query(`
        INSERT INTO resultados (
          analisis_id,
          empresa_id,
          referencia,
          unidad_compras,
          descripcion,
          fecha_presentacion,
          monto_estimado,
          estado,
          relevancia,
          que,
          quien,
          razon
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [
        analisisId,
        empresaId,
        oportunidad.referencia || '',
        oportunidad.unidad_compras || '',
        oportunidad.descripcion || '',
        fechaISO,
        oportunidad.monto_estimado || null,
        oportunidad.estado || '',
        oportunidad.relevancia,
        oportunidad.que || '',
        oportunidad.quien || '',
        oportunidad.razon || ''
      ]);
    }

    console.log(`✅ Análisis guardado (ID: ${analisisId})\n`);

  } catch (error) {
    console.error('❌ Error guardando en BD:', error);
  }
}

function convertirFechaParaDB(fechaStr) {
  if (!fechaStr) return null;

  try {
    const fechaLimpia = String(fechaStr).split('(')[0].trim();
    const soloFecha = fechaLimpia.split(' ')[0];
    const partes = soloFecha.split('/');

    if (partes.length === 3) {
      const dia = String(partes[0]).padStart(2, '0');
      const mes = String(partes[1]).padStart(2, '0');
      const anio = partes[2];
      return `${anio}-${mes}-${dia}`;
    }
    return null;
  } catch (err) {
    return null;
  }
}

// ============================================================================
// ENVÍO DE EMAILS
// ============================================================================

async function enviarNotificaciones(resultados) {
  console.log('\n' + '='*70);
  console.log('📧 ENVIANDO NOTIFICACIONES');
  console.log('='*70 + '\n');

  let emailsEnviados = 0;

  for (const resultado of resultados) {
    const totalOportunidades = resultado.alta + resultado.media;

    // No enviar si no hay oportunidades
    if (totalOportunidades === 0) {
      console.log(`⚠️  ${resultado.nombre}: 0 oportunidades, no se envía email`);
      continue;
    }

    console.log(`📨 ${resultado.nombre} (${resultado.plan}): ${totalOportunidades} oportunidades`);

    try {
      const emailHTML = generarEmailSegunPlan(resultado);

      await resend.emails.send({
        from: 'Compita <noreply@compita.umbusk.com>',
        to: resultado.email,
        subject: `🎯 ${totalOportunidades} nueva${totalOportunidades > 1 ? 's' : ''} oportunidad${totalOportunidades > 1 ? 'es' : ''} detectada${totalOportunidades > 1 ? 's' : ''}`,
        html: emailHTML
      });

      emailsEnviados++;
      console.log(`   ✅ Email enviado a ${resultado.email}`);

    } catch (error) {
      console.error(`   ❌ Error enviando email: ${error.message}`);
    }
  }

  console.log(`\n✨ Total emails enviados: ${emailsEnviados}/${resultados.length}\n`);
}

function generarEmailSegunPlan(resultado) {
  const { plan, nombre, alta, media, oportunidades_alta, oportunidades_media } = resultado;

  // Plan Gratuito
  if (plan === 'free_trial') {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #4F46E5;">🎯 Nuevas Oportunidades Detectadas</h2>
        <p>Hola,</p>
        <p>Compita ha detectado <strong>${alta + media} nuevas oportunidades</strong> que podrían interesarte.</p>
        <div style="background: #F3F4F6; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p style="font-size: 24px; font-weight: bold; margin: 0;">${alta + media}</p>
          <p style="margin: 5px 0 0 0; color: #6B7280;">oportunidades esperando</p>
        </div>
        <a href="${DASHBOARD_URL}" style="display: inline-block; background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 10px;">
          Ver en Dashboard →
        </a>
        <p style="margin-top: 30px; font-size: 12px; color: #6B7280;">
          Actualiza a un plan de pago para ver detalles en el email.
        </p>
      </div>
    `;
  }

  // Plan Estándar
  if (plan === 'estandar') {
    const todasOportunidades = [...oportunidades_alta, ...oportunidades_media];

    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #4F46E5;">🎯 Nuevas Oportunidades - Resumen</h2>
        <p>Hola,</p>
        <p>Compita encontró <strong>${alta} de ALTA</strong> y <strong>${media} de MEDIA</strong> relevancia:</p>

        ${todasOportunidades.slice(0, 5).map(op => `
          <div style="border-left: 4px solid ${op.relevancia === 'ALTA' ? '#10B981' : '#F59E0B'}; padding-left: 15px; margin: 15px 0;">
            <p style="margin: 0; font-weight: bold; color: ${op.relevancia === 'ALTA' ? '#10B981' : '#F59E0B'};">
              ${op.relevancia}
            </p>
            <p style="margin: 5px 0; font-weight: bold;">${op.referencia}</p>
            <p style="margin: 5px 0; color: #6B7280;">${op.que}</p>
            <p style="margin: 5px 0; font-size: 14px;">${Number(op.monto_estimado || 0).toLocaleString()} DOP</p>
            <p style="margin: 5px 0; font-size: 13px; color: #6B7280;">Cierre: ${op.fecha_presentacion}</p>
          </div>
        `).join('')}

        ${todasOportunidades.length > 5 ? `<p style="color: #6B7280;">+ ${todasOportunidades.length - 5} más en el dashboard</p>` : ''}

        <a href="${DASHBOARD_URL}" style="display: inline-block; background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 20px;">
          Ver Todas en Dashboard →
        </a>
      </div>
    `;
  }

  // Plan Business
  if (plan === 'business') {
    const todasOportunidades = [...oportunidades_alta, ...oportunidades_media];

    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #4F46E5;">🎯 Nuevas Oportunidades - Análisis Completo</h2>
        <p>Hola,</p>
        <p>Compita encontró <strong>${alta} de ALTA</strong> y <strong>${media} de MEDIA</strong> relevancia:</p>

        ${todasOportunidades.map(op => `
          <div style="border: 1px solid #E5E7EB; border-radius: 8px; padding: 15px; margin: 15px 0;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
              <span style="background: ${op.relevancia === 'ALTA' ? '#10B981' : '#F59E0B'}; color: white; padding: 4px 12px; border-radius: 4px; font-size: 12px; font-weight: bold;">
                ${op.relevancia}
              </span>
              <span style="font-size: 18px; font-weight: bold; color: #1F2937;">
                ${Number(op.monto_estimado || 0).toLocaleString()} DOP
              </span>
            </div>

            <p style="margin: 8px 0; font-weight: bold; font-size: 16px;">${op.referencia}</p>
            <p style="margin: 8px 0; color: #4B5563;"><strong>Qué:</strong> ${op.que}</p>
            <p style="margin: 8px 0; color: #4B5563;"><strong>Quién:</strong> ${op.quien}</p>
            <p style="margin: 8px 0; color: #4B5563;"><strong>Cierre:</strong> ${op.fecha_presentacion}</p>

            <div style="background: #F9FAFB; padding: 10px; border-radius: 4px; margin-top: 10px;">
              <p style="margin: 0; font-size: 13px; color: #6B7280;"><strong>Por qué es relevante:</strong></p>
              <p style="margin: 5px 0 0 0; font-size: 13px; color: #374151;">${op.razon}</p>
            </div>

            <a href="${DASHBOARD_URL}" style="display: inline-block; background: #4F46E5; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px; margin-top: 10px; font-size: 14px;">
              Ver Detalles Completos →
            </a>
          </div>
        `).join('')}

        <a href="${DASHBOARD_URL}" style="display: inline-block; background: #10B981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 20px;">
          Ir al Dashboard →
        </a>
      </div>
    `;
  }

  return '';
}

// ============================================================================
// EJECUCIÓN PRINCIPAL
// ============================================================================

async function main() {
  console.log('\n🔄 🔄 🔄 🔄 🔄 🔄 🔄 🔄 🔄 🔄 🔄 🔄 🔄 🔄');
  console.log('COMPITA - ANÁLISIS Y NOTIFICACIONES DIARIAS');
  console.log('🔄 🔄 🔄 🔄 🔄 🔄 🔄 🔄 🔄 🔄 🔄 🔄 🔄 🔄\n');

  const inicio = new Date();

  try {
    // 1. Analizar oportunidades
    const resultados = await analizarDiario();

    // 2. Enviar notificaciones
    if (resultados.length > 0) {
      await enviarNotificaciones(resultados);
    } else {
      console.log('⚠️  No hay resultados para notificar\n');
    }

    // 3. Resumen final
    console.log('='*70);
    console.log('📊 RESUMEN FINAL');
    console.log('='*70);
    console.log(`✅ Empresas procesadas: ${resultados.length}`);
    console.log(`📧 Notificaciones enviadas: ${resultados.filter(r => r.alta + r.media > 0).length}`);

    const fin = new Date();
    const duracion = (fin - inicio) / 1000;
    console.log(`⏱️  Duración: ${duracion.toFixed(1)} segundos`);
    console.log('\n✨ Proceso completado exitosamente\n');

  } catch (error) {
    console.error('\n❌ Error en proceso:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Ejecutar
main();