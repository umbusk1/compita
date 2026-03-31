// api/obtener-oportunidades.js
import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Enrutador POST ──────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { accion } = req.body || {};
    if (accion === 'marcar_actividad') return await handleMarcarActividad(req, res);
    return await handleDescartar(req, res);
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Método no permitido' });
  }

  const sql = neon(process.env.DATABASE_URL);

  // ── GET: estado público (landing page, sin autenticación) ──────────────────
  if (req.query.action === 'estado_publico') {
    try {
      const estado = await sql`
        SELECT estado, motivo, modal_activo FROM sistema_estado WHERE id = 1 LIMIT 1
      `;
      const fila = estado[0] || {};
      return res.status(200).json({
        sistema_activo:    !(fila.estado === 'SUSPENDIDO' && fila.modal_activo === true),
        motivo_suspension: fila.motivo || null
      });
    } catch {
      return res.status(200).json({ sistema_activo: true, motivo_suspension: null });
    }
  }

  // ── Autenticación (requerida para todo lo demás) ───────────────────────────
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No autorizado' });
  }
  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET || 'compita-secret-2024');
  } catch {
    return res.status(401).json({ success: false, error: 'Token inválido' });
  }

  const usuario = await sql`
    SELECT u.id, u.empresa_id, e.plan, e.trial_fin
    FROM usuarios u JOIN empresas e ON u.empresa_id = e.id
    WHERE u.email = ${decoded.email} LIMIT 1
  `;
  if (usuario.length === 0) {
    return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
  }
  const { empresa_id, plan } = usuario[0];

  // ── GET: historial ─────────────────────────────────────────────────────────
  if (req.query.action === 'historial') {
    try {
      // 1. Con actividad: bajó pliego o solicitó análisis IA
      const conActividad = await sql`
        SELECT id as resultado_id, referencia, que, quien, monto_estimado,
               fecha_presentacion, relevancia, descartada,
               bajo_pliego, solicito_analisis_ia, fecha_analisis
        FROM resultados
        WHERE empresa_id = ${empresa_id}
          AND (bajo_pliego = TRUE OR solicito_analisis_ia = TRUE)
        ORDER BY fecha_analisis DESC
        LIMIT 100
      `;

      // 2. Descartadas por el usuario
      const descartadas = await sql`
        SELECT id as resultado_id, referencia, que, quien, monto_estimado,
               fecha_presentacion, relevancia, descartada,
               bajo_pliego, solicito_analisis_ia, fecha_analisis
        FROM resultados
        WHERE empresa_id = ${empresa_id}
          AND descartada = TRUE
        ORDER BY fecha_analisis DESC
        LIMIT 100
      `;

      // 3. Ignoradas: vencidas, nunca interactuadas, no descartadas
      const ignoradas = await sql`
        SELECT id as resultado_id, referencia, que, quien, monto_estimado,
               fecha_presentacion, relevancia, descartada,
               bajo_pliego, solicito_analisis_ia, fecha_analisis
        FROM resultados
        WHERE empresa_id = ${empresa_id}
          AND relevancia IN ('ALTA', 'MEDIA')
          AND (descartada IS NULL OR descartada = FALSE)
          AND (bajo_pliego IS NULL OR bajo_pliego = FALSE)
          AND (solicito_analisis_ia IS NULL OR solicito_analisis_ia = FALSE)
          AND fecha_presentacion < CURRENT_DATE
        ORDER BY fecha_presentacion DESC
        LIMIT 100
      `;

      return res.status(200).json({
        success: true,
        con_actividad: conActividad,
        descartadas:   descartadas,
        ignoradas:     ignoradas
      });
    } catch (error) {
      console.error('Error cargando historial:', error);
      return res.status(500).json({ success: false, error: 'Error al cargar historial' });
    }
  }

  // ── GET: oportunidades activas (flujo original) ────────────────────────────
  try {
    let sistemaSuspendido = false, motivoSuspension = null;
    try {
      const estadoSistema = await sql`
        SELECT estado, motivo, modal_activo FROM sistema_estado WHERE id = 1 LIMIT 1
      `;
      if (estadoSistema.length > 0) {
        const { estado, motivo, modal_activo } = estadoSistema[0];
        if (estado === 'SUSPENDIDO' && modal_activo === true) {
          sistemaSuspendido = true;
          motivoSuspension  = motivo;
        }
      }
    } catch {}

    const ahora = new Date();
    let diasHistorial = plan === 'business' || plan === 'enterprise' ? 90 : 30;
    const fechaLimite = new Date(ahora);
    fechaLimite.setDate(fechaLimite.getDate() - diasHistorial);

    const oportunidades = await sql`
      SELECT
        r.id as resultado_id,
        r.relevancia, r.razon, r.fecha_analisis, r.notificada,
        r.bajo_pliego, r.solicito_analisis_ia,
        l.id as licitacion_id,
        l.referencia,
        l.descripcion as que,
        l.unidad_compras as quien,
        l.monto_estimado,
        l.fecha_presentacion,
        l.url_detalle,
        l.fecha_publicacion,
        l.scrapeado_en as scraped_at
      FROM resultados r
      JOIN licitaciones l ON r.licitacion_id = l.id
      WHERE r.empresa_id = ${empresa_id}
        AND r.relevancia IN ('ALTA', 'MEDIA')
        AND r.fecha_analisis >= ${fechaLimite.toISOString()}
        AND l.fecha_presentacion >= CURRENT_DATE
        AND (r.descartada IS NULL OR r.descartada = FALSE)
      ORDER BY
        CASE r.relevancia WHEN 'ALTA' THEN 1 WHEN 'MEDIA' THEN 2 ELSE 3 END,
        r.fecha_analisis DESC
    `;

    const hace48horas = new Date(ahora);
    hace48horas.setHours(hace48horas.getHours() - 48);

    const oportunidadesConMetadata = oportunidades.map(op => ({
      ...op,
      es_nuevo: new Date(op.fecha_analisis) > hace48horas
    }));

    return res.status(200).json({
      success: true,
      oportunidades: oportunidadesConMetadata,
      plan, total: oportunidadesConMetadata.length,
      estadisticas: {
        alta:   oportunidadesConMetadata.filter(o => o.relevancia === 'ALTA').length,
        media:  oportunidadesConMetadata.filter(o => o.relevancia === 'MEDIA').length,
        nuevas: oportunidadesConMetadata.filter(o => o.es_nuevo).length
      },
      sistema_activo:    !sistemaSuspendido,
      motivo_suspension: motivoSuspension
    });

  } catch (error) {
    console.error('Error obteniendo oportunidades:', error);
    return res.status(500).json({ success: false, error: 'Error al cargar oportunidades' });
  }
}

