// api/analizar-v4.js - SISTEMA DE 2 ETAPAS
import Anthropic from '@anthropic-ai/sdk';
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const { cliente_id, descripciones, batchSize = 5, guardar_en_db = true } = req.body;

    if (!cliente_id) return res.status(400).json({ success: false, error: 'cliente_id es requerido' });
    if (!descripciones || !Array.isArray(descripciones)) {
      return res.status(400).json({ success: false, error: 'Debe enviar un array de descripciones' });
    }

    const sql = neon(process.env.NETLIFYDATABASEURL);
    const clienteData = await sql`SELECT * FROM clientes WHERE id = ${cliente_id} AND activo = true`;

    if (clienteData.length === 0) {
      return res.status(404).json({ success: false, error: 'Cliente no encontrado' });
    }

    const cliente = clienteData[0];
    console.log(`📊 Cliente: ${cliente.nombre} | ${descripciones.length} descripciones totales`);

    // ========== ETAPA 1: PRE-FILTRO ==========
    function prefiltrarDescripcion(descripcion) {
      const texto = descripcion.toLowerCase();

      // Verificar exclusiones
      if (cliente.exclusiones && cliente.exclusiones.length > 0) {
        const tieneExclusion = cliente.exclusiones.some(excl => texto.includes(excl.toLowerCase()));
        if (tieneExclusion) {
          return { pasa: false, razon: 'Contiene palabra de exclusión' };
        }
      }

      // Verificar palabras clave (ALTA o MEDIA)
      const criteriosAlta = cliente.criterios_alta || [];
      const criteriosMedia = cliente.criterios_media || [];
      const todosCriterios = [...criteriosAlta, ...criteriosMedia];

      if (todosCriterios.length === 0) {
        return { pasa: true, razon: 'Cliente sin criterios - enviar a IA' };
      }

      const palabrasEncontradas = todosCriterios.filter(palabra => texto.includes(palabra.toLowerCase()));

      if (palabrasEncontradas.length === 0) {
        return { pasa: false, razon: 'No contiene palabras clave relevantes' };
      }

      return { pasa: true, razon: `Contiene: ${palabrasEncontradas.slice(0, 3).join(', ')}`, palabrasEncontradas };
    }

    const resultadosPrefiltro = descripciones.map(desc => ({ descripcion: desc, ...prefiltrarDescripcion(desc) }));
    const descartadas = resultadosPrefiltro.filter(r => !r.pasa);
    const candidatas = resultadosPrefiltro.filter(r => r.pasa);

    console.log(`✅ Etapa 1: ${descartadas.length} descartadas, ${candidatas.length} candidatas`);

    if (candidatas.length === 0) {
      const resultadosFinales = descartadas.map(d => ({
        descripcion: d.descripcion, que: 'Descartada', quien: 'N/A', relevancia: 'BAJA', razon: d.razon
      }));

      return res.status(200).json({
        success: true,
        cliente: { id: cliente.id, nombre: cliente.nombre },
        estadisticas: {
          total: descripciones.length, descartadas_prefiltro: descartadas.length,
          analizadas_ia: 0, alta: 0, media: 0, baja: descartadas.length, errores: 0
        },
        resultados: resultadosFinales,
        mensaje: `Pre-filtro: ${descartadas.length} descartadas, 0 requieren IA`
      });
    }

    // ========== ETAPA 2: ANÁLISIS CON IA ==========
    const candidatasLimitadas = candidatas.slice(0, 10);
    if (candidatas.length > 10) console.log(`⚠️ Limitando a 10 de ${candidatas.length} candidatas`);

    if (!process.env.ClaudeAPIKeyForCompita) {
      return res.status(500).json({ success: false, error: 'API key no configurada' });
    }

    const anthropic = new Anthropic({ apiKey: process.env.ClaudeAPIKeyForCompita });

    function buildPrompt(loteDescripciones) {
      const criteriosAlta = (cliente.criterios_alta || []).join(', ');
      const criteriosMedia = (cliente.criterios_media || []).join(', ');

      return `Eres un experto analizador de licitaciones para ${cliente.nombre}.
Descripción del negocio: ${cliente.descripcion}

ESTAS DESCRIPCIONES YA PASARON UN PRE-FILTRO. Contienen palabras clave relevantes.
Analiza el CONTEXTO para clasificarlas correctamente.

CRITERIOS:
- ALTA: ${criteriosAlta}
- MEDIA: ${criteriosMedia}

Para CADA descripción:
1. QUÉ: ¿Qué se busca? (máximo 7 palabras)
2. QUIÉN: ¿Para quién? (máximo 7 palabras)
3. RELEVANCIA: ALTA, MEDIA o BAJA
4. RAZÓN: Justificación breve

IMPORTANTE - Analiza el CONTEXTO:
- "Capacitación para uso de equipos" → Si es servicio formativo: ALTA
- "Compra de materiales para capacitación" → Solo compra: BAJA

Responde en JSON:
{
  "analisis": [
    { "descripcion": "texto", "que": "síntesis", "quien": "destinatario", "relevancia": "ALTA", "razon": "explicación" }
  ]
}

DESCRIPCIONES:
${loteDescripciones.map((d, i) => `${i + 1}. ${d.descripcion}`).join('\n')}`;
    }

    async function procesarLoteIA(loteDescripciones, numeroBatch) {
      console.log(`🤖 Lote IA ${numeroBatch}: ${loteDescripciones.length} descripciones`);

      try {
        const response = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 4000,
          temperature: 0.1,
          messages: [{ role: "user", content: buildPrompt(loteDescripciones) }]
        });

        const content = response.content[0].text;
        const jsonMatch = content.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]).analisis || [];
        } else {
          return loteDescripciones.map(d => ({
            descripcion: d.descripcion, que: "Error", quien: "No analizado", relevancia: "ERROR", razon: "No se pudo extraer análisis"
          }));
        }
      } catch (error) {
        console.error(`❌ Error lote ${numeroBatch}:`, error.message);
        return loteDescripciones.map(d => ({
          descripcion: d.descripcion, que: "Error", quien: "No procesado", relevancia: "ERROR", razon: error.message
        }));
      }
    }

    const resultadosIA = [];
    const totalLotes = Math.ceil(candidatasLimitadas.length / batchSize);

    for (let i = 0; i < candidatasLimitadas.length; i += batchSize) {
      const lote = candidatasLimitadas.slice(i, Math.min(i + batchSize, candidatasLimitadas.length));
      const numeroLote = Math.floor(i / batchSize) + 1;

      try {
        const resultadosLote = await procesarLoteIA(lote, numeroLote);
        resultadosIA.push(...resultadosLote);
        console.log(`✅ Lote ${numeroLote}/${totalLotes} completado`);
      } catch (error) {
        console.error(`❌ Error crítico lote ${numeroLote}`);
        lote.forEach(d => {
          resultadosIA.push({ descripcion: d.descripcion, que: "Error", quien: "No procesado", relevancia: "ERROR", razon: "Fallo IA" });
        });
      }
    }

    // Combinar resultados
    const resultadosFinales = [
      ...descartadas.map(d => ({ descripcion: d.descripcion, que: 'Descartada', quien: 'N/A', relevancia: 'BAJA', razon: d.razon })),
      ...resultadosIA
    ];

    const estadisticas = {
      total: descripciones.length,
      descartadas_prefiltro: descartadas.length,
      analizadas_ia: resultadosIA.length,
      alta: resultadosIA.filter(r => r.relevancia === 'ALTA').length,
      media: resultadosIA.filter(r => r.relevancia === 'MEDIA').length,
      baja: resultadosIA.filter(r => r.relevancia === 'BAJA').length + descartadas.length,
      errores: resultadosIA.filter(r => r.relevancia === 'ERROR').length,
      porcentajeAlta: resultadosIA.length > 0 ? ((resultadosIA.filter(r => r.relevancia === 'ALTA').length / resultadosIA.length) * 100).toFixed(1) : 0
    };

    // Guardar en DB
    let analisis_id = null;
    if (guardar_en_db) {
      try {
        const analisisResult = await sql`
          INSERT INTO analisis (cliente_id, total_descripciones, total_alta, total_media, total_baja, porcentaje_alta, fuente, notas)
          VALUES (${cliente_id}, ${estadisticas.total}, ${estadisticas.alta}, ${estadisticas.media}, ${estadisticas.baja},
                  ${estadisticas.porcentajeAlta}, 'excel', ${`Pre-filtro: ${descartadas.length} descartadas, ${resultadosIA.length} analizadas`})
          RETURNING id
        `;
        analisis_id = analisisResult[0].id;

        for (const resultado of resultadosFinales) {
          await sql`
            INSERT INTO resultados (analisis_id, cliente_id, descripcion, que, quien, relevancia, razon)
            VALUES (${analisis_id}, ${cliente_id}, ${resultado.descripcion}, ${resultado.que}, ${resultado.quien}, ${resultado.relevancia}, ${resultado.razon})
          `;
        }
        console.log(`💾 Guardado - Análisis ID: ${analisis_id}`);
      } catch (dbError) {
        console.error('❌ Error guardando en DB:', dbError);
      }
    }

    return res.status(200).json({
      success: true,
      cliente: { id: cliente.id, nombre: cliente.nombre },
      analisis_id,
      estadisticas,
      resultados: resultadosFinales,
      mensaje: `Completado: ${descartadas.length} descartadas, ${resultadosIA.length} analizadas con IA`
    });

  } catch (error) {
    console.error('❌ Error general:', error);
    return res.status(500).json({ success: false, error: 'Error: ' + error.message });
  }
}

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
  maxDuration: 10,
};