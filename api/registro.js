// api/registro.js - Registro con creación automática de empresa
import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
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
    const { email, empresa, password } = req.body;

    // ========== VALIDACIONES ==========

    if (!email || !empresa || !password) {
      return res.status(400).json({
        success: false,
        error: 'Todos los campos son requeridos'
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        error: 'Email inválido'
      });
    }

    const dominiosGratuitos = [
      'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
      'live.com', 'icloud.com', 'protonmail.com', 'aol.com',
      'mail.com', 'zoho.com', 'yandex.com', 'gmx.com'
    ];

    const dominio = email.split('@')[1]?.toLowerCase();
    if (dominiosGratuitos.includes(dominio)) {
      return res.status(400).json({
        success: false,
        error: `No se permiten emails de ${dominio}. Por favor usa tu email corporativo.`
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'La contraseña debe tener al menos 8 caracteres'
      });
    }

    if (empresa.trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: 'El nombre de la empresa debe tener al menos 2 caracteres'
      });
    }

    // ========== VERIFICAR SI EL EMAIL YA EXISTE ==========

    const usuarioExistente = await sql`
      SELECT id FROM usuarios WHERE email = ${email.toLowerCase()}
    `;

    if (usuarioExistente.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'Este email ya está registrado'
      });
    }

    // ========== EXTRAER DOMINIO DEL EMAIL ==========

    const dominioEmpresa = email.split('@')[1]?.toLowerCase();

    // ========== CALCULAR FECHAS DEL TRIAL ==========

    const ahora = new Date();
    const trialFin = new Date(ahora);
    trialFin.setDate(trialFin.getDate() + 7);

    // ========== CREAR EMPRESA ==========

    const empresaResult = await sql`
      INSERT INTO empresas (
        nombre,
        dominio,
        plan,
        trial_inicio,
        trial_fin,
        activo
      )
      VALUES (
        ${empresa.trim()},
        ${dominioEmpresa},
        'free_trial',
        ${ahora.toISOString()},
        ${trialFin.toISOString()},
        true
      )
      RETURNING id, nombre, dominio, trial_fin
    `;

    const nuevaEmpresa = empresaResult[0];

    // ========== HASHEAR CONTRASEÑA ==========

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // ========== GENERAR TOKEN DE CONFIRMACIÓN ==========

    const tokenConfirmacion = jwt.sign(
      { email: email.toLowerCase() },
      process.env.JWT_SECRET || 'compita-secret-2024',
      { expiresIn: '7d' }
    );

    // ========== CREAR USUARIO ==========

    const resultado = await sql`
      INSERT INTO usuarios (
        email,
        empresa,
        password_hash,
        token_confirmacion,
        trial_inicio,
        trial_fin,
        email_confirmado,
        activo,
        empresa_id,
        rol
      )
      VALUES (
        ${email.toLowerCase()},
        ${empresa.trim()},
        ${passwordHash},
        ${tokenConfirmacion},
        ${ahora.toISOString()},
        ${trialFin.toISOString()},
        false,
        true,
        ${nuevaEmpresa.id},
        'owner'
      )
      RETURNING id, email, empresa, empresa_id, trial_fin, created_at
    `;

    const nuevoUsuario = resultado[0];

    // ========== ENVIAR EMAIL DE CONFIRMACIÓN ==========

    const confirmUrl = `https://${req.headers.host}/confirmar-email.html?token=${tokenConfirmacion}`;

    try {
      await resend.emails.send({
        from: 'Compita <notificaciones@compita.umbusk.com>',
        to: nuevoUsuario.email,
        subject: 'Confirma tu cuenta - Compita 🎯',
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
              .highlight { background: #f0f4ff; padding: 15px; border-radius: 5px; margin: 20px 0; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>🎯 Bienvenido a Compita</h1>
              </div>
              <div class="content">
                <h2>¡Hola ${nuevoUsuario.empresa}!</h2>
                <p>Gracias por registrarte en Compita. Estás a un paso de comenzar a analizar licitaciones con inteligencia artificial.</p>

                <div class="highlight">
                  <strong>✅ Tu cuenta está lista</strong><br>
                  <strong>📧 Email:</strong> ${nuevoUsuario.email}<br>
                  <strong>🎁 Trial:</strong> 7 días gratis
                </div>

                <p>Para activar tu cuenta, confirma tu email haciendo clic en el botón:</p>

                <center>
                  <a href="${confirmUrl}" class="button">Confirmar mi Email</a>
                </center>

                <p>Si el botón no funciona, copia y pega este link en tu navegador:</p>
                <p style="background: #f5f5f5; padding: 10px; word-break: break-all; font-size: 12px;">
                  ${confirmUrl}
                </p>

                <p><small>Este link expira en 7 días.</small></p>
              </div>
              <div class="footer">
                <p>Este email fue enviado por Compita</p>
                <p>Si no creaste esta cuenta, ignora este mensaje</p>
              </div>
            </div>
          </body>
          </html>
        `
      });
    } catch (emailError) {
      console.error('Error enviando email:', emailError);
    }

    // ========== RESPUESTA EXITOSA ==========

    return res.status(201).json({
      success: true,
      mensaje: 'Usuario registrado exitosamente',
      usuario: {
        id: nuevoUsuario.id,
        email: nuevoUsuario.email,
        empresa: nuevoUsuario.empresa,
        empresa_id: nuevoUsuario.empresa_id,
        trial_fin: nuevoUsuario.trial_fin
      }
    });

  } catch (error) {
    console.error('Error en registro:', error);

    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        error: 'Este email ya está registrado'
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Error al crear la cuenta. Por favor intenta nuevamente.'
    });
  }
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
  },
  maxDuration: 10,
};