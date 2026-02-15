import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'compita-admin-secret-2026';

// Verificar token
function verificarToken(authHeader) {
  try {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    const token = authHeader.substring(7);
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

// Handler principal
export default async function handler(req, res) {
  const { action } = req.query;

  try {
    switch(action) {
      case 'login':
        return await handleLogin(req, res);
      case 'stats':
        return await handleStats(req, res);
      case 'verify':
        return await handleVerify(req, res);
      case 'detalle':
        return await handleDetalle(req, res);
      case 'actualizar':
        return await handleActualizar(req, res);
      case 'resetear_cuota':
        return await handleResetearCuota(req, res);
      default:
        return res.status(400).json({ error: 'Acción no especificada' });
    }
  } catch (error) {
    console.error('Error en admin API:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// LOGIN
async function handleLogin(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña son requeridos' });
  }

  const result = await pool.query(
    'SELECT * FROM administradores WHERE email = $1 AND activo = true',
    [email.toLowerCase()]
  );

  if (result.rows.length === 0) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  const admin = result.rows[0];
  const passwordValido = await bcrypt.compare(password, admin.password_hash);

  if (!passwordValido) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  await pool.query(
    'UPDATE administradores SET ultimo_acceso = CURRENT_TIMESTAMP WHERE id = $1',
    [admin.id]
  );

  const token = jwt.sign(
    { id: admin.id, email: admin.email, rol: admin.rol },
    JWT_SECRET,
    { expiresIn: '8h' }
  );

  return res.json({
    token,
    admin: {
      id: admin.id,
      nombre: admin.nombre,
      email: admin.email,
      rol: admin.rol
    }
  });
}

// STATS
async function handleStats(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const admin = verificarToken(req.headers.authorization);
  if (!admin) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const totalEmpresas = await pool.query('SELECT COUNT(*) as total FROM empresas WHERE activo = true');
  const licitacionesHoy = await pool.query(
    `SELECT COUNT(*) as total, MAX(scrapeado_en) as ultimo_scraping
     FROM licitaciones WHERE DATE(scrapeado_en) = CURRENT_DATE`
  );
  const oportunidadesTotales = await pool.query('SELECT COUNT(*) as total FROM resultados');
  const emailsHoy = await pool.query(
    `SELECT COUNT(DISTINCT empresa_id) as total FROM resultados
     WHERE DATE(fecha_analisis) = CURRENT_DATE`
  );

  const empresas = await pool.query(`
    SELECT
      e.id, e.nombre, e.dominio, e.plan, e.activo, e.trial_fin,
      u.email as usuario_email,
      COUNT(r.id) as oportunidades_count
    FROM empresas e
    LEFT JOIN usuarios u ON u.empresa_id = e.id
    LEFT JOIN resultados r ON r.empresa_id = e.id
    GROUP BY e.id, e.nombre, e.dominio, e.plan, e.activo, e.trial_fin, u.email
    ORDER BY e.id
  `);

  const administradores = await pool.query(`
    SELECT id, nombre, email, rol, activo, creado_en, ultimo_acceso
    FROM administradores ORDER BY rol DESC, nombre
  `);

  const ultimoScraping = await pool.query('SELECT MAX(scrapeado_en) as fecha FROM licitaciones');
  const ultimoAnalisis = await pool.query('SELECT MAX(fecha_analisis) as fecha FROM resultados');

  return res.json({
    total_empresas: parseInt(totalEmpresas.rows[0].total),
    licitaciones_hoy: parseInt(licitacionesHoy.rows[0].total),
    oportunidades_totales: parseInt(oportunidadesTotales.rows[0].total),
    emails_enviados_hoy: parseInt(emailsHoy.rows[0].total),
    ultimo_scraping: ultimoScraping.rows[0].fecha,
    ultimo_analisis: ultimoAnalisis.rows[0].fecha,
    empresas: empresas.rows,
    administradores: administradores.rows,
    admin_actual: { id: admin.id, email: admin.email, rol: admin.rol }
  });
}

// VERIFY
async function handleVerify(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const decoded = verificarToken(req.headers.authorization);
  if (!decoded) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const result = await pool.query(
    'SELECT id, nombre, email, rol, activo FROM administradores WHERE id = $1',
    [decoded.id]
  );

  if (result.rows.length === 0 || !result.rows[0].activo) {
    return res.status(401).json({ error: 'Administrador no válido' });
  }

  const admin = result.rows[0];
  return res.json({
    id: admin.id,
    nombre: admin.nombre,
    email: admin.email,
    rol: admin.rol
  });
}

// DETALLE DE EMPRESA
async function handleDetalle(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const admin = verificarToken(req.headers.authorization);
  if (!admin) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { empresa_id } = req.query;

  if (!empresa_id) {
    return res.status(400).json({ error: 'empresa_id es requerido' });
  }

  // Información general de la empresa
  const empresa = await pool.query(`
    SELECT
      e.*,
      u.email as usuario_email,
      COUNT(DISTINCT r.id) as oportunidades_count
    FROM empresas e
    LEFT JOIN usuarios u ON u.empresa_id = e.id
    LEFT JOIN resultados r ON r.empresa_id = e.id
    WHERE e.id = $1
    GROUP BY e.id, u.email
  `, [empresa_id]);

  if (empresa.rows.length === 0) {
    return res.status(404).json({ error: 'Empresa no encontrada' });
  }

  const datos = empresa.rows[0];

  // Contar descargas del mes actual
  const descargasMes = await pool.query(`
    SELECT COUNT(*) as total
    FROM descargas
    WHERE empresa_id = $1
    AND DATE_TRUNC('month', descargado_en) = DATE_TRUNC('month', CURRENT_DATE)
  `, [empresa_id]);

  // Contar análisis IA del mes actual
  const analisisMes = await pool.query(`
    SELECT COUNT(*) as total
    FROM analisis_profundos
    WHERE empresa_id = $1
    AND DATE_TRUNC('month', analizado_en) = DATE_TRUNC('month', CURRENT_DATE)
  `, [empresa_id]);

  return res.json({
    id: datos.id,
    nombre: datos.nombre,
    dominio: datos.dominio,
    usuario_email: datos.usuario_email,
    plan: datos.plan,
    activo: datos.activo,
    trial_fin: datos.trial_fin,
    palabras_clave: datos.palabras_clave || [],
    palabras_exclusion: datos.palabras_exclusion || [],
    familias_unspsc: datos.familias_unspsc || [],
    usa_unspsc: datos.usa_unspsc,
    monto_minimo: datos.monto_minimo,
    oportunidades_count: parseInt(datos.oportunidades_count) || 0,
    descargas_mes: parseInt(descargasMes.rows[0].total) || 0,
    analisis_ia_mes: parseInt(analisisMes.rows[0].total) || 0
  });
}

// ACTUALIZAR EMPRESA
async function handleActualizar(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const admin = verificarToken(req.headers.authorization);
  if (!admin) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { empresa_id, plan, activo } = req.body;

  if (!empresa_id) {
    return res.status(400).json({ error: 'empresa_id es requerido' });
  }

  // Actualizar empresa
  await pool.query(`
    UPDATE empresas
    SET plan = $1, activo = $2
    WHERE id = $3
  `, [plan, activo, empresa_id]);

  console.log(`[ADMIN] Empresa ${empresa_id} actualizada: plan=${plan}, activo=${activo} por admin ${admin.email}`);

  return res.json({ success: true, mensaje: 'Empresa actualizada correctamente' });
}

// RESETEAR CUOTA
async function handleResetearCuota(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const admin = verificarToken(req.headers.authorization);
  if (!admin) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { empresa_id, tipo } = req.body;

  if (!empresa_id || !tipo) {
    return res.status(400).json({ error: 'empresa_id y tipo son requeridos' });
  }

  if (tipo === 'descargas') {
    // Eliminar todas las descargas del mes actual
    await pool.query(`
      DELETE FROM descargas
      WHERE empresa_id = $1
      AND DATE_TRUNC('month', descargado_en) = DATE_TRUNC('month', CURRENT_DATE)
    `, [empresa_id]);

    console.log(`[ADMIN] Cuota de descargas reseteada para empresa ${empresa_id} por admin ${admin.email}`);

  } else if (tipo === 'analisis') {
    // Eliminar todos los análisis profundos del mes actual
    await pool.query(`
      DELETE FROM analisis_profundos
      WHERE empresa_id = $1
      AND DATE_TRUNC('month', analizado_en) = DATE_TRUNC('month', CURRENT_DATE)
    `, [empresa_id]);

    console.log(`[ADMIN] Cuota de análisis IA reseteada para empresa ${empresa_id} por admin ${admin.email}`);

  } else {
    return res.status(400).json({ error: 'Tipo inválido. Use "descargas" o "analisis"' });
  }

  return res.json({ success: true, mensaje: `Cuota de ${tipo} reseteada correctamente` });
}