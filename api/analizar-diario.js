import Anthropic from '@anthropic-ai/sdk';
import pkg from 'pg';
const { Pool } = pkg;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  // ============================================
  // SEGURIDAD: Solo GitHub Actions puede llamar
  // ============================================
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
  console.log('\n🔄 ═══════════════════════════════════════════════════════════');
  console.log('   COMPITA - ANÁLISIS AUTOMÁTICO DIARIO');
  console.log('🔄 ═══════════════════════════════════════════════════════════\n');
  
  const ahora = new Date();
  console.log(`📅 Fecha/Hora: ${ahora.toLocaleString('es-DO')}`);

  try {
    // ============================================
    // PASO 1: Obtener licitaciones de hoy
    // ============================================
    console.log('\n📥 PASO 1: Obteniendo licitaciones scrapeadas hoy...');
    
    const { fecha_analisis } = req.body || {};
    const fechaFiltro = fecha_analisis || new Date().toISOString().split('T')[0];
    
    const licitacionesRes = await pool.query(`
      SELECT 
        id,
        referencia,
        descripcion,
        unidad_compras,
        fecha_presentacion,
        monto_estimado,
        estado,
        DATE(scrapeado_en) as fecha_scraping
      FROM licitaciones
      WHERE DATE(scrapeado_en) = $1
      ORDER BY id DESC
    `, [fechaFiltro]);

    const licitaciones = licitacionesRes.rows;
    console.log(`✅ Encontradas ${licitaciones.length} licitaciones scrapeadas hoy`);

    if (licitaciones.length === 0) {
      console.log('⚠️  No hay licitaciones nuevas para analizar');
      return res.status(200).json({
        success: true,
        mensaje: 'No hay licitaciones nuevas para analizar',
        empresas_analizadas: 0,
        total_licitaciones: 0,
        total_oportunidades: 0
      });
    }

    // ============================================
    // PASO 2: Obtener empresas activas
    // ============================================
    console.log('\n🏢 PASO 2: Obteniendo empresas activas...');
    
    const empresasRes = await pool.query(`
      SELECT DISTINCT e.*
      FROM empresas e
      JOIN usuarios u ON u.empresa_id = e.id
      WHERE u.activo = true
        AND e.palabras_clave IS NOT NULL
        AND e.palabras_clave != ''
        AND (
          u.plan != 'trial_gratuito' 
          OR u.trial_expira > NOW()
        )
    `);

    const empresas = empresasRes.rows;
    console.log(`✅ Encontradas ${empresas.length} empresas activas`);

    if (empresas.length === 0) {
      console.log('⚠️  No hay empresas activas para analizar');
      return res.status(200).json({
        success: true,
        mensaje: 'No hay empresas activas',
        empresas_analizadas: 0,
        total_licitaciones: licitaciones.length,
        total_oportunidades: 0
      });
    }

    // ============================================
    // PASO 3: Analizar para cada empresa
    // ============================================
    console.log('\n🔍 PASO 3: Analizando licitaciones por empresa...');
    console.log('════════════════════════════════════════════════════════════\n');

    let totalOportunidadesEncontradas = 0;
    let totalAlta = 0;
    let totalMedia = 0;
    let totalBaja = 0;
    const resumenPorEmpresa = [];

    for (const empresa of empresas) {
      console.log(`\n📊 Analizando para: ${empresa.nombre}`);
      console.log(`   Perfil: ${empresa.palabras_clave?.substring(0, 50)}...`);
      
      try {
        // Verificar qué licitaciones ya fueron analizadas para esta empresa
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

        console.log(`   💾 Ya analizadas: ${referenciasAnalizadas.size}`);
        console.log(`   🆕 Por analizar: ${licitacionesPorAnalizar.length}`);

        if (licitacionesPorAnalizar.length === 0) {
          console.log(`   ⏭️  Todas las licitaciones ya fueron analizadas`);
          continue;
        }

        // Normalizar palabras_clave si es array
        if (Array.isArray(empresa.palabras_clave)) {
          empresa.palabras_clave = empresa.palabras_clave.join(', ');
        }

        // ETAPA 1: Pre-filtrado
        const resultadosEtapa1 = [];
        const paraAnalizarIA = [];

        for (const licitacion of licitacionesPorAnalizar) {
          const resultado = await procesarEtapa1(licitacion, empresa);
          resultadosEtapa1.push({ licitacion, resultado });

          if (resultado.pasa_etapa1) {
            paraAnalizarIA.push(licitacion);
          }
        }

        console.log(`   📋 Pre-filtro: ${paraAnalizarIA.length}/${licitacionesPorAnalizar.length} pasan a IA`);

        // ETAPA 2: Análisis con IA
        const resultadosIA = [];
        let contadorIA = 0;

        for (const licitacion of paraAnalizarIA) {
          contadorIA++;
          process.stdout.write(`   🤖 Analizando con IA: ${contadorIA}/${paraAnalizarIA.length}\r`);
          
          const analisis = await analizarConIA(licitacion, empresa);

          // Ajuste por monto mínimo
          const montoMinimo = empresa.monto_minimo_alta || 500000;
          const montoOportunidad = parseFloat(analisis.monto_estimado || 0);

          if (analisis.relevancia === 'ALTA' && montoOportunidad < montoMinimo) {
            analisis.relevancia = 'MEDIA';
            analisis.razon = `Monto ${montoOportunidad.toLocaleString()} DOP menor al mínimo ${montoMinimo.toLocaleString()} DOP. ${analisis.razon}`;
          }

          resultadosIA.push(analisis);
        }

        if (paraAnalizarIA.length > 0) {
          console.log(`\n   ✅ Análisis IA completado: ${paraAnalizarIA.length} licitaciones`);
        }

        // Contar por relevancia
        const alta = resultadosIA.filter(r => r.relevancia === 'ALTA').length;
        const media = resultadosIA.filter(r => r.relevancia === 'MEDIA').length;
        const baja = resultadosIA.filter(r => r.relevancia === 'BAJA').length;

        console.log(`   📊 Resultados: ALTA=${alta}, MEDIA=${media}, BAJA=${baja}`);

        // ============================================
        // PASO 4: Guardar resultados en BD
        // ============================================
        if (resultadosIA.length > 0) {
          console.log(`   💾 Guardando resultados...`);

          // Crear registro de análisis
          const analisisInsert = await pool.query(`
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
            empresa.id,
            licitacionesPorAnalizar.length,
            alta,
            media,
            baja,
            licitacionesPorAnalizar.length > 0
              ? Math.round((alta / licitacionesPorAnalizar.length) * 100)
              : 0
          ]);

          const analisisId = analisisInsert.rows[0].id;

          // Guardar resultados de IA
          for (const resultado of resultadosIA) {
            const licitacionOriginal = licitaciones.find(
              l => l.referencia === resultado.referencia
            );

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
              empresa.id,
              licitacionOriginal?.id || null,
              resultado.referencia,
              resultado.unidad_compras,
              resultado.descripcion,
              resultado.fecha_presentacion,
              resultado.monto_estimado,
              resultado.estado,
              resultado.relevancia,
              resultado.que,
              resultado.quien,
              resultado.razon,
              'automatico',  // origen
              false,         // vista
              false          // notificada
            ]);
          }

          // Guardar descartados con relevancia DESCARTADA
          for (const { licitacion, resultado } of resultadosEtapa1) {
            if (!resultado.pasa_etapa1) {
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
                empresa.id,
                licitacion.id,
                licitacion.referencia,
                licitacion.unidad_compras,
                licitacion.descripcion,
                licitacion.fecha_presentacion,
                licitacion.monto_estimado,
                licitacion.estado,
                'DESCARTADA',
                'Descartada en pre-filtrado',
                licitacion.unidad_compras,
                resultado.razon,
                'automatico',
                false,
                false
              ]);
            }
          }

          console.log(`   ✅ Guardados ${resultadosIA.length + resultadosEtapa1.filter(r => !r.resultado.pasa_etapa1).length} resultados`);
        }

        // Acumular estadísticas
        totalOportunidadesEncontradas += (alta + media + baja);
        totalAlta += alta;
        totalMedia += media;
        totalBaja += baja;

        resumenPorEmpresa.push({
          empresa: empresa.nombre,
          total_analizadas: licitacionesPorAnalizar.length,
          oportunidades: alta + media + baja,
          alta,
          media,
          baja
        });

      } catch (empresaError) {
        console.error(`   ❌ Error analizando ${empresa.nombre}:`, empresaError.message);
      }
    }

    // ============================================
    // RESUMEN FINAL
    // ============================================
    const duracionTotal = ((Date.now() - inicioTotal) / 1000).toFixed(1);
    
    console.log('\n════════════════════════════════════════════════════════════');
    console.log('📊 RESUMEN FINAL');
    console.log('════════════════════════════════════════════════════════════');
    console.log(`🏢 Empresas analizadas: ${empresas.length}`);
    console.log(`📋 Total licitaciones scrapeadas: ${licitaciones.length}`);
    console.log(`🎯 Total oportunidades encontradas: ${totalOportunidadesEncontradas}`);
    console.log(`   • ALTA: ${totalAlta}`);
    console.log(`   • MEDIA: ${totalMedia}`);
    console.log(`   • BAJA: ${totalBaja}`);
    console.log(`⏱️  Tiempo total: ${duracionTotal} segundos`);
    console.log('════════════════════════════════════════════════════════════\n');

    res.status(200).json({
      success: true,
      timestamp: ahora.toISOString(),
      empresas_analizadas: empresas.length,
      total_licitaciones: licitaciones.length,
      total_oportunidades: totalOportunidadesEncontradas,
      resumen: {
        alta: totalAlta,
        media: totalMedia,
        baja: totalBaja
      },
      detalle_por_empresa: resumenPorEmpresa,
      duracion_segundos: parseFloat(duracionTotal)
    });

  } catch (error) {
    console.error('\n❌ ERROR GENERAL:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error en análisis automático',
      detalle: error.message 
    });
  }
}

// ============================================
// FUNCIONES DE ANÁLISIS (reutilizadas)
// ============================================

async function procesarEtapa1(oportunidad, empresa) {
  // Validar fecha de presentación
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

  // Verificar que no esté vencida
  const ahora = new Date();
  if (fechaLimite < ahora) {
    return { pasa_etapa1: false, razon: 'Fecha de presentación vencida' };
  }

  // Verificar palabras clave
  const palabrasClave = empresa.palabras_clave
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

  // Verificar exclusiones
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
          razon: `Contiene palabra de exclusión: ${exclusion}`
        };
      }
    }
  }

  // Verificar estado
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
${empresa.palabras_clave || 'Sin palabras clave'}

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

export const config = {
  maxDuration: 300,  // 5 minutos máximo
};