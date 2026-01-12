// api/password.js - Gestión de contraseñas (usuarios y admin)
import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Método no permitido'
    });
  }

  const sql = neon(process.env.DATABASE_URL);
  const { action } = req.query;

  try {
    // ========== CAMBIAR CONTRASEÑA (Usuario normal) ==========
    if (action === 'change') {
      return await cambiarPasswordUsuario(req, res, sql);
    }

    // ========== SOLICITAR RESET USUARIO ==========
    if (action === 'request-reset-user') {
      return await solicitarResetUsuario(req, res, sql);
    }

    // ========== CONFIRMAR RESET USUARIO ==========
    if (action === 'confirm-reset-user') {
      return await confirmarResetUsuario(req, res, sql);
    }

    // ========== SOLICITAR RESET ADMIN ==========
    if (action === 'request-reset-admin') {
      return await solicitarResetAdmin(req, res, sql);
    }

    // ========== CONFIRMAR RESET ADMIN ==========
    if (action === 'confirm-reset-admin') {
      return await confirmarResetAdmin(req, res, sql);
    }

    return res.status(400).json({
      success: false,
      error: 'Acción no válida'
    });

  } catch (error) {
    console.error('Error en password API:', error);
    return res.status(500).json({
      success: false,
      error: 'Error al procesar solicitud'
    });
  }
}

// ============================================================================
// CAMBIAR CONTRASEÑA (Usuario normal)
// ============================================================================
async function cambiarPasswordUsuario(req, res, sql) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'No autorizado'
    });
  }

  const token = authHeader.split(' ')[1];
  let decoded;

  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET || 'compita-secret-2024');
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: 'Token inválido'
    });
  }

  const { password_actual, password_nueva } = req.body;

  if (!password_actual || !password_nueva) {
    return res.status(400).json({
      success: false,
      error: 'Contraseñas requeridas'
    });
  }

  if (password_nueva.length < 8) {
    return res.status(400).json({
      success: false,
      error: 'La nueva contraseña debe tener al menos 8 caracteres'
    });
  }

  const usuario = await sql`
    SELECT id, password_hash FROM usuarios WHERE email = ${decoded.email}
  `;

  if (usuario.length === 0) {
    return res.status(404).json({
      success: false,
      error: 'Usuario no encontrado'
    });
  }

  const passwordValido = await bcrypt.compare(password_actual, usuario[0].password_hash);
  if (!passwordValido) {
    return res.status(401).json({
      success: false,
      error: 'Contraseña actual incorrecta'
    });
  }

  const salt = await bcrypt.genSalt(10);
  const nuevoHash = await bcrypt.hash(password_nueva, salt);

  await sql`
    UPDATE usuarios
    SET password_hash = ${nuevoHash}
    WHERE id = ${usuario[0].id}
  `;

  return res.status(200).json({
    success: true,
    mensaje: 'Contraseña actualizada correctamente'
  });
}

