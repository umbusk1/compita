// api/perfil.js - Maneja datos de usuario y empresa (consolidado)
import pkg from 'pg';
const { Pool } = pkg;
import jwt from 'jsonwebtoken';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Verificar JWT Token
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

  const userId = decoded.userId;
  const empresaId = decoded.empresaId;

  // Determinar qué hacer según método y acción
  if (req.method === 'GET') {
    const { type } = req.query;

    if (type === 'usuario') {
      return handleGetUsuario(req, res, userId);
    } else if (type === 'empresa') {
      return handleGetEmpresa(req, res, empresaId);
    } else {
      return res.status(400).json({ error: 'Parámetro "type" requerido: "usuario" o "empresa"' });
    }
  } else if (req.method === 'POST') {
    return handleUpdateEmpresa(req, res, empresaId);
  } else {
    return res.status(405).json({ error: 'Método no permitido' });
  }
}

// FUNCIÓN: Obtener datos del usuario
async function handleGetUsuario(req, res, userId) {
  try {
	const result = await pool.query(
	  `SELECT u.id, u.email, u.rol, u.activo, u.email_confirmado, u.trial_fin,
			  e.id as empresa_id, e.nombre as empresa_nombre, e.plan, e.activo as empresa_activa, e.trial_fin as empresa_trial_fin
	   FROM usuarios u
	   JOIN empresas e ON u.empresa_id = e.id
	   WHERE u.id = $1`,
	  [userId]
	);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const user = result.rows[0];

	return res.status(200).json({
	  id: user.id,
	  email: user.email,
	  rol: user.rol,
	  activo: user.activo,
	  email_confirmado: user.email_confirmado,
	  trial_fin: user.trial_fin,
	  empresa: {
		id: user.empresa_id,
		nombre: user.empresa_nombre,
		plan: user.plan,
		activo: user.empresa_activa,
		trial_fin: user.empresa_trial_fin
	  }
	});

  } catch (error) {
    console.error('Error al obtener usuario:', error);
    return res.status(500).json({ error: 'Error al obtener datos del usuario' });
  }
}

// FUNCIÓN: Obtener perfil de la empresa
async function handleGetEmpresa(req, res, empresaId) {
  try {
    const result = await pool.query(
      `SELECT id, nombre, dominio, descripcion, palabras_clave, exclusiones,
              monto_minimo_alta, plan, trial_inicio, trial_fin, activo
       FROM empresas
       WHERE id = $1`,
      [empresaId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Empresa no encontrada' });
    }

    return res.status(200).json(result.rows[0]);

  } catch (error) {
    console.error('Error al obtener empresa:', error);
    return res.status(500).json({ error: 'Error al obtener datos de la empresa' });
  }
}

// FUNCIÓN: Actualizar perfil de la empresa
async function handleUpdateEmpresa(req, res, empresaId) {
  try {
    const { descripcion, palabras_clave, exclusiones, monto_minimo_alta } = req.body;

    // Validaciones básicas
    if (palabras_clave && !Array.isArray(palabras_clave)) {
      return res.status(400).json({ error: 'palabras_clave debe ser un array' });
    }

    if (exclusiones && !Array.isArray(exclusiones)) {
      return res.status(400).json({ error: 'exclusiones debe ser un array' });
    }

    if (monto_minimo_alta !== undefined && typeof monto_minimo_alta !== 'number') {
      return res.status(400).json({ error: 'monto_minimo_alta debe ser un número' });
    }

    // Actualizar en la base de datos
    const result = await pool.query(
      `UPDATE empresas
       SET descripcion = COALESCE($1, descripcion),
           palabras_clave = COALESCE($2, palabras_clave),
           exclusiones = COALESCE($3, exclusiones),
           monto_minimo_alta = COALESCE($4, monto_minimo_alta)
       WHERE id = $5
       RETURNING id, nombre, descripcion, palabras_clave, exclusiones, monto_minimo_alta`,
      [
        descripcion || null,
        palabras_clave || null,
        exclusiones || null,
        monto_minimo_alta !== undefined ? monto_minimo_alta : null,
        empresaId
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Empresa no encontrada' });
    }

    return res.status(200).json({
      message: 'Perfil actualizado exitosamente',
      empresa: result.rows[0]
    });

  } catch (error) {
    console.error('Error al actualizar empresa:', error);
    return res.status(500).json({ error: 'Error al actualizar perfil de la empresa' });
  }
}