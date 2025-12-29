// api/recuperar-password.js - Enviar email de recuperación
import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email es requerido'
      });
    }

    // Buscar usuario
    const usuarios = await sql`
      SELECT id, email, empresa, activo
      FROM usuarios
      WHERE email = ${email.toLowerCase()}
    `;

    // Por seguridad, siempre decimos que enviamos el email
    // aunque el usuario no exista (evita enumerar usuarios)
    if (usuarios.length === 0) {
      return res.status(200).json({
        success: true,
        mensaje: 'Si el email existe, recibirás un link de recuperación'
      });
    }

    const usuario = usuarios[0];

    if (!usuario.activo) {
      return res.status(200).json({
        success: true,
        mensaje: 'Si el email existe, recibirás un link de recuperación'
      });
    }

    // Generar token de recuperación (válido por 1 hora)
    const tokenRecuperacion = jwt.sign(
      {
        id: usuario.id,
        email: usuario.email,
        tipo: 'recuperacion'
      },
      process.env.JWT_SECRET || 'compita-secret-2024',
      { expiresIn: '1h' }
    );

    // Guardar token en la base de datos
    await sql`
      UPDATE usuarios
      SET
        token_confirmacion = ${tokenRecuperacion},
        updated_at = NOW()
      WHERE id = ${usuario.id}
    `;

    // URL para resetear contraseña
    const resetUrl = `https://${req.headers.host}/resetear-password.html?token=${tokenRecuperacion}`;

    // Enviar email
    await resend.emails.send({
      from: 'Compita <notificaciones@compita.umbusk.com>',
      to: usuario.email,
      subject: 'Recupera tu contraseña - Compita',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: white; padding: 30px; border: 1px solid #e0e0e0; border-top: none; }
            .button { display: inline-block; background: #667eea; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: bold; }
            .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
            .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🎯 Compita</h1>
              <p>Recuperación de contraseña</p>
            </div>
            <div class="content">
              <h2>Hola,</h2>
              <p>Recibimos una solicitud para recuperar tu contraseña de <strong>${usuario.empresa}</strong>.</p>

              <p>Haz clic en el siguiente botón para crear una nueva contraseña:</p>

              <center>
                <a href="${resetUrl}" class="button">Crear Nueva Contraseña</a>
              </center>

              <div class="warning">
                <strong>⚠️ Importante:</strong>
                <ul>
                  <li>Este link expira en 1 hora</li>
                  <li>Si no solicitaste este cambio, ignora este email</li>
                  <li>Tu contraseña actual seguirá siendo válida</li>
                </ul>
              </div>

              <p>Si el botón no funciona, copia y pega este link en tu navegador:</p>
              <p style="background: #f5f5f5; padding: 10px; word-break: break-all; font-size: 12px;">
                ${resetUrl}
              </p>
            </div>
            <div class="footer">
              <p>Este email fue enviado por Compita</p>
              <p>Si tienes problemas, contacta a soporte</p>
            </div>
          </div>
        </body>
        </html>
      `
    });

    return res.status(200).json({
      success: true,
      mensaje: 'Si el email existe, recibirás un link de recuperación'
    });

  } catch (error) {
    console.error('Error en recuperación:', error);
    return res.status(500).json({
      success: false,
      error: 'Error al procesar solicitud'
    });
  }
}

export const config = {
  maxDuration: 10,
};