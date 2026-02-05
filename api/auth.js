// api/auth.js - Maneja registro y login de usuarios
import pkg from 'pg';
const { Pool } = pkg;
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Resend } from 'resend';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  // Permitir peticiones desde cualquier origen (CORS)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { action, email, password, nombre, empresa } = req.body;

  // Determinar si es registro o login
  if (action === 'registro') {
    return handleRegistro(req, res, email, password, nombre, empresa);
  } else if (action === 'login') {
    return handleLogin(req, res, email, password);
  } else {
    return res.status(400).json({ error: 'Acción no válida. Use "registro" o "login"' });
  }
}

// REEMPLAZA solo la función handleRegistro en auth.js con esta versión que tiene logging

async function handleRegistro(req, res, email, password, nombre, empresa) {
  try {
    console.log('🔵 [REGISTRO] Iniciando registro para:', email);

    // Validar que todos los campos estén presentes
    if (!email || !password || !nombre || !empresa) {
      console.log('❌ [REGISTRO] Faltan campos');
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }

    // Verificar si el email ya existe
    const checkEmail = await pool.query(
      'SELECT id FROM usuarios WHERE email = $1',
      [email]
    );

    if (checkEmail.rows.length > 0) {
      console.log('❌ [REGISTRO] Email ya existe:', email);
      return res.status(400).json({ error: 'Este email ya está registrado' });
    }

    console.log('✅ [REGISTRO] Email disponible');

    // Extraer el dominio del email
    const dominio = email.split('@')[1];

    // Crear la empresa nueva con valores por defecto
    console.log('🔵 [REGISTRO] Creando empresa:', empresa);
    const empresaResult = await pool.query(
      `INSERT INTO empresas (nombre, dominio, descripcion, palabras_clave, exclusiones, monto_minimo_alta, plan, activo, trial_inicio, trial_fin)
       VALUES ($1, $2, '', ARRAY[]::text[], ARRAY[]::text[], 500000, 'free_trial', true, CURRENT_DATE, CURRENT_DATE + INTERVAL '7 days')
       RETURNING id, nombre, plan, trial_inicio, trial_fin`,
      [empresa, dominio]
    );

    const empresaId = empresaResult.rows[0].id;
    console.log('✅ [REGISTRO] Empresa creada con ID:', empresaId);

    // Encriptar la contraseña
    const passwordHash = await bcrypt.hash(password, 10);
    console.log('✅ [REGISTRO] Password hasheado');

    // Generar token de confirmación ANTES de crear el usuario
    const tokenConfirmacion = jwt.sign(
      { email: email },
      process.env.JWT_SECRET || 'compita-secret-2024',
      { expiresIn: '24h' }
    );
    console.log('✅ [REGISTRO] Token generado:', tokenConfirmacion.substring(0, 20) + '...');

    // Crear el usuario CON email_confirmado = false y token guardado
    console.log('🔵 [REGISTRO] Creando usuario...');
    const userResult = await pool.query(
      `INSERT INTO usuarios (email, password_hash, empresa_id, empresa, rol, activo, email_confirmado, trial_fin, token_confirmacion)
       VALUES ($1, $2, $3, $4, 'admin', true, false, $5, $6)
       RETURNING id, email, empresa_id, rol, trial_fin`,
      [email, passwordHash, empresaId, empresa, empresaResult.rows[0].trial_fin, tokenConfirmacion]
    );

    const usuario = userResult.rows[0];
    console.log('✅ [REGISTRO] Usuario creado con ID:', usuario.id);

    // Enviar email de confirmación
    console.log('🔵 [REGISTRO] Intentando enviar email a:', email);
    console.log('🔵 [REGISTRO] RESEND_API_KEY:', process.env.RESEND_API_KEY ? 're_***' + process.env.RESEND_API_KEY.slice(-4) : 'NO EXISTE');

    // Inicializar Resend aquí, dentro de la función
    const resend = new Resend(process.env.RESEND_API_KEY);
    console.log('🔵 [REGISTRO] Resend inicializado');

    try {
      const emailResult = await resend.emails.send({
        from: 'Compita <noreply@umbusk.com>',
        to: email,
        subject: 'Confirma tu email para activar tu cuenta en Compita',
        html: `
          <h2>¡Bienvenido a Compita!</h2>
          <p>Hola,</p>
          <p>Tu empresa <strong>${empresa}</strong> ha sido registrada exitosamente.</p>
          <p><strong>Tienes 7 días de prueba gratuita con todas las funciones del Plan Business:</strong></p>
          <ul>
            <li>✓ Análisis diario automático de licitaciones</li>
            <li>✓ Notificaciones por email de oportunidades ALTA y MEDIA</li>
            <li>✓ Descarga de documentos (10/mes)</li>
            <li>✓ Análisis profundo con IA (5/mes)</li>
          </ul>
          <p><strong>Para activar tu cuenta, confirma tu email haciendo clic aquí:</strong></p>
          <p style="text-align: center; margin: 30px 0;">
            <a href="https://compita.umbusk.com/confirmar-email.html?token=${tokenConfirmacion}"
               style="background-color: #4F46E5; color: white; padding: 12px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
              Confirmar mi Email
            </a>
          </p>
          <p style="color: #666; font-size: 14px;">
            Si no solicitaste esta cuenta, puedes ignorar este email.<br>
            Este enlace expira en 24 horas.
          </p>
        `
      });

      console.log('🔵 [REGISTRO] Respuesta completa de Resend:', JSON.stringify(emailResult, null, 2));
      console.log('✅ [REGISTRO] Email enviado. ID:', emailResult?.id || emailResult?.data?.id || 'NO ENCONTRADO');
    } catch (emailError) {
      console.error('❌ [REGISTRO] ERROR AL ENVIAR EMAIL:', emailError);
      console.error('❌ [REGISTRO] Detalles del error:', JSON.stringify(emailError, null, 2));
      // No detenemos el registro, solo logueamos el error
    }

    console.log('✅ [REGISTRO] Proceso completado para:', email);

    return res.status(201).json({
      message: 'Cuenta creada exitosamente. Revisa tu email para confirmar tu cuenta.',
      empresa: empresaResult.rows[0],
      usuario: {
        id: usuario.id,
        email: usuario.email,
        empresa_id: usuario.empresa_id
      }
    });

  } catch (error) {
    console.error('❌ [REGISTRO] ERROR GENERAL:', error);
    console.error('❌ [REGISTRO] Stack:', error.stack);
    return res.status(500).json({ error: 'Error al crear la cuenta' });
  }
}

