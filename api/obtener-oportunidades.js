// api/obtener-oportunidades.js
import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST') {
    return await handleDescartar(req, res);
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      error: 'Método no permitido'
    });
  }

  // ── NUEVO: acción pública sin autenticación ──────────────────────────────
  // Usada por la landing page para mostrar el modal de suspensión.
  // No expone datos de usuarios ni licitaciones.
  if (req.query.action === 'estado_publico') {
    try {
      const estadoPublico = await sql`
        SELECT estado, motivo, modal_activo
        FROM sistema_estado WHERE id = 1 LIMIT 1
      `;
      const fila = estadoPublico[0] || {};
      return res.status(200).json({
        sistema_activo:    !(fila.estado === 'SUSPENDIDO' && fila.modal_activo === true),
        motivo_suspension: fila.motivo || null
      });
    } catch (e) {
      // Si falla, devolvemos activo=true para no bloquear la landing
      return res.status(200).json({ sistema_activo: true, motivo_suspension: null });
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  const sql = neon(process.env.DATABASE_URL);

  try {
    // ========== VERIFICAR TOKEN ==========
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    const token = authHeader.split(' ')[1];
    let decoded;

    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET || 'compita-secret-2024');
    } catch (error) {
      return res.status(401).json({ success: false, error: 'Token inválido' });
    }

    // ========== OBTENER DATOS DEL USUARIO ==========
    const usuario = await sql`
      SELECT u.id, u.empresa_id, e.plan, e.trial_fin
      FROM usuarios u
      JOIN empresas e ON u.empresa_id = e.id
      WHERE u.email = ${decoded.email}
      LIMIT 1
    `;

    if (usuario.length === 0) {
      return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    }

    const { empresa_id, plan } = usuario[0];

    // ========== NUEVO: CONSULTAR ESTADO DEL SISTEMA ==========
    // Se hace junto con las oportunidades para no añadir latencia extra.
    // Si falla (tabla no existe aún, etc.) el sistema sigue funcionando normalmente.
    let sistemaSuspendido = false;
    let motivoSuspension  = null;

    try {
      const estadoSistema = await sql`
        SELECT estado, motivo, modal_activo
        FROM sistema_estado
        WHERE id = 1
        LIMIT 1
      `;

      if (estadoSistema.length > 0) {
        const { estado, motivo, modal_activo } = estadoSistema[0];
        // El modal se muestra si el estado es SUSPENDIDO y modal_activo = true
        if (estado === 'SUSPENDIDO' && modal_activo === true) {
          sistemaSuspendido = true;
          motivoSuspension  = motivo;
        }
      }
    } catch (estadoError) {
      // Si la tabla no existe o falla, no interrumpir el flujo principal
      console.warn('No se pudo consultar sistema_estado:', estadoError.message);
    }

    // ========== DETERMINAR RANGO DE FECHAS SEGÚN PLAN ==========
    const ahora = new Date();
    let diasHistorial = 30;

    if (plan === 'business' || plan === 'enterprise') {
      diasHistorial = 90;
    }

    const fechaLimite = new Date(ahora);
    fechaLimite.setDate(fechaLimite.getDate() - diasHistorial);

    // ========== OBTENER OPORTUNIDADES ==========
    const oportunidades = await sql`
      SELECT
        r.id as resultado_id,
        r.relevancia,
        r.razon,
        r.fecha_analisis,
        r.notificada,
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
        CASE r.relevancia
          WHEN 'ALTA' THEN 1
          WHEN 'MEDIA' THEN 2
          ELSE 3
        END,
        r.fecha_analisis DESC
    `;

    // ========== MARCAR OPORTUNIDADES NUEVAS ==========
    const hace48horas = new Date(ahora);
    hace48horas.setHours(hace48horas.getHours() - 48);

    const oportunidadesConMetadata = oportunidades.map(op => ({
      ...op,
      es_nuevo: new Date(op.fecha_analisis) > hace48horas
    }));

    // ========== RESPUESTA ==========
    return res.status(200).json({
      success: true,
      oportunidades: oportunidadesConMetadata,
      plan: plan,
      total: oportunidadesConMetadata.length,
      estadisticas: {
        alta:   oportunidadesConMetadata.filter(o => o.relevancia === 'ALTA').length,
        media:  oportunidadesConMetadata.filter(o => o.relevancia === 'MEDIA').length,
        nuevas: oportunidadesConMetadata.filter(o => o.es_nuevo).length
      },
      // NUEVO: señal de contingencia para el frontend
      sistema_activo:    !sistemaSuspendido,
      motivo_suspension: motivoSuspension
    });

  } catch (error) {
    console.error('Error obteniendo oportunidades:', error);
    return res.status(500).json({
      success: false,
      error: 'Error al cargar oportunidades'
    });
  }
}

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

    // Verificar que el resultado pertenece a la empresa del usuario
    const usuario = await sql`
      SELECT u.empresa_id FROM usuarios u
      WHERE u.email = ${decoded.email} LIMIT 1
    `;
    if (usuario.length === 0) {
      return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
    }

    const empresa_id = usuario[0].empresa_id;

    await sql`
      UPDATE resultados
      SET descartada = ${descartar !== false}
      WHERE id = ${resultado_id}
        AND empresa_id = ${empresa_id}
    `;

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Error al descartar:', error);
    return res.status(500).json({ success: false, error: 'Error al descartar' });
  }
}

export const config = {
  maxDuration: 10,
};