// api/perfil.js - Maneja datos de usuario, empresa y Perfil Licitador (Enterprise)
import pkg from 'pg';
const { Pool } = pkg;
import jwt from 'jsonwebtoken';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Bypass JWT para el cron de alertas
  if (req.method === 'POST') {
    const { action, secret } = req.body || {};
    if (action === 'perfil_licitador_alertas') {
      if (secret !== process.env.CRON_SECRET) {
        return res.status(401).json({ error: 'No autorizado' });
      }
      return handleEnviarAlertas(req, res);
    }
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }

  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({ error: 'Token invalido o expirado' });
  }

  const userId    = decoded.userId;
  const empresaId = decoded.empresaId;

  if (req.method === 'GET') {
    const { type } = req.query;
    if (type === 'usuario')          return handleGetUsuario(req, res, userId);
    if (type === 'empresa')          return handleGetEmpresa(req, res, empresaId);
    if (type === 'perfil_licitador') return handleGetPerfilLicitador(req, res, empresaId);
    return res.status(400).json({ error: 'Parametro "type" requerido' });
  }

  if (req.method === 'POST') {
    const { action } = req.body || {};
    if (action === 'perfil_licitador_init')   return handleInitPerfilLicitador(req, res, empresaId);
    if (action === 'perfil_licitador_update') return handleUpdateDocumento(req, res, empresaId);
    if (action === 'perfil_licitador_add')    return handleAddDocumento(req, res, empresaId);
    return handleUpdateEmpresa(req, res, empresaId, authHeader);
  }

  if (req.method === 'DELETE') {
    return handleDeleteDocumento(req, res, empresaId);
  }

  return res.status(405).json({ error: 'Metodo no permitido' });
}

// ── Verificar que la empresa es Enterprise ────────────────────────────────────
async function verificarEnterprise(empresaId) {
  const r = await pool.query(
    'SELECT plan FROM empresas WHERE id = $1',
    [empresaId]
  );
  return r.rows.length > 0 && r.rows[0].plan === 'enterprise';
}

// ══════════════════════════════════════════════════════════════════════════════
// PERFIL LICITADOR
// ══════════════════════════════════════════════════════════════════════════════

async function handleGetPerfilLicitador(req, res, empresaId) {
  try {
    const esEnterprise = await verificarEnterprise(empresaId);
    if (!esEnterprise) return res.status(403).json({ error: 'Requiere Plan Enterprise' });

    const result = await pool.query(
      `SELECT id, grupo, codigo, nombre, emisor, vigencia_estandar,
              es_permanente, fecha_vencimiento, archivo_url, notas,
              es_predefinido, orden
       FROM perfil_licitador
       WHERE empresa_id = $1
       ORDER BY grupo ASC, orden ASC, id ASC`,
      [empresaId]
    );
    return res.status(200).json({ documentos: result.rows });
  } catch (error) {
    console.error('Error al obtener perfil licitador:', error);
    return res.status(500).json({ error: 'Error al obtener perfil licitador' });
  }
}

async function handleInitPerfilLicitador(req, res, empresaId) {
  try {
    const esEnterprise = await verificarEnterprise(empresaId);
    if (!esEnterprise) return res.status(403).json({ error: 'Requiere Plan Enterprise' });

    await pool.query('SELECT inicializar_perfil_licitador($1)', [empresaId]);
    return res.status(200).json({ message: 'Perfil Licitador inicializado correctamente' });
  } catch (error) {
    console.error('Error al inicializar perfil licitador:', error);
    return res.status(500).json({ error: 'Error al inicializar perfil licitador' });
  }
}

