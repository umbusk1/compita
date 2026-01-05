const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'compita-admin-secret-2026';

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET);

    // Verificar que el admin sigue activo
    const result = await pool.query(
      'SELECT id, nombre, email, rol, activo FROM administradores WHERE id = $1',
      [decoded.id]
    );

    if (result.rows.length === 0 || !result.rows[0].activo) {
      return res.status(401).json({ error: 'Administrador no válido' });
    }

    const admin = result.rows[0];
    res.json({
      id: admin.id,
      nombre: admin.nombre,
      email: admin.email,
      rol: admin.rol
    });

  } catch (error) {
    console.error('Error en admin-verify:', error);
    res.status(401).json({ error: 'Token inválido' });
  }
};