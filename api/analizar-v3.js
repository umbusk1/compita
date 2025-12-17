// api/analizar-v3.js - VERSION MULTI-CLIENTE CON DB
import Anthropic from '@anthropic-ai/sdk';
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    const { 
      cliente_id, 
      descripciones, 
      batchSize = 5,
      guardar_en_db = true 
    } = req.body;

    if (!cliente_id) {
      return res.status(400).json({
        success: false,
        error: 'cliente_id es requerido'
      });
    }

    if (!descripciones || !Array.isArray(descripciones)) {
      return res.status(400).json({
        success: false,
        error: 'Debe enviar un array de descripciones'
      });
    }

    const sql = neon(process.env.NETLIFYDATABASEURL);

    const clienteData = await sql`
      SELECT * FROM clientes WHERE id = ${cliente_id} AND activo = true
    `;

    if (clienteData.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Cliente no encontrado'
      });
    }

    const cliente = clienteData[0];
    const descripcionesLimitadas = descripciones.slice(0, 10);

    if (descripciones.length > 10) {
      console.log(`⚠️ Limitando a 10 de ${descripciones.length} descripciones`);
    }

    if (!process.env.ClaudeAPIKeyForCompita) {
      return res.status(500).json({
        success: false,
        error: 'API key no configurada'
      });
    }

    const anthropic = new Anthropic({
      apiKey: process.env.ClaudeAPIKeyForCompita
    });

    function buildPrompt(loteDescripciones) {
      const criteriosAlta = cliente.criterios_alta?.join(', ') || 'servicios especializados';
      const criteriosMedia = cliente.criterios_media?.join(', ') || 'servicios relacionados';
      const criteriosBaja = cliente.criterios_baja?.join(', ') || 'otros servicios';

      const promptBase = cliente.prompt_personalizado || `Eres un experto analizador de licitaciones y compras públicas de República Dominicana.

TAREA: Analiza estas descripciones de compras públicas para identificar oportunidades para ${cliente.nombre}, empresa especializada en: ${cliente.descripcion}.

Para CADA descripción, determina con comprensión contextual (no mecánica):
1. QUÉ: ¿Qué se busca realmente? (máximo 7 palabras, sé específico)
2. QUIÉN: ¿Para quién o qué es? (máximo 7 palabras, identifica el destinatario real)
3. RELEVANCIA: Clasifica como ALTA/MEDIA/BAJA
4. RAZÓN: Explica brevemente por qué es o no relevante (1 línea concisa)

CRITERIOS DE RELEVANCIA para ${cliente.nombre}:
- ALTA: ${criteriosAlta}
- MEDIA: ${criteriosMedia}
- BAJA: ${criteriosBaja}

IMPORTANTE - Lee el CONTEXTO completo, no te guíes por palabras sueltas.

Responde SIEMPRE en formato JSON válido con esta estructura exacta:
{
  "analisis": [
    {
      "descripcion": "texto original completo",
      "que": "síntesis en max 7 palabras",
      "quien": "destinatario en max 7 palabras",
      "relevancia": "ALTA",
      "razon": "explicación breve"
    }
  ]
}

DESCRIPCIONES A ANALIZAR:
${loteDescripciones.map((d, i) => `${i + 1}. ${d}`).join('\n')}`;

      return promptBase;
    }

    async function procesarLote(loteDescripciones, numeroBatch) {
      console.log(`✅ Lote ${numeroBatch}: ${loteDescripciones.length} descripciones`);

      const prompt = buildPrompt(loteDescripciones);

      try {
        const response = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 4000,
          temperature: 0.1,
          messages: [{
            role: "user",
            content: prompt
          }]
        });

        const content = response.content[0].text;
        const jsonMatch = content.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
          const resultado = JSON.parse(jsonMatch[0]);
          return resultado.analisis || [];
        } else {
          return loteDescripciones.map(d => ({
            descripcion: d,
            que: "Error al procesar",
            quien: "No analizado",
            relevancia: "ERROR",
            razon: "No se pudo extraer análisis"
          }));
        }
      } catch (error) {
        console.error(`❌ Error lote ${numeroBatch}:`, error.message);
        return loteDescripciones.map(d => ({
          descripcion: d,
          que: "Error en procesamiento",
          quien: "No procesado",
          relevancia: "ERROR",
          razon: error.message
        }));
      }
    }

    const resultados = [];
    const totalLotes = Math.ceil(descripcionesLimitadas.length / batchSize);

    console.log(`📊 Cliente: ${cliente.nombre} | ${descripcionesLimitadas.length} descripciones | ${totalLotes} lotes`);

    for (let i = 0; i < descripcionesLimitadas.length; i += batchSize) {
      const lote = descripcionesLimitadas.slice(i, Math.min(i + batchSize, descripcionesLimitadas.length));
      const numeroLote = Math.floor(i / batchSize) + 1;

      try {
        const resultadosLote = await procesarLote(lote, numeroLote);
        resultados.push(...resultadosLote);
      } catch (error) {
        console.error(`❌ Error crítico lote ${numeroLote}`);
        lote.forEach(d => {
          resultados.push({
            descripcion: d,
            que: "Error crítico",
            quien: "No procesado",
            relevancia: "ERROR",
            razon: "Fallo en comunicación"
          });
        });
      }
    }

    const estadisticas = {
      total: resultados.length,
      alta: resultados.filter(r => r.relevancia === 'ALTA').length,
      media: resultados.filter(r => r.relevancia === 'MEDIA').length,
      baja: resultados.filter(r => r.relevancia === 'BAJA').length,
      errores: resultados.filter(r => r.relevancia === 'ERROR').length,
      porcentajeAlta: resultados.length > 0
        ? ((resultados.filter(r => r.relevancia === 'ALTA').length / resultados.length) * 100).toFixed(1)
        : 0
    };

    let analisis_id = null;
    
    if (guardar_en_db) {
      try {
        const analisisResult = await sql`
          INSERT INTO analisis (
            cliente_id,
            total_descripciones,
            total_alta,
            total_media,
            total_baja,
            porcentaje_alta,
            fuente
          ) VALUES (
            ${cliente_id},
            ${estadisticas.total},
            ${estadisticas.alta},
            ${estadisticas.media},
            ${estadisticas.baja},
            ${estadisticas.porcentajeAlta},
            'excel'
          )
          RETURNING id
        `;

        analisis_id = analisisResult[0].id;

        for (const resultado of resultados) {
          await sql`
            INSERT INTO resultados (
              analisis_id,
              cliente_id,
              descripcion,
              que,
              quien,
              relevancia,
              razon
            ) VALUES (
              ${analisis_id},
              ${cliente_id},
              ${resultado.descripcion},
              ${resultado.que},
              ${resultado.quien},
              ${resultado.relevancia},
              ${resultado.razon}
            )
          `;
        }

        console.log(`💾 Guardado en DB - Análisis ID: ${analisis_id}`);
      } catch (dbError) {
        console.error('❌ Error guardando en DB:', dbError);
      }
    }

    return res.status(200).json({
      success: true,
      cliente: {
        id: cliente.id,
        nombre: cliente.nombre
      },
      analisis_id,
      estadisticas,
      resultados,
      mensaje: `Análisis completado para ${cliente.nombre}: ${resultados.length} descripciones procesadas`
    });

  } catch (error) {
    console.error('❌ Error general:', error);
    return res.status(500).json({
      success: false,
      error: 'Error en el servidor: ' + error.message
    });
  }
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
  },
  maxDuration: 10,
};
