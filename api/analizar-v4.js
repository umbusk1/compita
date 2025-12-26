// api/analizar-v4.js - SISTEMA DETERMINISTA CON VALIDACIÓN IA
import Anthropic from '@anthropic-ai/sdk';
import { neon } from '@neondatabase/serverless';

// FUNCIÓN AUXILIAR: Parsear fecha en formato DD/MM/YYYY
function parsearFechaDominicana(fechaStr) {
  if (!fechaStr) return null;

  try {
    const fechaLimpia = String(fechaStr).split('(')[0].trim().split(' ')[0];
    const partes = fechaLimpia.split('/');

    if (partes.length !== 3) return null;

    const dia = parseInt(partes[0], 10);
    const mes = parseInt(partes[1], 10) - 1;
    const año = parseInt(partes[2], 10);

    if (isNaN(dia) || isNaN(mes) || isNaN(año)) return null;

    const fecha = new Date(año, mes, dia);
    if (isNaN(fecha.getTime())) return null;

    return fecha;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const { cliente_id, licitaciones, guardar_en_db = true } = req.body;

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

    // ========== ETAPA 1: FILTROS DE EXCLUSIÓN ==========
    function aplicarFiltrosExclusion(lic) {
      const descripcion = (lic.descripcion || '').toLowerCase();
      const estado = (lic.estado || '').toLowerCase();
      const fechaPresentacion = lic.fecha_presentacion;

      // 1. FILTRO POR ESTADO
      const estadosExcluidos = ['adjudicado', 'celebrado', 'cancelado', 'desierto'];
      const tieneEstadoExcluido = estadosExcluidos.some(e => estado.includes(e));

      if (tieneEstadoExcluido) {
        return { excluir: true, razon: `Estado excluido: ${lic.estado}` };
      }

      // 2. FILTRO POR FECHA
      if (fechaPresentacion) {
        const fecha = parsearFechaDominicana(fechaPresentacion);

        if (fecha) {
          const hoy = new Date();
          const fechaSoloFecha = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
          const hoySoloFecha = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());

          if (fechaSoloFecha <= hoySoloFecha) {
            return { excluir: true, razon: `Fecha vencida o es HOY: ${fechaPresentacion}` };
          }
        }
      }

      // 3. FILTRO POR EXCLUSIONES
      if (cliente.exclusiones && cliente.exclusiones.length > 0) {
        const tieneExclusion = cliente.exclusiones.some(excl =>
          descripcion.includes(excl.toLowerCase())
        );

        if (tieneExclusion) {
          return { excluir: true, razon: 'Contiene palabra de exclusión' };
        }
      }

      return { excluir: false };
    }

    const excluidas = [];
    const candidatas = [];

    licitaciones.forEach(lic => {
      const resultado = aplicarFiltrosExclusion(lic);
      if (resultado.excluir) {
        excluidas.push({ ...lic, razon_exclusion: resultado.razon });
      } else {
        candidatas.push(lic);
      }
    });

    console.log(`✅ Etapa 1 (Exclusión): ${excluidas.length} excluidas, ${candidatas.length} candidatas`);

    // ========== ETAPA 2: CLASIFICACIÓN AUTOMÁTICA ==========
    const palabrasClave = cliente.palabras_clave || [];
    const umbralMonto = cliente.monto_minimo_alta || 1000000;

    console.log(`🔑 Palabras clave: ${palabrasClave.join(', ')}`);
    console.log(`💰 Umbral monto ALTA: ${umbralMonto.toLocaleString()} DOP`);

    const clasificadas = candidatas.map(lic => {
      const descripcion = (lic.descripcion || '').toLowerCase();

      // Buscar palabras clave
      const palabrasEncontradas = palabrasClave.filter(palabra =>
        descripcion.includes(palabra.toLowerCase())
      );

      if (palabrasEncontradas.length === 0) {
        // No tiene palabras clave, se excluye
        excluidas.push({
          ...lic,
          razon_exclusion: 'No contiene palabras clave relevantes'
        });
        return null;
      }

      // Tiene palabras clave → MEDIA por defecto
      let relevancia = 'MEDIA';
      let razon = `Palabras clave: ${palabrasEncontradas.slice(0, 3).join(', ')}`;

      // Si monto >= umbral → ALTA
      const monto = parseFloat(lic.monto_estimado);
      if (!isNaN(monto) && monto >= umbralMonto) {
        relevancia = 'ALTA';
        razon += ` | Monto >= ${umbralMonto.toLocaleString()} DOP`;
      }

      return {
        ...lic,
        relevancia,
        razon_clasificacion: razon,
        palabras_encontradas: palabrasEncontradas
      };
    }).filter(Boolean); // Eliminar nulls

    console.log(`✅ Etapa 2 (Clasificación): ${clasificadas.length} oportunidades (${clasificadas.filter(c => c.relevancia === 'ALTA').length} ALTA, ${clasificadas.filter(c => c.relevancia === 'MEDIA').length} MEDIA)`);

    if (clasificadas.length === 0) {
      // No hay oportunidades relevantes
      const resultadosFinales = excluidas.map(e => ({
        ...extraerCamposLicitacion(e),
        que: 'Descartada',
        quien: 'N/A',
        relevancia: 'BAJA',
        razon: e.razon_exclusion,
        compatible: null
      }));

      return res.status(200).json({
        success: true,
        cliente: { id: cliente.id, nombre: cliente.nombre },
        estadisticas: {
          total: licitaciones.length,
          excluidas: excluidas.length,
          relevantes: 0,
          alta: 0,
          media: 0,
          incompatibles: 0
        },
        resultados: resultadosFinales,
        mensaje: `No se encontraron oportunidades relevantes`
      });
    }

    // ========== ETAPA 3: VALIDACIÓN CON IA ==========
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ success: false, error: 'API key no configurada' });
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    console.log(`🤖 Etapa 3 (Validación IA): Validando ${clasificadas.length} oportunidades...`);

    // Construir prompt de validación
    function buildValidationPrompt(oportunidades) {
      return `Eres un experto validador de licitaciones para ${cliente.nombre}.

DESCRIPCIÓN DEL NEGOCIO:
${cliente.descripcion}

TAREA: Valida si estas oportunidades son COMPATIBLES con la naturaleza del negocio descrito arriba.

CRITERIOS DE COMPATIBILIDAD:
- ¿El servicio/producto solicitado es algo que esta empresa puede ofrecer?
- ¿Está alineado con el giro del negocio?
- ¿Tiene sentido que esta empresa participe en esta licitación?

Para CADA oportunidad responde SOLO:
- "compatible": true o false
- "razon_validacion": Explicación breve (máximo 15 palabras)

NO cambies la clasificación ALTA/MEDIA, solo valida compatibilidad.

Responde en JSON:
{
  "validaciones": [
    { "indice": 0, "compatible": true, "razon_validacion": "explicación" }
  ]
}

OPORTUNIDADES A VALIDAR:
${oportunidades.map((o, i) => `${i}. [${o.relevancia}] ${o.descripcion}`).join('\n')}`;
    }

    // Procesar en lotes de 10
    const resultadosValidados = [];
    const batchSize = 10;

    for (let i = 0; i < clasificadas.length; i += batchSize) {
      const lote = clasificadas.slice(i, Math.min(i + batchSize, clasificadas.length));
      const numeroLote = Math.floor(i / batchSize) + 1;
      const totalLotes = Math.ceil(clasificadas.length / batchSize);

      console.log(`🤖 Validando lote ${numeroLote}/${totalLotes} (${lote.length} oportunidades)...`);

      try {
        const response = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 4000,
          temperature: 0,
          messages: [{ role: "user", content: buildValidationPrompt(lote) }]
        });

        const content = response.content[0].text;
        const jsonMatch = content.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
          const validaciones = JSON.parse(jsonMatch[0]).validaciones || [];

          lote.forEach((oportunidad, idx) => {
            const validacion = validaciones.find(v => v.indice === idx) || {
              compatible: true,
              razon_validacion: 'No validado'
            };

            resultadosValidados.push({
              ...oportunidad,
              compatible: validacion.compatible,
              razon_validacion: validacion.razon_validacion
            });
          });
        } else {
          // Si no hay respuesta JSON válida, marcar todas como compatibles
          lote.forEach(oportunidad => {
            resultadosValidados.push({
              ...oportunidad,
              compatible: true,
              razon_validacion: 'No se pudo validar'
            });
          });
        }

        console.log(`✅ Lote ${numeroLote}/${totalLotes} validado`);
      } catch (error) {
        console.error(`❌ Error validando lote ${numeroLote}:`, error.message);
        // En caso de error, marcar todas como compatibles
        lote.forEach(oportunidad => {
          resultadosValidados.push({
            ...oportunidad,
            compatible: true,
            razon_validacion: 'Error en validación'
          });
        });
      }
    }

    const incompatibles = resultadosValidados.filter(r => r.compatible === false).length;
    console.log(`✅ Validación completa: ${incompatibles} incompatibles de ${resultadosValidados.length}`);

    // Combinar todos los resultados
    const resultadosFinales = [
      ...excluidas.map(e => ({
        ...extraerCamposLicitacion(e),
        que: 'Descartada',
        quien: 'N/A',
        relevancia: 'BAJA',
        razon: e.razon_exclusion,
        compatible: null
      })),
      ...resultadosValidados.map(r => ({
        ...extraerCamposLicitacion(r),
        que: r.que || (r.compatible ? 'Oportunidad relevante' : 'Aparentemente incompatible'),
        quien: r.quien || 'Por determinar',
        relevancia: r.relevancia,
        razon: r.razon_clasificacion,
        razon_validacion: r.razon_validacion,
        compatible: r.compatible
      }))
    ];

    const estadisticas = {
      total: licitaciones.length,
      excluidas: excluidas.length,
      relevantes: resultadosValidados.length,
      alta: resultadosValidados.filter(r => r.relevancia === 'ALTA').length,
      media: resultadosValidados.filter(r => r.relevancia === 'MEDIA').length,
      incompatibles: incompatibles
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
            ${cliente_id},
            ${estadisticas.total},
            ${estadisticas.alta},
            ${estadisticas.media},
            ${estadisticas.excluidas},
            ${estadisticas.alta > 0 ? ((estadisticas.alta / estadisticas.total) * 100).toFixed(1) : 0},
            'excel',
            ${`Excluidas: ${estadisticas.excluidas}, Relevantes: ${estadisticas.relevantes}, Incompatibles: ${estadisticas.incompatibles}`}
          )
          RETURNING id
        `;
        analisis_id = analisisResult[0].id;

        for (const resultado of resultadosFinales) {
          await sql`
            INSERT INTO resultados (
              analisis_id, cliente_id, descripcion, que, quien, relevancia, razon,
              referencia, unidad_compras, fecha_presentacion, monto_estimado, estado, compatible
            )
            VALUES (
              ${analisis_id}, ${cliente_id}, ${resultado.descripcion},
              ${resultado.que}, ${resultado.quien}, ${resultado.relevancia},
              ${resultado.razon || ''} ${resultado.razon_validacion ? '| ' + resultado.razon_validacion : ''},
              ${resultado.referencia}, ${resultado.unidad_compras}, ${resultado.fecha_presentacion},
              ${resultado.monto_estimado}, ${resultado.estado}, ${resultado.compatible}
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
      mensaje: `Completado: ${estadisticas.excluidas} excluidas, ${estadisticas.relevantes} relevantes (${estadisticas.incompatibles} aparentemente incompatibles)`
    });

  } catch (error) {
    console.error('❌ Error general:', error);
    return res.status(500).json({ success: false, error: 'Error: ' + error.message });
  }
}

function extraerCamposLicitacion(lic) {
  let fechaDB = null;
  if (lic.fecha_presentacion) {
    const fecha = parsearFechaDominicana(lic.fecha_presentacion);
    if (fecha) {
      fechaDB = fecha.toISOString().split('T')[0];
    }
  }

  return {
    referencia: lic.referencia || '',
    unidad_compras: lic.unidad_compras || '',
    descripcion: lic.descripcion || '',
    fecha_presentacion: fechaDB,
    monto_estimado: lic.monto_estimado || null,
    estado: lic.estado || '',
    que: lic.que || '',
    quien: lic.quien || '',
    relevancia: lic.relevancia || '',
    razon: lic.razon || '',
    razon_validacion: lic.razon_validacion || null,
    compatible: lic.compatible !== undefined ? lic.compatible : null
  };
}

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
  maxDuration: 10,
};