// ── POST: descartar ──────────────────────────────────────────────────────────
async function handleDescartar(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No autorizado' });
    }
    const token = authHeader.split(' ')[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET || 'compita-secret-2024');
    } catch {
      return res.status(401).json({ success: false, error: 'Token inválido' });
    }

    const { resultado_id, descartar } = req.body;
    if (!resultado_id) {
      return res.status(400).json({ success: false, error: 'resultado_id requerido' });
    }

    const usuario = await sql`
      SELECT empresa_id FROM usuarios WHERE email = ${decoded.email} LIMIT 1
    `;
    if (usuario.length === 0) {
      return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    }

    await sql`
      UPDATE resultados
      SET descartada = ${descartar !== false}
      WHERE id = ${resultado_id} AND empresa_id = ${usuario[0].empresa_id}
    `;

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error al descartar:', error);
    return res.status(500).json({ success: false, error: 'Error al descartar' });
  }
}

// ── POST: marcar actividad (bajo_pliego / solicito_analisis_ia) ──────────────
async function handleMarcarActividad(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No autorizado' });
    }
    const token = authHeader.split(' ')[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET || 'compita-secret-2024');
    } catch {
      return res.status(401).json({ success: false, error: 'Token inválido' });
    }

    const { resultado_id, tipo } = req.body;
    if (!resultado_id || !tipo) {
      return res.status(400).json({ success: false, error: 'resultado_id y tipo requeridos' });
    }

    const usuario = await sql`
      SELECT empresa_id FROM usuarios WHERE email = ${decoded.email} LIMIT 1
    `;
    if (usuario.length === 0) {
      return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    }

    const empresa_id = usuario[0].empresa_id;

    if (tipo === 'bajo_pliego') {
      await sql`
        UPDATE resultados SET bajo_pliego = TRUE
        WHERE id = ${resultado_id} AND empresa_id = ${empresa_id}
      `;
    } else if (tipo === 'solicito_analisis_ia') {
      await sql`
        UPDATE resultados SET solicito_analisis_ia = TRUE
        WHERE id = ${resultado_id} AND empresa_id = ${empresa_id}
      `;
    } else {
      return res.status(400).json({ success: false, error: 'Tipo inválido' });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error marcando actividad:', error);
    return res.status(500).json({ success: false, error: 'Error al marcar actividad' });
  }
}

export const config = { maxDuration: 10 };