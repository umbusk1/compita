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
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { cliente_id, licitaciones, guardar_en_db } = req.body;

  if (!cliente_id || !licitaciones || !Array.isArray(licitaciones)) {
    return res.status(400).json({ error: 'Faltan parámetros: cliente_id y licitaciones son requeridos' });
  }

  try {
    const clienteRes = await pool.query(
      'SELECT * FROM clientes WHERE id = $1',
      [cliente_id]
    );

    if (clienteRes.rows.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    const cliente = clienteRes.rows[0];

    if (Array.isArray(cliente.palabras_clave)) {
      cliente.palabras_clave = cliente.palabras_clave.join(', ');
    }

    if (!cliente.palabras_clave) {
      cliente.palabras_clave = '';
    }

    const todasOportunidades = licitaciones;

    const problematica1 = todasOportunidades.find(l => l.referencia && l.referencia.includes('MICM-DAF-CM-2025-0090'));
    const problematica2 = todasOportunidades.find(l => l.referencia && l.referencia.includes('MICM-DAF-CM-2025-0199'));

    const resultadosEtapa1 = [];
    const paraAnalizarIA = [];

    for (const oportunidad of todasOportunidades) {
      const resultado = await procesarEtapa1(oportunidad, cliente);
      resultadosEtapa1.push(resultado);

      if (resultado.pasa_etapa1) {
        paraAnalizarIA.push(oportunidad);
      }
    }

    const resultadosIA = [];
    for (const oportunidad of paraAnalizarIA) {
      const analisis = await analizarConIA(oportunidad, cliente);

      const montoMinimo = cliente.monto_minimo_alta || 500000;
      const montoOportunidad = parseFloat(analisis.monto_estimado || 0);

      if (analisis.relevancia === 'ALTA' && montoOportunidad < montoMinimo) {
        analisis.relevancia = 'MEDIA';
        analisis.razon = 'Relevancia temática alta pero monto ' + montoOportunidad.toLocaleString() + ' DOP menor a ' + montoMinimo.toLocaleString() + ' DOP. ' + analisis.razon;
      }

      resultadosIA.push(analisis);
    }

    const resumen = {
      total_lotes: todasOportunidades.length,
      descartadas_etapa1: resultadosEtapa1.filter(r => !r.pasa_etapa1).length,
      analizadas_ia: resultadosIA.length,
      alta_relevancia: resultadosIA.filter(r => r.relevancia === 'ALTA').length,
      media_relevancia: resultadosIA.filter(r => r.relevancia === 'MEDIA').length,
      baja_relevancia: resultadosIA.filter(r => r.relevancia === 'BAJA').length
    };

    // ========== GUARDAR EN BASE DE DATOS ==========
    if (guardar_en_db) {
      try {
        console.log('💾 Guardando análisis en base de datos...');

        // 1. Crear registro de análisis
        const analisisInsert = await pool.query(`
          INSERT INTO analisis (
            cliente_id,
            total_descripciones,
            total_alta,
            total_media,
            total_baja,
            porcentaje_alta
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id
        `, [
          cliente_id,
          resumen.total_lotes,
          resumen.alta_relevancia,
          resumen.media_relevancia,
          resumen.baja_relevancia,
          resumen.total_lotes > 0
            ? Math.round((resumen.alta_relevancia / resumen.total_lotes) * 100)
            : 0
        ]);

        const analisisId = analisisInsert.rows[0].id;
        console.log(`✅ Análisis creado con ID: ${analisisId}`);

        // Función auxiliar para convertir fecha dominicana a ISO
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

              // Retornar en formato ISO: YYYY-MM-DD
              return `${anio}-${mes}-${dia}`;
            }
            return null;
          } catch (err) {
            console.error('Error convirtiendo fecha:', err);
            return null;
          }
        }

        // 2. Guardar todos los resultados (IA + descartados)
        let guardados = 0;

        // Guardar resultados de IA (ALTA, MEDIA, BAJA)
        for (const resultado of resultadosIA) {
          const fechaISO = convertirFechaParaDB(resultado.fecha_presentacion);

          await pool.query(`
            INSERT INTO resultados (
              analisis_id,
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
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `, [
            analisisId,
            resultado.referencia || '',
            resultado.unidad_compras || '',
            resultado.descripcion || '',
            fechaISO,
            resultado.monto_estimado || null,
            resultado.estado || '',
            resultado.relevancia,
            resultado.que || '',
            resultado.quien || '',
            resultado.razon || ''
          ]);
          guardados++;
        }

        // Guardar descartados de Etapa 1 como BAJA con razón específica
        for (let i = 0; i < resultadosEtapa1.length; i++) {
          const etapa1 = resultadosEtapa1[i];
          if (!etapa1.pasa_etapa1) {
            const oportunidad = todasOportunidades[i];
            const fechaISO = convertirFechaParaDB(oportunidad.fecha_presentacion);

            await pool.query(`
              INSERT INTO resultados (
                analisis_id,
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
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            `, [
              analisisId,
              oportunidad.referencia || '',
              oportunidad.unidad_compras || '',
              oportunidad.descripcion || '',
              fechaISO,
              oportunidad.monto_estimado || null,
              oportunidad.estado || '',
              'BAJA',
              'Descartada',
              oportunidad.unidad_compras || '',
              etapa1.razon || 'Descartada en pre-filtrado'
            ]);
            guardados++;
          }
        }

        console.log(`✅ ${guardados} resultados guardados en base de datos`);

      } catch (dbError) {
        console.error('❌ Error guardando en base de datos:', dbError);
        // No falla el request, solo logea el error
      }
    }

    res.status(200).json({
      success: true,
      resumen,
      estadisticas: {
        total: resumen.total_lotes,
        descartadas_prefiltro: resumen.descartadas_etapa1,
        analizadas_ia: resumen.analizadas_ia,
        alta: resumen.alta_relevancia,
        media: resumen.media_relevancia,
        baja: resumen.baja_relevancia
      },
      resultados: resultadosIA,
      oportunidades: resultadosIA,
      diagnostico: {
        total_recibidas: todasOportunidades.length,
        primeras_5_refs: todasOportunidades.slice(0, 5).map(l => l.referencia),
        tiene_0090: !!problematica1,
        tiene_0199: !!problematica2,
        ref_0090: problematica1 ? problematica1.referencia : 'NO ENCONTRADA',
        ref_0199: problematica2 ? problematica2.referencia : 'NO ENCONTRADA'
      }
    });

  } catch (error) {
    console.error('Error en análisis:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function procesarEtapa1(oportunidad, cliente) {
  const ref = oportunidad.referencia || 'SIN-REF';
  const esCasoProblematico = ref.includes('MICM-DAF-CM-2025-0090') || ref.includes('MICM-DAF-CM-2025-0199');

  if (esCasoProblematico) {
    console.log('[DEBUG] CASO: ' + ref);
  }

  if (!oportunidad.fecha_presentacion) {
    if (esCasoProblematico) console.log('[DEBUG] X Sin fecha');
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

      if (esCasoProblematico) {
        console.log('[DEBUG] Fecha original: ' + fechaOriginal);
        console.log('[DEBUG] Fecha parseada: ' + fechaLimite.toISOString());
      }
    } else {
      fechaLimite = new Date(oportunidad.fecha_presentacion);
    }

    if (isNaN(fechaLimite.getTime())) {
      if (esCasoProblematico) console.log('[DEBUG] X Fecha invalida');
      return { pasa_etapa1: false, razon: 'Fecha inválida' };
    }
  } catch (err) {
    if (esCasoProblematico) console.log('[DEBUG] X Error parseando: ' + err.message);
    return { pasa_etapa1: false, razon: 'Fecha inválida' };
  }

  const ahora = new Date();
  if (fechaLimite < ahora) {
    if (esCasoProblematico) {
      console.log('[DEBUG] X Fecha vencida');
      console.log('[DEBUG] Limite: ' + fechaLimite.toISOString());
      console.log('[DEBUG] Ahora: ' + ahora.toISOString());
    }
    return { pasa_etapa1: false, razon: 'Fecha de presentación vencida' };
  }

  if (esCasoProblematico) console.log('[DEBUG] OK Fecha');

  const palabrasClave = cliente.palabras_clave
    .split(',')
    .map(p => p.trim().toLowerCase())
    .filter(p => p.length > 0);

  if (esCasoProblematico) {
    console.log('[DEBUG] Palabras: ' + palabrasClave.length);
  }

  const textoCompleto = (oportunidad.descripcion || '').toLowerCase();

  let palabraEncontrada = null;
  const tieneCoincidencia = palabrasClave.some(palabra => {
    const raiz = palabra.endsWith('s') ? palabra.slice(0, -1) : palabra;
    const palabraEscapada = raiz.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('\\b' + palabraEscapada + 's?\\b', 'i');
    const encontrada = regex.test(textoCompleto);

    if (esCasoProblematico && encontrada) {
      console.log('[DEBUG] Encontro: ' + palabra);
    }

    if (encontrada) {
      palabraEncontrada = palabra;
      return true;
    }
    return false;
  });

  if (!tieneCoincidencia) {
    if (esCasoProblematico) console.log('[DEBUG] X Sin palabras clave');
    return { pasa_etapa1: false, razon: 'No contiene palabras clave relevantes' };
  }

  if (esCasoProblematico) console.log('[DEBUG] OK Palabra: ' + palabraEncontrada);

  if (cliente.exclusiones && cliente.exclusiones.length > 0) {
    const exclusiones = Array.isArray(cliente.exclusiones)
      ? cliente.exclusiones
      : cliente.exclusiones.split(',').map(e => e.trim()).filter(e => e.length > 0);

    const exclusionesLower = exclusiones.map(e => e.toLowerCase());

    for (const exclusion of exclusionesLower) {
      const raiz = exclusion.endsWith('s') ? exclusion.slice(0, -1) : exclusion;
      const palabraEscapada = raiz.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp('\\b' + palabraEscapada + 's?\\b', 'i');

      if (regex.test(textoCompleto)) {
        if (esCasoProblematico) {
          console.log('[DEBUG] X Exclusion encontrada: ' + exclusion);
        }
        return {
          pasa_etapa1: false,
          razon: 'Contiene palabra de exclusión: ' + exclusion
        };
      }
    }

    if (esCasoProblematico) console.log('[DEBUG] OK Sin exclusiones');
  }

  const estado = oportunidad.estado || '';
  if (!estado) {
    if (esCasoProblematico) console.log('[DEBUG] X Sin estado');
    return { pasa_etapa1: false, razon: 'Sin estado definido' };
  }

  if (esCasoProblematico) {
    console.log('[DEBUG] OK Estado');
    console.log('[DEBUG] >>> PASA A ETAPA 2 <<<');
  }

  return { pasa_etapa1: true };
}

async function analizarConIA(oportunidad, cliente) {
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
${cliente.descripcion || 'Cliente sin descripción'}

**PALABRAS CLAVE DEL CLIENTE:**
${cliente.palabras_clave || 'Sin palabras clave'}

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
  maxDuration: 300,
};