// FUNCIÓN PARA LOGIN
async function handleLogin(req, res, email, password) {
  try {
    // Validar campos
    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña son requeridos' });
    }

    // Buscar usuario con su empresa
    const result = await pool.query(
      `SELECT u.*, e.nombre as empresa_nombre, e.plan, e.activo as empresa_activa, e.trial_fin as empresa_trial_fin
       FROM usuarios u
       JOIN empresas e ON u.empresa_id = e.id
       WHERE u.email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    const user = result.rows[0];

    // Verificar contraseña
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    // Verificar si la cuenta está activa
    if (!user.activo) {
      return res.status(403).json({ error: 'Tu cuenta está desactivada. Contacta al administrador.' });
    }

    // Verificar si el email está confirmado
    if (!user.email_confirmado) {
      return res.status(403).json({ error: 'Debes confirmar tu email antes de iniciar sesión. Revisa tu bandeja de entrada.' });
    }

    // Generar JWT token
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        empresaId: user.empresa_id,
        rol: user.rol
      },
      process.env.JWT_SECRET || 'compita-secret-2024',
      { expiresIn: '7d' }
    );

    return res.status(200).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        empresa: user.empresa_nombre,
        empresa_id: user.empresa_id,
        rol: user.rol,
        plan: user.plan,
        trial_fin: user.empresa_trial_fin
      }
    });

  } catch (error) {
    console.error('Error en login:', error);
    return res.status(500).json({ error: 'Error al iniciar sesión' });
  }
}