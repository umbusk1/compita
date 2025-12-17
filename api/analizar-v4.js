// api/analizar-v4.js - SISTEMA AVANZADO CON FECHA, ESTADO Y MONTO
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
    const { cliente_id, licitaciones, batchSize = 5, guardar_en_db = true } = req.body;

    if (!cliente_id) return res.status(400).json({ success: false, error: 'cliente_id es requerido' });
    if (!licitaciones || !Array.isArray(licitaciones)) {
      return res.status(400).json({ success: false, error: 'Debe enviar un array de licitaciones' });
    }

    const sql = neon(process.env.DATABASE_URL);
    const clienteData = await sql`SELECT * FROM clientes WHERE id = ${cliente_id} AND activo = true`;

    if (clienteData.length === 0) {
      return res.status(404).json({ success: false, error: 'Cliente no encontrado' });
    }

    const cliente = clienteData[0];
    console.log(`📊 Cliente: ${cliente.nombre} | ${licitaciones.length} licitaciones totales`);

    // ========== ETAPA 1: PRE-FILTRO AVANZADO ==========
    function prefiltrarLicitacion(lic) {
      const descripcion = (lic.descripcion || '').toLowerCase();
      const estado = (lic.estado || '').toLowerCase();
      const fechaPresentacion = lic.fecha_presentacion;

      // 1. FILTRO POR ESTADO
      const estadosExcluidos = ['adjudicado', 'celebrado', 'cancelado', 'desierto'];
      const tieneEstadoExcluido = estadosExcluidos.some(e => estado.includes(e));

      if (tieneEstadoExcluido) {
        return {
          pasa: false,
          razon: `Estado excluido: ${lic.estado}`
        };
      }

      // 2. FILTRO POR FECHA
      if (fechaPresentacion) {
        try {
          const fecha = new Date(fechaPresentacion);
          const hoy = new Date();
          hoy.setHours(0, 0, 0, 0);

          if (fecha <= hoy) {
            return {
              pasa: false,
              razon: `Fecha vencida: ${fechaPresentacion}`
            };
          }
        } catch (e) {
          console.log('Error parseando fecha:', fechaPresentacion);
        }
      }

      // 3. FILTRO POR EXCLUSIONES (palabras clave)
      if (cliente.exclusiones && cliente.exclusiones.length > 0) {
        const tieneExclusion = cliente.exclusiones.some(excl =>
          descripcion.includes(excl.toLowerCase())
        );

        if (tieneExclusion) {
          return {
            pasa: false,
            razon: 'Contiene palabra de exclusión'
          };
        }
      }

      // 4. FILTRO POR PALABRAS CLAVE (ALTA o MEDIA)
      const criteriosAlta = cliente.criterios_alta || [];
      const criteriosMedia = cliente.criterios_media || [];
      const todosCriterios = [...criteriosAlta, ...criteriosMedia];

      if (todosCriterios.length === 0) {
        return { pasa: true, razon: 'Cliente sin criterios - enviar a IA' };
      }

      const palabrasEncontradas = todosCriterios.filter(palabra =>
        descripcion.includes(palabra.toLowerCase())
      );

      if (palabrasEncontradas.length === 0) {
        return {
          pasa: false,
          razon: 'No contiene palabras clave relevantes'
        };
      }

      return {
        pasa: true,
        razon: `Contiene: ${palabrasEncontradas.slice(0, 3).join(', ')}`,
        palabrasEncontradas
      };
    }

    const resultadosPrefiltro = licitaciones.map(lic => ({
      ...lic,
      ...prefiltrarLicitacion(lic)
    }));

    const descartadas = resultadosPrefiltro.filter(r => !r.pasa);
    const candidatas = resultadosPrefiltro.filter(r => r.pasa);

    console.log(`✅ Etapa 1: ${descartadas.length} descartadas, ${candidatas.length} candidatas`);

    if (candidatas.length === 0) {
      const resultadosFinales = descartadas.map(d => ({
        ...extraerCamposLicitacion(d),
        que: 'Descartada',
        quien: 'N/A',
        relevancia: 'BAJA',
        razon: d.razon
      }));

      return res.status(200).json({
        success: true,
        cliente: { id: cliente.id, nombre: cliente.nombre },
        estadisticas: {
          total: licitaciones.length,
          descartadas_prefiltro: descartadas.length,
          analizadas_ia: 0,
          alta: 0,
          media: 0,
          baja: descartadas.length,
          errores: 0
        },
        resultados: resultadosFinales,
        mensaje: `Pre-filtro: ${descartadas.length} descartadas, 0 requieren IA`
      });
    }

    // ========== ETAPA 2: ANÁLISIS CON IA ==========
    const candidatasLimitadas = candidatas.slice(0, 10);
    if (candidatas.length > 10) {
      console.log(`⚠️ Limitando a 10 de ${candidatas.length} candidatas`);
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ success: false, error: 'API key no configurada' });
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    function buildPrompt(loteLicitaciones) {
      const criteriosAlta = (cliente.criterios_alta || []).join(', ');
      const criteriosMedia = (cliente.criterios_media || []).join(', ');

      return `Eres un experto analizador de licitaciones para ${cliente.nombre}.
Descripción del negocio: ${cliente.descripcion}

ESTAS DESCRIPCIONES YA PASARON FILTROS DE FECHA, ESTADO Y PALABRAS CLAVE.
Analiza el CONTEXTO para clasificarlas correctamente.

CRITERIOS:
- ALTA: ${criteriosAlta}
- MEDIA: ${criteriosMedia}

Para CADA licitación:
1. QUÉ: ¿Qué se busca? (máximo 7 palabras)
2. QUIÉN: ¿Para quién? (máximo 7 palabras)
3. RELEVANCIA: ALTA, MEDIA o BAJA
4. RAZÓN: Justificación breve

IMPORTANTE - Analiza el CONTEXTO:
- "Capacitación para uso de equipos" → Si es servicio formativo: ALTA/MEDIA
- "Compra de materiales para capacitación" → Solo compra: BAJA

Responde en JSON:
{
  "analisis": [
    { "indice": 0, "que": "síntesis", "quien": "destinatario", "relevancia": "ALTA", "razon": "explicación" }
  ]
}

LICITACIONES:
${loteLicitaciones.map((lic, i) => `${i}. ${lic.descripcion}`).join('\n')}`;
    }

    async function procesarLoteIA(loteLicitaciones, numeroBatch) {
      console.log(`🤖 Lote IA ${numeroBatch}: ${loteLicitaciones.length} licitaciones`);

      try {
        const response = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 4000,
          temperature: 0.1,
          messages: [{ role: "user", content: buildPrompt(loteLicitaciones) }]
        });

        const content = response.content[0].text;
        const jsonMatch = content.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
          const analisis = JSON.parse(jsonMatch[0]).analisis || [];

          // Mapear resultados con índices
          return loteLicitaciones.map((lic, i) => {
            const resultado = analisis.find(a => a.indice === i) || {
              que: "Error", quien: "No analizado", relevancia: "ERROR", razon: "No encontrado"
            };

            return {
              ...lic,
              ...resultado
            };
          });
        } else {
          return loteLicitaciones.map(lic => ({
            ...lic,
            que: "Error",
            quien: "No analizado",
            relevancia: "ERROR",
            razon: "No se pudo extraer análisis"
          }));
        }
      } catch (error) {
        console.error(`❌ Error lote ${numeroBatch}:`, error.message);
        return loteLicitaciones.map(lic => ({
          ...lic,
          que: "Error",
          quien: "No procesado",
          relevancia: "ERROR",
          razon: error.message
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
        lote.forEach(lic => {
          resultadosIA.push({
            ...lic,
            que: "Error",
            quien: "No procesado",
            relevancia: "ERROR",
            razon: "Fallo IA"
          });
        });
      }
    }

    // ========== AJUSTE POR MONTO ==========
    const umbralMonto = cliente.monto_minimo_alta || 1000000;

    resultadosIA.forEach(r => {
      if (r.relevancia === 'MEDIA' && r.monto_estimado && parseFloat(r.monto_estimado) >= umbralMonto) {
        r.relevancia = 'ALTA';
        r.razon = `${r.razon} [Subido a ALTA por monto >= ${umbralMonto.toLocaleString()}]`;
        console.log(`💰 Subido a ALTA por monto: ${r.referencia}`);
      }
    });

    // Combinar resultados finales
    const resultadosFinales = [
      ...descartadas.map(d => ({
        ...extraerCamposLicitacion(d),
        que: 'Descartada',
        quien: 'N/A',
        relevancia: 'BAJA',
        razon: d.razon
      })),
      ...resultadosIA.map(r => extraerCamposLicitacion(r))
    ];

    const estadisticas = {
      total: licitaciones.length,
      descartadas_prefiltro: descartadas.length,
      analizadas_ia: resultadosIA.length,
      alta: resultadosIA.filter(r => r.relevancia === 'ALTA').length,
      media: resultadosIA.filter(r => r.relevancia === 'MEDIA').length,
      baja: resultadosIA.filter(r => r.relevancia === 'BAJA').length + descartadas.length,
      errores: resultadosIA.filter(r => r.relevancia === 'ERROR').length
    };

    // Guardar en DB
    let analisis_id = null;
    if (guardar_en_db) {
      try {
        const analisisResult = await sql`
          INSERT INTO analisis (
            cliente_id, total_descripciones, total_alta, total_media, total_baja,
            porcentaje_alta, fuente, notas
          )
          VALUES (
            ${cliente_id}, ${estadisticas.total}, ${estadisticas.alta}, ${estadisticas.media},
            ${estadisticas.baja}, ${((estadisticas.alta / estadisticas.total) * 100).toFixed(1)},
            'excel', ${`Prefiltro: ${descartadas.length} descartadas, ${resultadosIA.length} analizadas`}
          )
          RETURNING id
        `;
        analisis_id = analisisResult[0].id;

        for (const resultado of resultadosFinales) {
          await sql`
            INSERT INTO resultados (
              analisis_id, cliente_id, descripcion, que, quien, relevancia, razon,
              referencia, unidad_compras, fecha_presentacion, monto_estimado, estado
            )
            VALUES (
              ${analisis_id}, ${cliente_id}, ${resultado.descripcion},
              ${resultado.que}, ${resultado.quien}, ${resultado.relevancia}, ${resultado.razon},
              ${resultado.referencia}, ${resultado.unidad_compras}, ${resultado.fecha_presentacion},
              ${resultado.monto_estimado}, ${resultado.estado}
            )
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

function extraerCamposLicitacion(lic) {
  return {
    referencia: lic.referencia || '',
    unidad_compras: lic.unidad_compras || '',
    descripcion: lic.descripcion || '',
    fecha_presentacion: lic.fecha_presentacion || null,
    monto_estimado: lic.monto_estimado || null,
    estado: lic.estado || '',
    que: lic.que || '',
    quien: lic.quien || '',
    relevancia: lic.relevancia || '',
    razon: lic.razon || ''
  };
}

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
  maxDuration: 10,
};