async function handleUpdateDocumento(req, res, empresaId) {
  try {
    const esEnterprise = await verificarEnterprise(empresaId);
    if (!esEnterprise) return res.status(403).json({ error: 'Requiere Plan Enterprise' });

    const { id, fecha_vencimiento, notas, archivo_url } = req.body;
    if (!id) return res.status(400).json({ error: 'Campo "id" requerido' });

    const result = await pool.query(
      `UPDATE perfil_licitador
       SET fecha_vencimiento  = $1,
           notas              = $2,
           archivo_url        = $3,
           ultima_alerta_dias = NULL
       WHERE id = $4 AND empresa_id = $5
       RETURNING *`,
      [fecha_vencimiento || null, notas || null, archivo_url || null, id, empresaId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Documento no encontrado' });
    }
    return res.status(200).json({ documento: result.rows[0] });
  } catch (error) {
    console.error('Error al actualizar documento:', error);
    return res.status(500).json({ error: 'Error al actualizar documento' });
  }
}

async function handleAddDocumento(req, res, empresaId) {
  try {
    const esEnterprise = await verificarEnterprise(empresaId);
    if (!esEnterprise) return res.status(403).json({ error: 'Requiere Plan Enterprise' });

    const { grupo, nombre, emisor, vigencia_estandar } = req.body;

    if (!grupo || !['D','E'].includes(grupo)) {
      return res.status(400).json({ error: 'Solo se pueden agregar documentos a los grupos D o E' });
    }
    if (!nombre || nombre.trim() === '') {
      return res.status(400).json({ error: 'El nombre del documento es requerido' });
    }

    const existentes = await pool.query(
      `SELECT codigo FROM perfil_licitador
       WHERE empresa_id = $1 AND grupo = $2
       ORDER BY orden DESC LIMIT 1`,
      [empresaId, grupo]
    );
    const ultimoOrden = existentes.rows.length > 0
      ? parseInt(existentes.rows[0].codigo.slice(1)) + 1
      : 1;
    const nuevoCodigo = `${grupo}${ultimoOrden}`;

    const result = await pool.query(
      `INSERT INTO perfil_licitador
         (empresa_id, grupo, codigo, nombre, emisor, vigencia_estandar, es_predefinido, orden)
       VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7)
       RETURNING *`,
      [empresaId, grupo, nuevoCodigo, nombre.trim(), emisor || '', vigencia_estandar || '', ultimoOrden]
    );
    return res.status(201).json({ documento: result.rows[0] });
  } catch (error) {
    console.error('Error al agregar documento:', error);
    return res.status(500).json({ error: 'Error al agregar documento' });
  }
}

async function handleDeleteDocumento(req, res, empresaId) {
  try {
    const esEnterprise = await verificarEnterprise(empresaId);
    if (!esEnterprise) return res.status(403).json({ error: 'Requiere Plan Enterprise' });

    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Campo "id" requerido' });

    const result = await pool.query(
      `DELETE FROM perfil_licitador
       WHERE id = $1 AND empresa_id = $2 AND es_predefinido = FALSE
       RETURNING id`,
      [id, empresaId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Documento no encontrado o no se puede eliminar' });
    }
    return res.status(200).json({ message: 'Documento eliminado correctamente' });
  } catch (error) {
    console.error('Error al eliminar documento:', error);
    return res.status(500).json({ error: 'Error al eliminar documento' });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// HANDLERS ORIGINALES
// ══════════════════════════════════════════════════════════════════════════════

async function handleGetUsuario(req, res, userId) {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.rol, u.activo, u.email_confirmado, u.trial_fin,
              e.id as empresa_id, e.nombre as empresa_nombre, e.plan,
              e.activo as empresa_activa, e.trial_fin as empresa_trial_fin
       FROM usuarios u
       JOIN empresas e ON u.empresa_id = e.id
       WHERE u.id = $1`,
      [userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const u = result.rows[0];
    return res.status(200).json({
      id: u.id, email: u.email, rol: u.rol,
      activo: u.activo, email_confirmado: u.email_confirmado, trial_fin: u.trial_fin,
      empresa: {
        id: u.empresa_id, nombre: u.empresa_nombre, plan: u.plan,
        activo: u.empresa_activa, trial_fin: u.empresa_trial_fin
      }
    });
  } catch (error) {
    console.error('Error al obtener usuario:', error);
    return res.status(500).json({ error: 'Error al obtener datos del usuario' });
  }
}

async function handleGetEmpresa(req, res, empresaId) {
  try {
    const result = await pool.query(
      `SELECT id, nombre, dominio, descripcion, palabras_clave, exclusiones,
              monto_minimo_alta, plan, trial_inicio, trial_fin, activo,
              sector_principal, sectores_adicionales,
              regiones_interes, onboarding_completado, website
       FROM empresas
       WHERE id = $1`,
      [empresaId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Empresa no encontrada' });
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error al obtener empresa:', error);
    return res.status(500).json({ error: 'Error al obtener datos de la empresa' });
  }
}

async function handleUpdateEmpresa(req, res, empresaId, authHeader) {
  try {
    const {
      descripcion, palabras_clave, exclusiones, monto_minimo_alta,
      sector_principal, sectores_adicionales, regiones_interes,
      onboarding_completado, website
    } = req.body;

    if (palabras_clave       && !Array.isArray(palabras_clave))       return res.status(400).json({ error: 'palabras_clave debe ser un array' });
    if (exclusiones          && !Array.isArray(exclusiones))          return res.status(400).json({ error: 'exclusiones debe ser un array' });
    if (sectores_adicionales && !Array.isArray(sectores_adicionales)) return res.status(400).json({ error: 'sectores_adicionales debe ser un array' });
    if (regiones_interes     && !Array.isArray(regiones_interes))     return res.status(400).json({ error: 'regiones_interes debe ser un array' });
    if (monto_minimo_alta !== undefined && typeof monto_minimo_alta !== 'number') return res.status(400).json({ error: 'monto_minimo_alta debe ser un numero' });

    const result = await pool.query(
      `UPDATE empresas
       SET descripcion           = COALESCE($1,  descripcion),
           palabras_clave        = COALESCE($2,  palabras_clave),
           exclusiones           = COALESCE($3,  exclusiones),
           monto_minimo_alta     = COALESCE($4,  monto_minimo_alta),
           sector_principal      = COALESCE($5,  sector_principal),
           sectores_adicionales  = COALESCE($6,  sectores_adicionales),
           regiones_interes      = COALESCE($7,  regiones_interes),
           onboarding_completado = COALESCE($8,  onboarding_completado),
           website               = COALESCE($9,  website)
       WHERE id = $10
       RETURNING id, nombre, descripcion, palabras_clave, exclusiones,
                 monto_minimo_alta, sector_principal, sectores_adicionales,
                 regiones_interes, onboarding_completado, website`,
      [
        descripcion           ?? null,
        palabras_clave        ?? null,
        exclusiones           ?? null,
        monto_minimo_alta     !== undefined ? monto_minimo_alta : null,
        sector_principal      ?? null,
        sectores_adicionales  ?? null,
        regiones_interes      ?? null,
        onboarding_completado !== undefined ? onboarding_completado : null,
        website               ?? null,
        empresaId
      ]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Empresa no encontrada' });

    return res.status(200).json({
      message: 'Perfil actualizado exitosamente',
      empresa: result.rows[0]
    });
  } catch (error) {
    console.error('Error al actualizar empresa:', error);
    return res.status(500).json({ error: 'Error al actualizar perfil de la empresa' });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ALERTAS PERFIL LICITADOR (llamado por cron, sin JWT)
// ══════════════════════════════════════════════════════════════════════════════

async function handleEnviarAlertas(req, res) {
  try {
    const { rows } = await pool.query(`
      SELECT
        pl.id, pl.empresa_id, pl.codigo, pl.nombre, pl.emisor,
        pl.fecha_vencimiento, pl.ultima_alerta_dias, pl.vigencia_estandar,
        e.nombre  AS empresa_nombre,
        u.email   AS admin_email
      FROM perfil_licitador pl
      JOIN empresas e ON e.id = pl.empresa_id
      JOIN usuarios u ON u.empresa_id = e.id AND u.rol = 'admin'
      WHERE e.plan           = 'enterprise'
        AND e.activo         = TRUE
        AND pl.es_permanente = FALSE
        AND pl.fecha_vencimiento IS NOT NULL
        AND pl.fecha_vencimiento >= CURRENT_DATE
        AND pl.fecha_vencimiento <= CURRENT_DATE + INTERVAL '30 days'
      ORDER BY pl.empresa_id, pl.fecha_vencimiento ASC
    `);

    const hoy = new Date(); hoy.setHours(0,0,0,0);
    const grupos = {};

    for (const doc of rows) {
      const diffDias = Math.round((new Date(doc.fecha_vencimiento) - hoy) / 86400000);
      const skip30   = doc.vigencia_estandar === '30 dias';

      let threshold = null;
      if      (diffDias <= 5  && (!doc.ultima_alerta_dias || doc.ultima_alerta_dias > 5))  threshold = 5;
      else if (diffDias <= 15 && (!doc.ultima_alerta_dias || doc.ultima_alerta_dias > 15)) threshold = 15;
      else if (diffDias <= 30 && !skip30 && !doc.ultima_alerta_dias)                       threshold = 30;

      if (!threshold) continue;

      const key = `${doc.empresa_id}-${threshold}`;
      if (!grupos[key]) grupos[key] = {
        empresa_id: doc.empresa_id, empresa_nombre: doc.empresa_nombre,
        admin_email: doc.admin_email, threshold, docs: []
      };
      grupos[key].docs.push({ ...doc, diff_dias: diffDias });
    }

    let enviados = 0;
    for (const g of Object.values(grupos)) {
      await enviarEmailAlerta(g);
      for (const doc of g.docs) {
        await pool.query(
          `UPDATE perfil_licitador
           SET ultima_alerta_dias = $1, updated_at = NOW()
           WHERE id = $2`,
          [g.threshold, doc.id]
        );
      }
      enviados++;
    }

    return res.status(200).json({
      message: `Alertas procesadas: ${enviados} email(s) enviado(s)`,
      grupos_procesados: enviados
    });
  } catch (error) {
    console.error('Error procesando alertas Perfil Licitador:', error);
    return res.status(500).json({ error: 'Error al procesar alertas' });
  }
}

async function enviarEmailAlerta({ empresa_nombre, admin_email, threshold, docs }) {
  const nivel = threshold === 5  ? { emoji: '🔴', label: 'URGENTE'    }
              : threshold === 15 ? { emoji: '🟡', label: 'ATENCION'   }
              :                    { emoji: '🟢', label: 'PREVENTIVO' };

  const filas = docs.map(d => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0">
        <strong style="font-size:11px;color:#6b7280">${d.codigo}</strong>
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:13px">${d.nombre}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#9ca3af">${d.emisor}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-weight:700;font-size:13px;
                 color:${threshold<=5?'#dc2626':threshold<=15?'#d97706':'#059669'}">
        ${d.diff_dias} dia${d.diff_dias!==1?'s':''}
      </td>
    </tr>`).join('');

  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;background:#f9fafb;padding:24px">
  <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:20px 24px;border-radius:12px 12px 0 0;text-align:center">
    <p style="color:white;font-size:20px;font-weight:700;margin:0">Compita</p>
    <p style="color:#c7d2fe;font-size:12px;margin:4px 0 0">Perfil Licitador - Alerta de Vencimiento</p>
  </div>
  <div style="background:#fff;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px">
    <p style="margin:0 0 4px;font-size:13px;color:#6b7280">${nivel.emoji} Alerta ${nivel.label}</p>
    <h2 style="margin:0 0 4px;font-size:18px">Documentos por vencer en &le;${threshold} dias</h2>
    <p style="color:#6b7280;font-size:13px;margin:0 0 20px">${empresa_nombre}</p>
    <table style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:8px;overflow:hidden">
      <thead><tr style="background:#f3f4f6">
        <th style="padding:8px 12px;text-align:left;font-size:10px;color:#9ca3af;text-transform:uppercase">Cod.</th>
        <th style="padding:8px 12px;text-align:left;font-size:10px;color:#9ca3af;text-transform:uppercase">Documento</th>
        <th style="padding:8px 12px;text-align:left;font-size:10px;color:#9ca3af;text-transform:uppercase">Emisor</th>
        <th style="padding:8px 12px;text-align:left;font-size:10px;color:#9ca3af;text-transform:uppercase">Dias restantes</th>
      </tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <div style="margin-top:24px;text-align:center">
      <a href="https://compita.umbusk.com/cuenta.html"
         style="background:linear-gradient(135deg,#4f46e5,#7c3aed);color:white;padding:12px 28px;
                border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px;display:inline-block">
        Actualizar Perfil Licitador &rarr;
      </a>
    </div>
    <p style="margin-top:24px;font-size:11px;color:#d1d5db;text-align:center">
      Mensaje automatico de Compita - Umbusk LLC
    </p>
  </div>
</body></html>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
    },
    body: JSON.stringify({
      from:    'Compita Alertas <alertas@compita.umbusk.com>',
      to:      [admin_email],
      subject: `${nivel.emoji} ${nivel.label} - Documentos por vencer | ${empresa_nombre}`,
      html
    })
  });
  if (!r.ok) console.error('Resend error:', await r.json());
}