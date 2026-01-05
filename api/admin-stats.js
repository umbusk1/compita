const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'compita-admin-secret-2026';

// Verificar token de admin
function verificarAdmin(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded;
  } catch (error) {
    return null;
  }
}

module.exports = async (req, res) => {
  // Solo permitir GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    // Verificar autenticación
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    const token = authHeader.substring(7);
    const admin = verificarAdmin(token);

    if (!admin) {
      return res.status(401).json({ error: 'Token inválido' });
    }

    // 1. Total de empresas
    const totalEmpresas = await pool.query('SELECT COUNT(*) as total FROM empresas WHERE activo = true');

    // 2. Licitaciones de hoy
    const licitacionesHoy = await pool.query(
      `SELECT COUNT(*) as total, MAX(scrapeado_en) as ultimo_scraping
       FROM licitaciones 
       WHERE DATE(scrapeado_en) = CURRENT_DATE`
    );

    // 3. Total de oportunidades generadas
    const oportunidadesTotales = await pool.query('SELECT COUNT(*) as total FROM resultados');

    // 4. Emails enviados hoy (aproximado por oportunidades de hoy)
    const emailsHoy = await pool.query(
      `SELECT COUNT(DISTINCT empresa_id) as total 
       FROM resultados 
       WHERE DATE(fecha_analisis) = CURRENT_DATE`
    );

    // 5. Lista de empresas con detalles
    const empresas = await pool.query(`
      SELECT 
        e.id,
        e.nombre,
        e.dominio,
        e.plan,
        e.activo,
        e.trial_fin,
        u.email as usuario_email,
        u.nombre as usuario_nombre,
        COUNT(r.id) as oportunidades_count
      FROM empresas e
      LEFT JOIN usuarios u ON u.empresa_id = e.id
      LEFT JOIN resultados r ON r.empresa_id = e.id
      GROUP BY e.id, e.nombre, e.dominio, e.plan, e.activo, e.trial_fin, u.email, u.nombre
      ORDER BY e.id
    `);

    // 6. Lista de administradores
    const administradores = await pool.query(`
      SELECT 
        id,
        nombre,
        email,
        rol,
        activo,
        creado_en,
        ultimo_acceso
      FROM administradores
      ORDER BY rol DESC, nombre
    `);

    // 7. Estadísticas de licitaciones por día (últimos 7 días)
    const licitacionesPorDia = await pool.query(`
      SELECT 
        DATE(scrapeado_en) as fecha,
        COUNT(*) as total
      FROM licitaciones
      WHERE scrapeado_en >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY DATE(scrapeado_en)
      ORDER BY fecha DESC
    `);

    // 8. Último scraping
    const ultimoScraping = await pool.query(
      'SELECT MAX(scrapeado_en) as fecha FROM licitaciones'
    );

    // 9. Último análisis
    const ultimoAnalisis = await pool.query(
      'SELECT MAX(fecha_analisis) as fecha FROM resultados'
    );

    // Preparar respuesta
    const response = {
      // Métricas principales
      total_empresas: parseInt(totalEmpresas.rows[0].total),
      licitaciones_hoy: parseInt(licitacionesHoy.rows[0].total),
      oportunidades_totales: parseInt(oportunidadesTotales.rows[0].total),
      emails_enviados_hoy: parseInt(emailsHoy.rows[0].total),

      // Fechas importantes
      ultimo_scraping: ultimoScraping.rows[0].fecha,
      ultimo_analisis: ultimoAnalisis.rows[0].fecha,

      // Listas detalladas
      empresas: empresas.rows,
      administradores: administradores.rows,
      licitaciones_por_dia: licitacionesPorDia.rows,

      // Info del admin actual
      admin_actual: {
        id: admin.id,
        email: admin.email,
        rol: admin.rol
      }
    };

    res.json(response);

  } catch (error) {
    console.error('Error en admin-stats:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};