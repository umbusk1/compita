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

  const { cliente_id, fecha_desde, fecha_hasta } = req.body;

  if (!cliente_id || !fecha_desde || !fecha_hasta) {
    return res.status(400).json({ error: 'Faltan parámetros' });
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

    // 2️⃣ OBTENER OPORTUNIDADES DEL PERÍODO
    const oportunidadesRes = await pool.query(`
      SELECT * FROM oportunidades
      WHERE fecha_publicacion BETWEEN $1 AND $2
      ORDER BY fecha_publicacion DESC
    `, [fecha_desde, fecha_hasta]);

    const todasOportunidades = oportunidadesRes.rows;

    // 3️⃣ PROCESAMIENTO: ETAPA 1 (DETERMINISTA) + ETAPA 2 (IA)
    const resultadosEtapa1 = [];
    const paraAnalizarIA = [];

    for (const oportunidad of todasOportunidades) {
      const resultado = await procesarEtapa1(oportunidad, cliente);
      resultadosEtapa1.push(resultado);

      if (resultado.pasa_etapa1) {
        paraAnalizarIA.push(oportunidad);
      }
    }

    // 4️⃣ ANÁLISIS CON IA (solo las que pasaron etapa 1)
    const resultadosIA = [];
    for (const oportunidad of paraAnalizarIA) {
      const analisis = await analizarConIA(oportunidad, cliente);
      resultadosIA.push({ ...oportunidad, ...analisis });
    }

    // 5️⃣ CONSTRUIR RESPUESTA
    const resumen = {
      total_lotes: todasOportunidades.length,
      descartadas_etapa1: resultadosEtapa1.filter(r => !r.pasa_etapa1).length,
      analizadas_ia: resultadosIA.length,
      alta_relevancia: resultadosIA.filter(r => r.relevancia === 'ALTA').length,
      media_relevancia: resultadosIA.filter(r => r.relevancia === 'MEDIA').length
    };

    res.status(200).json({
      resumen,
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
  // 1️⃣ FILTRO: Fecha límite válida
  if (!oportunidad.fecha_limite || new Date(oportunidad.fecha_limite) < new Date()) {
    return { pasa_etapa1: false, razon: 'Fecha límite vencida o no disponible' };
  }

  // 2️⃣ FILTRADO ETAPA 1: Palabras clave (BÚSQUEDA DE PALABRAS COMPLETAS)
  const palabrasClave = cliente.palabras_clave
    .split(',')
    .map(p => p.trim().toLowerCase())
    .filter(p => p.length > 0);

  const textoCompleto = (
    `${oportunidad.descripcion || ''} ${oportunidad.objeto || ''}`
  ).toLowerCase();

  // Buscar cada palabra como palabra completa (no como substring)
  const tieneCoincidencia = palabrasClave.some(palabra => {
    // Escapar caracteres especiales de regex y buscar con word boundaries
    const palabraEscapada = palabra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${palabraEscapada}\\b`, 'i');
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

  // 4️⃣ FILTRO: Estado debe ser válido
  const estadosValidos = ['Publicada', 'Adjudicada', 'Desierta', 'Cancelada'];
  if (!estadosValidos.includes(oportunidad.estado)) {
    return { pasa_etapa1: false, razon: `Estado no válido: ${oportunidad.estado}` };
  }

  return { pasa_etapa1: true };
}

// ========================================
// ETAPA 2: ANÁLISIS CON IA
// ========================================
async function analizarConIA(oportunidad, cliente) {
  const prompt = `Eres un analista experto en licitaciones públicas. Analiza esta oportunidad para determinar:

1. **RELEVANCIA**: ¿Qué tan relevante es para el cliente?
   - ALTA: Coincidencia directa con servicios/productos del cliente
   - MEDIA: Parcialmente relacionado o requiere alianzas
   - BAJA: Poco relevante o fuera del alcance

2. **COMPATIBLE**: ¿El cliente puede ejecutar este contrato?
   - Compatible: Tiene capacidad técnica/operativa
   - Revisar: Necesita evaluar capacidad o alianzas
   - Aparentemente incompatible: Fuera de alcance técnico

3. **RAZÓN**: Justificación breve (máximo 2 líneas)

**PERFIL DEL CLIENTE:**
${cliente.perfil_cliente}

**OPORTUNIDAD:**
- Referencia: ${oportunidad.referencia}
- Descripción: ${oportunidad.descripcion}
- Objeto: ${oportunidad.objeto || 'N/A'}
- Monto: ${Number(oportunidad.monto_estimado || 0).toLocaleString()} DOP

**RESPONDE SOLO EN ESTE FORMATO:**
RELEVANCIA: [ALTA|MEDIA|BAJA]
COMPATIBLE: [Compatible|Revisar|Aparentemente incompatible]
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
    const compatibleMatch = respuesta.match(/COMPATIBLE:\s*(Compatible|Revisar|Aparentemente incompatible)/i);
    const razonMatch = respuesta.match(/RAZÓN:\s*(.+)/i);

    return {
      relevancia: relevanciaMatch ? relevanciaMatch[1].toUpperCase() : 'MEDIA',
      compatible: compatibleMatch ? compatibleMatch[1] : 'Por determinar',
      razon: razonMatch ? razonMatch[1].trim() : 'Análisis IA no disponible',
      que: oportunidad.descripcion,
      quien: oportunidad.comprador || 'N/A',
      referencia: oportunidad.referencia,
      monto: oportunidad.monto_estimado,
      fecha_limite: oportunidad.fecha_limite
    };

  } catch (error) {
    console.error('Error en análisis IA:', error);
    return {
      relevancia: 'MEDIA',
      compatible: 'Por determinar',
      razon: 'Error en análisis IA',
      que: oportunidad.descripcion,
      quien: oportunidad.comprador || 'N/A',
      referencia: oportunidad.referencia,
      monto: oportunidad.monto_estimado,
      fecha_limite: oportunidad.fecha_limite
    };
  }
}