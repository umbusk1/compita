const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const resend = new Resend(process.env.RESEND_API_KEY);
const JWT_SECRET = process.env.JWT_SECRET || 'compita-jwt-secret-2026';

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
      case 'change':
        return await handleCambiar(req, res);
      case 'recover':
        return await handleRecuperar(req, res);
      case 'reset':
        return await handleResetear(req, res);
      default:
        return res.status(400).json({ error: 'Acción no especificada. Use ?action=change|recover|reset' });
    }
  } catch (error) {
    console.error('Error en password API:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// CAMBIAR PASSWORD (usuario autenticado)
async function handleCambiar(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const usuario = verificarToken(req.headers.authorization);
  if (!usuario) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { password_actual, password_nueva } = req.body;

  if (!password_actual || !password_nueva) {
    return res.status(400).json({ error: 'Contraseñas requeridas' });
  }

  if (password_nueva.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }

  // Verificar contraseña actual
  const result = await pool.query(
    'SELECT password_hash FROM usuarios WHERE id = $1',
    [usuario.id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Usuario no encontrado' });
  }

  const passwordValida = await bcrypt.compare(password_actual, result.rows[0].password_hash);

  if (!passwordValida) {
    return res.status(401).json({ error: 'Contraseña actual incorrecta' });
  }

  // Cambiar contraseña
  const nuevoHash = await bcrypt.hash(password_nueva, 10);

  await pool.query(
    'UPDATE usuarios SET password_hash = $1 WHERE id = $2',
    [nuevoHash, usuario.id]
  );

  return res.json({ 
    success: true, 
    message: 'Contraseña actualizada exitosamente' 
  });
}

// RECUPERAR PASSWORD (enviar email con token)
async function handleRecuperar(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email requerido' });
  }

  // Buscar usuario
  const result = await pool.query(
    'SELECT id, nombre FROM usuarios WHERE email = $1',
    [email.toLowerCase()]
  );

  // Siempre devolver éxito por seguridad (no revelar si el email existe)
  if (result.rows.length === 0) {
    return res.json({ 
      success: true, 
      message: 'Si el email existe, recibirás instrucciones para resetear tu contraseña' 
    });
  }

  const usuario = result.rows[0];

  // Generar token de recuperación (válido por 1 hora)
  const resetToken = jwt.sign(
    { id: usuario.id, type: 'password_reset' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  // URL de reseteo
  const resetUrl = `${process.env.VERCEL_URL || 'https://compita.umbusk.com'}/resetear-password.html?token=${resetToken}`;

  // Enviar email
  try {
    await resend.emails.send({
      from: 'Compita <notificaciones@compita.umbusk.com>',
      to: email,
      subject: 'Recuperar contraseña - Compita',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #4F46E5;">Recuperar Contraseña</h2>
          <p>Hola ${usuario.nombre},</p>
          <p>Recibimos una solicitud para resetear tu contraseña en Compita.</p>
          <p>Haz clic en el siguiente botón para crear una nueva contraseña:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" 
               style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block;">
              Resetear Contraseña
            </a>
          </div>
          <p style="color: #666; font-size: 14px;">Este enlace es válido por 1 hora.</p>
          <p style="color: #666; font-size: 14px;">Si no solicitaste este cambio, ignora este email.</p>
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;">
          <p style="color: #999; font-size: 12px;">Compita - Sistema de Análisis de Licitaciones</p>
        </div>
      `
    });
  } catch (emailError) {
    console.error('Error enviando email:', emailError);
    // No revelar el error al usuario
  }

  return res.json({ 
    success: true, 
    message: 'Si el email existe, recibirás instrucciones para resetear tu contraseña' 
  });
}

// RESETEAR PASSWORD (con token del email)
async function handleResetear(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { token, password_nueva } = req.body;

  if (!token || !password_nueva) {
    return res.status(400).json({ error: 'Token y contraseña requeridos' });
  }

  if (password_nueva.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }

  // Verificar token
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
    
    // Verificar que sea un token de reset
    if (decoded.type !== 'password_reset') {
      return res.status(401).json({ error: 'Token inválido' });
    }
  } catch (error) {
    return res.status(401).json({ error: 'Token expirado o inválido' });
  }

  // Verificar que el usuario existe
  const result = await pool.query(
    'SELECT id FROM usuarios WHERE id = $1',
    [decoded.id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Usuario no encontrado' });
  }

  // Actualizar contraseña
  const nuevoHash = await bcrypt.hash(password_nueva, 10);

  await pool.query(
    'UPDATE usuarios SET password_hash = $1 WHERE id = $2',
    [nuevoHash, decoded.id]
  );

  return res.json({ 
    success: true, 
    message: 'Contraseña actualizada exitosamente. Ya puedes iniciar sesión.' 
  });
}