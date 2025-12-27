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
    // 1️⃣ OBTENER DATOS DEL CLIENTE
    const clienteRes = await pool.query(
      'SELECT * FROM clientes WHERE id = $1',
      [cliente_id]
    );

    if (clienteRes.rows.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    const cliente = clienteRes.rows[0];

    // Convertir palabras_clave de array a string si es necesario
    if (Array.isArray(cliente.palabras_clave)) {
      cliente.palabras_clave = cliente.palabras_clave.join(', ');
    }

    // Si palabras_clave es null o undefined, usar string vacío
    if (!cliente.palabras_clave) {
      cliente.palabras_clave = '';
    }

    // 2️⃣ USAR LICITACIONES DEL EXCEL (no buscar en DB)
    const todasOportunidades = licitaciones;

    // 3️⃣ PROCESAMIENTO: ETAPA 1 (DETERMINISTA) + ETAPA 2 (IA)
    const resultadosEtapa1 = [];
    const paraAnalizarIA = [];

    console.log(`🔍 Iniciando Etapa 1: ${todasOportunidades.length} licitaciones`);

    for (const oportunidad of todasOportunidades) {
      const resultado = await procesarEtapa1(oportunidad, cliente);
      resultadosEtapa1.push(resultado);

      if (resultado.pasa_etapa1) {
        paraAnalizarIA.push(oportunidad);
      }
    }

    console.log(`✅ Etapa 1 completada: ${paraAnalizarIA.length} pasaron a análisis IA, ${resultadosEtapa1.filter(r => !r.pasa_etapa1).length} descartadas`);

    // 4️⃣ ANÁLISIS CON IA (solo las que pasaron etapa 1)
    const resultadosIA = [];
    for (const oportunidad of paraAnalizarIA) {
      const analisis = await analizarConIA(oportunidad, cliente);

      // 🔧 ESCALADO POR MONTO: ALTA solo si monto >= monto_minimo_alta
      const montoMinimo = cliente.monto_minimo_alta || 500000;
      const montoOportunidad = parseFloat(analisis.monto_estimado || 0);

      // Si la IA dijo ALTA pero el monto es insuficiente, bajar a MEDIA
      if (analisis.relevancia === 'ALTA' && montoOportunidad < montoMinimo) {
        console.log(`📊 Escalado ALTA→MEDIA: ${analisis.referencia} (${montoOportunidad.toLocaleString()} < ${montoMinimo.toLocaleString()})`);
        analisis.relevancia = 'MEDIA';
        analisis.razon = `Relevancia temática alta pero monto ${montoOportunidad.toLocaleString()} DOP < ${montoMinimo.toLocaleString()} DOP. ${analisis.razon}`;
      }

      resultadosIA.push(analisis);
    }

    // 5️⃣ CONSTRUIR RESPUESTA
    const resumen = {
      total_lotes: todasOportunidades.length,
      descartadas_etapa1: resultadosEtapa1.filter(r => !r.pasa_etapa1).length,
      analizadas_ia: resultadosIA.length,
      alta_relevancia: resultadosIA.filter(r => r.relevancia === 'ALTA').length,
      media_relevancia: resultadosIA.filter(r => r.relevancia === 'MEDIA').length
    };

    // 6️⃣ GUARDAR EN BASE DE DATOS (si se solicitó)
    if (guardar_en_db) {
      try {
        // Crear registro de análisis
        const analisisResult = await pool.query(`
          INSERT INTO analisis (
            cliente_id,
            total_descripciones,
            total_alta,
            total_media,
            total_baja,
            porcentaje_alta,
            created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
          RETURNING id
        `, [
          cliente_id,
          todasOportunidades.length,
          resumen.alta_relevancia,
          resumen.media_relevancia,
          resumen.descartadas_etapa1,
          Math.round((resumen.alta_relevancia / todasOportunidades.length) * 100)
        ]);

        const analisisId = analisisResult.rows[0].id;

        // Guardar todos los resultados
        for (const resultado of resultadosIA) {
          await pool.query(`
            INSERT INTO resultados (
              analisis_id,
              unidad_compras,
              referencia,
              descripcion,
              que,
              quien,
              relevancia,
              monto_estimado,
              fecha_presentacion,
              estado,
              razon
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `, [
            analisisId,
            resultado.unidad_compras || '',
            resultado.referencia || '',
            resultado.descripcion || '',
            resultado.que || '',
            resultado.quien || '',
            resultado.relevancia,
            resultado.monto_estimado,
            resultado.fecha_presentacion,
            resultado.estado || '',
            resultado.razon || ''
          ]);
        }
      } catch (dbError) {
        console.error('Error guardando en DB:', dbError);
        // Continuar aunque falle el guardado
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
        baja: resumen.descartadas_etapa1
      },
      resultados: resultadosIA,
      oportunidades: resultadosIA
    });

  } catch (error) {
    console.error('Error en análisis:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// ========================================
// ETAPA 1: FILTRADO DETERMINISTA
// ========================================
async function procesarEtapa1(oportunidad, cliente) {
  // 1️⃣ FILTRO: Fecha de presentación válida y futura
  if (!oportunidad.fecha_presentacion) {
    return { pasa_etapa1: false, razon: 'Sin fecha de presentación' };
  }

  // Intentar parsear la fecha (puede venir en varios formatos del Excel)
  let fechaLimite;
  try {
    fechaLimite = new Date(oportunidad.fecha_presentacion);
    if (isNaN(fechaLimite.getTime())) {
      return { pasa_etapa1: false, razon: 'Fecha inválida' };
    }
  } catch {
    return { pasa_etapa1: false, razon: 'Fecha inválida' };
  }

  // Verificar que sea futura
  if (fechaLimite < new Date()) {
    return { pasa_etapa1: false, razon: 'Fecha de presentación vencida' };
  }

  // 2️⃣ FILTRADO ETAPA 1: Palabras clave (BÚSQUEDA FLEXIBLE - incluye singular/plural)
  const palabrasClave = cliente.palabras_clave
    .split(',')
    .map(p => p.trim().toLowerCase())
    .filter(p => p.length > 0);

  const textoCompleto = (oportunidad.descripcion || '').toLowerCase();

  // Buscar cada palabra con flexibilidad para singular/plural
  const tieneCoincidencia = palabrasClave.some(palabra => {
    // Remover 's' final para capturar singular y plural
    const raiz = palabra.endsWith('s') ? palabra.slice(0, -1) : palabra;

    // Buscar la raíz como palabra completa (con o sin 's' al final)
    const palabraEscapada = raiz.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${palabraEscapada}s?\\b`, 'i');
    return regex.test(textoCompleto);
  });

  if (!tieneCoincidencia) {
    return { pasa_etapa1: false, razon: 'No contiene palabras clave relevantes' };
  }

  // 3️⃣ FILTRO: Monto mínimo
  const monto = parseFloat(oportunidad.monto_estimado || 0);
  if (monto < cliente.monto_minimo) {
    return {
      pasa_etapa1: false,
      razon: `Monto ${monto.toLocaleString()} DOP < Mínimo ${cliente.monto_minimo.toLocaleString()} DOP`
    };
  }

  // 4️⃣ FILTRO: Estado debe ser válido (flexible)
  const estado = oportunidad.estado || '';
  if (!estado) {
    return { pasa_etapa1: false, razon: 'Sin estado definido' };
  }

  return { pasa_etapa1: true };
}

// ========================================
// ETAPA 2: ANÁLISIS CON IA
// ========================================
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

    // Parsear respuesta
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