// ============================================================================
// SOLICITAR RESET USUARIO
// ============================================================================
async function solicitarResetUsuario(req, res, sql) {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({
      success: false,
      error: 'Email requerido'
    });
  }

  const usuario = await sql`
    SELECT u.id, u.email, e.nombre as empresa_nombre
    FROM usuarios u
    JOIN empresas e ON u.empresa_id = e.id
    WHERE u.email = ${email.toLowerCase()}
  `;

  // Por seguridad, siempre devolvemos success incluso si el email no existe
  if (usuario.length === 0) {
    return res.status(200).json({
      success: true,
      mensaje: 'Si el email existe, recibirás un link de recuperación'
    });
  }

  const userData = usuario[0];

  // Generar token de reset con expiración de 1 hora
  const resetToken = jwt.sign(
    {
      user_id: userData.id,
      email: userData.email,
      tipo: 'reset_user'
    },
    process.env.JWT_SECRET || 'compita-secret-2024',
    { expiresIn: '1h' }
  );

  // Enviar email con link de reset
  const resetUrl = `https://${req.headers.host}/confirmar-reset.html?token=${resetToken}`;

  try {
    await resend.emails.send({
      from: 'Compita <notificaciones@compita.umbusk.com>',
      to: userData.email,
      subject: '🔐 Recuperar Contraseña - Compita',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: white; padding: 30px; border: 1px solid #e0e0e0; }
            .button { display: inline-block; background: #667eea; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: bold; }
            .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
            .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🔐 Recuperar Contraseña</h1>
            </div>
            <div class="content">
              <h2>Hola,</h2>
              <p>Recibimos una solicitud para restablecer la contraseña de tu cuenta de <strong>${userData.empresa_nombre}</strong> en Compita.</p>

              <p>Haz clic en el botón para crear una nueva contraseña:</p>

              <center>
                <a href="${resetUrl}" class="button">Restablecer Contraseña</a>
              </center>

              <p>Si el botón no funciona, copia y pega este link en tu navegador:</p>
              <p style="background: #f5f5f5; padding: 10px; word-break: break-all; font-size: 12px;">
                ${resetUrl}
              </p>

              <div class="warning">
                <strong>⚠️ Importante:</strong>
                <ul style="margin: 10px 0; padding-left: 20px;">
                  <li>Este link expira en <strong>1 hora</strong></li>
                  <li>Solo puede ser usado una vez</li>
                  <li>Si no solicitaste este cambio, ignora este email</li>
                </ul>
              </div>
            </div>
            <div class="footer">
              <p>Este email fue enviado por Compita</p>
              <p>Si no solicitaste este cambio, tu cuenta está segura</p>
            </div>
          </div>
        </body>
        </html>
      `
    });

    console.log(`✉️ Email de reset enviado a: ${userData.email}`);

  } catch (emailError) {
    console.error('Error enviando email:', emailError);
    // No revelamos que hubo error para evitar enumerar emails válidos
  }

  return res.status(200).json({
    success: true,
    mensaje: 'Si el email existe, recibirás un link de recuperación'
  });
}

// ============================================================================
// CONFIRMAR RESET USUARIO
// ============================================================================
async function confirmarResetUsuario(req, res, sql) {
  const { token, nueva_password } = req.body;

  if (!token || !nueva_password) {
    return res.status(400).json({
      success: false,
      error: 'Token y contraseña requeridos'
    });
  }

  if (nueva_password.length < 8) {
    return res.status(400).json({
      success: false,
      error: 'La contraseña debe tener al menos 8 caracteres'
    });
  }

  // Verificar token
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET || 'compita-secret-2024');
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: 'Token inválido o expirado'
    });
  }

  // Verificar que sea un token de reset de usuario
  if (decoded.tipo !== 'reset_user') {
    return res.status(401).json({
      success: false,
      error: 'Token no válido para esta operación'
    });
  }

  // Verificar que el usuario existe
  const usuario = await sql`
    SELECT id, email
    FROM usuarios
    WHERE id = ${decoded.user_id} AND email = ${decoded.email}
  `;

  if (usuario.length === 0) {
    return res.status(404).json({
      success: false,
      error: 'Usuario no encontrado'
    });
  }

  // Generar nuevo hash
  const salt = await bcrypt.genSalt(10);
  const nuevoHash = await bcrypt.hash(nueva_password, salt);

  // Actualizar contraseña
  await sql`
    UPDATE usuarios
    SET password_hash = ${nuevoHash}
    WHERE id = ${decoded.user_id}
  `;

  console.log(`✅ Contraseña de usuario actualizada: ${usuario[0].email}`);

  return res.status(200).json({
    success: true,
    mensaje: 'Contraseña actualizada correctamente'
  });
}

// ============================================================================
// SOLICITAR RESET ADMIN
// ============================================================================
async function solicitarResetAdmin(req, res, sql) {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({
      success: false,
      error: 'Email requerido'
    });
  }

  const admin = await sql`
    SELECT id, nombre, email, activo
    FROM administradores
    WHERE email = ${email.toLowerCase()}
  `;

  // Por seguridad, siempre devolvemos success incluso si el email no existe
  if (admin.length === 0 || !admin[0].activo) {
    return res.status(200).json({
      success: true,
      mensaje: 'Si el email existe, recibirás un link de recuperación'
    });
  }

  const adminData = admin[0];

  // Generar token de reset con expiración de 1 hora
  const resetToken = jwt.sign(
    {
      admin_id: adminData.id,
      email: adminData.email,
      tipo: 'reset_admin'
    },
    process.env.JWT_SECRET || 'compita-secret-2024',
    { expiresIn: '1h' }
  );

  // Enviar email con link de reset
  const resetUrl = `https://${req.headers.host}/confirmar-reset-admin.html?token=${resetToken}`;

  try {
    await resend.emails.send({
      from: 'Compita Admin <notificaciones@compita.umbusk.com>',
      to: adminData.email,
      subject: '🔐 Recuperar Contraseña - Admin Compita',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: white; padding: 30px; border: 1px solid #e0e0e0; }
            .button { display: inline-block; background: #667eea; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: bold; }
            .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
            .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🔐 Recuperar Contraseña</h1>
            </div>
            <div class="content">
              <h2>Hola ${adminData.nombre},</h2>
              <p>Recibimos una solicitud para restablecer la contraseña de tu cuenta de administrador en Compita.</p>

              <p>Haz clic en el botón para crear una nueva contraseña:</p>

              <center>
                <a href="${resetUrl}" class="button">Restablecer Contraseña</a>
              </center>

              <p>Si el botón no funciona, copia y pega este link en tu navegador:</p>
              <p style="background: #f5f5f5; padding: 10px; word-break: break-all; font-size: 12px;">
                ${resetUrl}
              </p>

              <div class="warning">
                <strong>⚠️ Importante:</strong>
                <ul style="margin: 10px 0; padding-left: 20px;">
                  <li>Este link expira en <strong>1 hora</strong></li>
                  <li>Solo puede ser usado una vez</li>
                  <li>Si no solicitaste este cambio, ignora este email</li>
                </ul>
              </div>
            </div>
            <div class="footer">
              <p>Este email fue enviado por Compita Admin Panel</p>
              <p>Si no solicitaste este cambio, tu cuenta está segura</p>
            </div>
          </div>
        </body>
        </html>
      `
    });

    console.log(`✉️ Email de reset enviado a: ${adminData.email}`);

  } catch (emailError) {
    console.error('Error enviando email:', emailError);
    // No revelamos que hubo error para evitar enumerar emails válidos
  }

  return res.status(200).json({
    success: true,
    mensaje: 'Si el email existe, recibirás un link de recuperación'
  });
}

// ============================================================================
// CONFIRMAR RESET ADMIN
// ============================================================================
async function confirmarResetAdmin(req, res, sql) {
  const { token, nueva_password } = req.body;

  if (!token || !nueva_password) {
    return res.status(400).json({
      success: false,
      error: 'Token y contraseña requeridos'
    });
  }

  if (nueva_password.length < 8) {
    return res.status(400).json({
      success: false,
      error: 'La contraseña debe tener al menos 8 caracteres'
    });
  }

  // Verificar token
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET || 'compita-secret-2024');
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: 'Token inválido o expirado'
    });
  }

  // Verificar que sea un token de reset de admin
  if (decoded.tipo !== 'reset_admin') {
    return res.status(401).json({
      success: false,
      error: 'Token no válido para esta operación'
    });
  }

  // Verificar que el admin existe y está activo
  const admin = await sql`
    SELECT id, email, activo
    FROM administradores
    WHERE id = ${decoded.admin_id} AND email = ${decoded.email}
  `;

  if (admin.length === 0 || !admin[0].activo) {
    return res.status(404).json({
      success: false,
      error: 'Administrador no encontrado'
    });
  }

  // Generar nuevo hash
  const salt = await bcrypt.genSalt(10);
  const nuevoHash = await bcrypt.hash(nueva_password, salt);

  // Actualizar contraseña
  await sql`
    UPDATE administradores
    SET password_hash = ${nuevoHash}
    WHERE id = ${decoded.admin_id}
  `;

  console.log(`✅ Contraseña de admin actualizada: ${admin[0].email}`);

  return res.status(200).json({
    success: true,
    mensaje: 'Contraseña actualizada correctamente'
  });
}

export const config = {
  maxDuration: 10,
};