const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

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
module.exports = async (req, res) => {
  const { action } = req.query;

  try {
    switch(action) {
      case 'login':
        return await handleLogin(req, res);
      case 'stats':
        return await handleStats(req, res);
      case 'verify':
        return await handleVerify(req, res);
      default:
        return res.status(400).json({ error: 'Acción no especificada. Use ?action=login|stats|verify' });
    }
  } catch (error) {
    console.error('Error en admin API:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

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