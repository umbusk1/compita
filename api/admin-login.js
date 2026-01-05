const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Secret para JWT (en producción debería estar en variables de entorno)
const JWT_SECRET = process.env.JWT_SECRET || 'compita-admin-secret-2026';

module.exports = async (req, res) => {
  // Solo permitir POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    const { email, password } = req.body;

    // Validar campos
    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña son requeridos' });
    }

    // Buscar administrador
    const result = await pool.query(
      'SELECT * FROM administradores WHERE email = $1 AND activo = true',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    const admin = result.rows[0];

    // Verificar contraseña
    const passwordValido = await bcrypt.compare(password, admin.password_hash);

    if (!passwordValido) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    // Actualizar último acceso
    await pool.query(
      'UPDATE administradores SET ultimo_acceso = CURRENT_TIMESTAMP WHERE id = $1',
      [admin.id]
    );

    // Generar token JWT
    const token = jwt.sign(
      {
        id: admin.id,
        email: admin.email,
        rol: admin.rol
      },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    // Devolver token y datos básicos
    res.json({
      token,
      admin: {
        id: admin.id,
        nombre: admin.nombre,
        email: admin.email,
        rol: admin.rol
      }
    });

  } catch (error) {
    console.error('Error en admin-login:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};