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

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }

  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }

  const userId    = decoded.userId;
  const empresaId = decoded.empresaId;

  if (req.method === 'GET') {
    const { type } = req.query;
    if (type === 'usuario')          return handleGetUsuario(req, res, userId);
    if (type === 'empresa')          return handleGetEmpresa(req, res, empresaId);
    if (type === 'perfil_licitador') return handleGetPerfilLicitador(req, res, empresaId);
    return res.status(400).json({ error: 'Parámetro "type" requerido' });
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

  return res.status(405).json({ error: 'Método no permitido' });
}

// ── Verificar que la empresa es Enterprise ─────────────────────────────────────
async function verificarEnterprise(empresaId) {
  const r = await pool.query(
    'SELECT plan FROM empresas WHERE id = $1',
    [empresaId]
  );
  return r.rows.length > 0 && r.rows[0].plan === 'enterprise';
}

// ══════════════════════════════════════════════════════════════════════════════
// PERFIL LICITADOR — handlers
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/perfil?type=perfil_licitador
// Devuelve todos los documentos de la empresa, agrupados
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

// POST { action: 'perfil_licitador_init' }
// Inicializa los documentos predefinidos (A, B, C, D) si aún no existen
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

// POST { action: 'perfil_licitador_update', id, fecha_vencimiento, notas, archivo_url }
// Actualiza fecha de vencimiento, notas o archivo de un documento existente
async function handleUpdateDocumento(req, res, empresaId) {
  try {
    const esEnterprise = await verificarEnterprise(empresaId);
    if (!esEnterprise) return res.status(403).json({ error: 'Requiere Plan Enterprise' });

    const { id, fecha_vencimiento, notas, archivo_url } = req.body;
    if (!id) return res.status(400).json({ error: 'Campo "id" requerido' });

    const result = await pool.query(
      `UPDATE perfil_licitador
       SET fecha_vencimiento = $1,
           notas             = $2,
           archivo_url       = $3
       WHERE id = $4 AND empresa_id = $5
       RETURNING *`,
      [
        fecha_vencimiento || null,
        notas             || null,
        archivo_url       || null,
        id,
        empresaId
      ]
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

// POST { action: 'perfil_licitador_add', grupo, nombre, emisor, vigencia_estandar }
// Agrega un documento personalizado al grupo D o E
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

    // Calcular el próximo código disponible (D3, D4... E1, E2...)
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

// DELETE /api/perfil?id=123
// Elimina un documento personalizado (solo los no predefinidos)
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
// HANDLERS ORIGINALES — sin cambios
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
    if (monto_minimo_alta !== undefined && typeof monto_minimo_alta !== 'number') return res.status(400).json({ error: 'monto_minimo_alta debe ser un número' });

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