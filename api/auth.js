// api/auth.js - Maneja registro, login e invitaciones
import pkg from 'pg';
const { Pool } = pkg;
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Resend } from 'resend';
import crypto from 'crypto';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'compita-secret-2024';

// Genera un código de referido único tipo REF-abc123
function generarCodigoReferido() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let codigo = 'REF-';
  for (let i = 0; i < 6; i++) {
    codigo += chars[Math.floor(Math.random() * chars.length)];
  }
  return codigo;
}

// Verifica el JWT de Authorization y devuelve el payload
function verificarToken(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return null;
  const token = authHeader.replace('Bearer ', '');
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { action, email, password, nombre, empresa } = req.body;

  if (action === 'registro') {
    const { ref, inv } = req.body;
    return handleRegistro(req, res, email, password, nombre, empresa, ref, inv);
  } else if (action === 'login') {
    return handleLogin(req, res, email, password);
  } else if (action === 'invitar') {
    const usuario = verificarToken(req);
    if (!usuario) return res.status(401).json({ error: 'No autorizado' });
    return handleInvitar(req, res, usuario);
  } else if (action === 'mis_invitaciones') {
    const usuario = verificarToken(req);
    if (!usuario) return res.status(401).json({ error: 'No autorizado' });
    return handleMisInvitaciones(req, res, usuario);
  } else {
    return res.status(400).json({ error: 'Acción no válida' });
  }
}

// ============================================================
// REGISTRO
// ============================================================
async function handleRegistro(req, res, email, password, nombre, empresa, ref, inv) {
  try {
    console.log('🔵 [REGISTRO] Iniciando registro para:', email);
    if (ref) console.log('🔵 [REGISTRO] Código ref recibido:', ref);
    if (inv) console.log('🔵 [REGISTRO] Token de invitación recibido:', inv);

    if (!email || !password || !nombre || !empresa) {
      return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }

    const checkEmail = await pool.query(
      'SELECT id FROM usuarios WHERE email = $1', [email]
    );
    if (checkEmail.rows.length > 0) {
      return res.status(400).json({ error: 'Este email ya está registrado' });
    }

    // ===== VERIFICAR REFERIDO (código REF o token de invitación) =====
    let referidorId = null;
    let diasTrial = 7;
    let invitacionId = null;

    // Primero intentar con token de invitación directa
    if (inv) {
      const invResult = await pool.query(
        `SELECT id, referidor_id FROM invitaciones_referido
         WHERE token = $1 AND estado = 'pendiente' AND expira_at > NOW()`,
        [inv]
      );
      if (invResult.rows.length > 0) {
        referidorId = invResult.rows[0].referidor_id;
        invitacionId = invResult.rows[0].id;
        diasTrial = 30;
        console.log('✅ [REGISTRO] Invitación válida. Referidor ID:', referidorId, '— trial 30 días');
      } else {
        console.log('⚠️ [REGISTRO] Token de invitación inválido o expirado, se ignora');
      }
    }

    // Si no hubo inv válido, intentar con código ref
    if (!referidorId && ref) {
      const refResult = await pool.query(
        'SELECT id FROM usuarios WHERE referido_codigo = $1', [ref]
      );
      if (refResult.rows.length > 0) {
        referidorId = refResult.rows[0].id;
        diasTrial = 30;
        console.log('✅ [REGISTRO] Código ref válido. Referidor ID:', referidorId, '— trial 30 días');
      } else {
        console.log('⚠️ [REGISTRO] Código ref no válido, se ignora');
      }
    }
    // ===== FIN VERIFICAR REFERIDO =====

    const dominio = email.split('@')[1];

    const empresaResult = await pool.query(
      `INSERT INTO empresas (nombre, dominio, descripcion, palabras_clave, exclusiones, monto_minimo_alta, plan, activo, trial_inicio, trial_fin)
       VALUES ($1, $2, '', ARRAY[]::text[], ARRAY[]::text[], 500000, 'free_trial', true, CURRENT_DATE, CURRENT_DATE + INTERVAL '${diasTrial} days')
       RETURNING id, nombre, plan, trial_inicio, trial_fin`,
      [empresa, dominio]
    );
    const empresaId = empresaResult.rows[0].id;
    console.log('✅ [REGISTRO] Empresa creada ID:', empresaId);

    const passwordHash = await bcrypt.hash(password, 10);

    const tokenConfirmacion = jwt.sign(
      { email }, JWT_SECRET, { expiresIn: '24h' }
    );

    // Generar código de referido único para el nuevo usuario
    let codigoReferido = null;
    let intentos = 0;
    while (!codigoReferido && intentos < 5) {
      const candidato = generarCodigoReferido();
      const existe = await pool.query(
        'SELECT id FROM usuarios WHERE referido_codigo = $1', [candidato]
      );
      if (existe.rows.length === 0) codigoReferido = candidato;
      intentos++;
    }

    const userResult = await pool.query(
      `INSERT INTO usuarios (email, password_hash, empresa_id, empresa, rol, activo, email_confirmado, trial_fin, token_confirmacion, referido_codigo)
       VALUES ($1, $2, $3, $4, 'admin', true, false, $5, $6, $7)
       RETURNING id, email, empresa_id, rol, trial_fin`,
      [email, passwordHash, empresaId, empresa, empresaResult.rows[0].trial_fin, tokenConfirmacion, codigoReferido]
    );
    const usuario = userResult.rows[0];
    console.log('✅ [REGISTRO] Usuario creado ID:', usuario.id);

    // Guardar referido en tabla referidos
    if (referidorId) {
      try {
        await pool.query(
          `INSERT INTO referidos (referidor_id, referido_id, estado) VALUES ($1, $2, 'pendiente')`,
          [referidorId, usuario.id]
        );
        console.log('✅ [REGISTRO] Referido guardado como pendiente');
      } catch (refError) {
        console.error('❌ [REGISTRO] Error guardando referido:', refError);
      }
    }

    // Marcar invitación como usada
    if (invitacionId) {
      try {
        await pool.query(
          `UPDATE invitaciones_referido SET estado = 'usado', usado_at = NOW() WHERE id = $1`,
          [invitacionId]
        );
        console.log('✅ [REGISTRO] Invitación marcada como usada');
      } catch (invError) {
        console.error('❌ [REGISTRO] Error marcando invitación:', invError);
      }
    }

    // Enviar email de confirmación
    const resend = new Resend(process.env.RESEND_API_KEY);
    const mensajeTrial = referidorId
      ? `<p><strong>¡Llegaste invitado! Tienes <span style="color:#4F46E5">30 días</span> de prueba gratuita</strong> con todas las funciones del Plan Business:</p>`
      : `<p><strong>Tienes 7 días de prueba gratuita con todas las funciones del Plan Business:</strong></p>`;

    try {
      await resend.emails.send({
        from: 'Compita <noreply@compita.umbusk.com>',
        to: email,
        subject: 'Confirma tu email para activar tu cuenta en Compita',
        html: `
          <h2>¡Bienvenido a Compita!</h2>
          <p>Hola,</p>
          <p>Tu empresa <strong>${empresa}</strong> ha sido registrada exitosamente.</p>
          ${mensajeTrial}
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
      console.log('✅ [REGISTRO] Email de confirmación enviado');
    } catch (emailError) {
      console.error('❌ [REGISTRO] Error enviando email:', emailError);
    }

    // Agregar a Brevo lista 5 (Prueba Gratuita - Activos)
    try {
      await fetch('https://api.brevo.com/v3/contacts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': process.env.BREVO_API_KEY
        },
        body: JSON.stringify({
          email: usuario.email,
          attributes: { EMPRESA: empresa },
          listIds: [5],
          updateEnabled: true
        })
      });
      console.log('✅ [REGISTRO] Contacto agregado a Brevo lista 5');
    } catch (brevoError) {
      console.error('❌ [REGISTRO] Error añadiendo a Brevo:', brevoError);
    }

    return res.status(201).json({
      message: 'Cuenta creada exitosamente. Revisa tu email para confirmar tu cuenta.',
      empresa: empresaResult.rows[0],
      usuario: { id: usuario.id, email: usuario.email, empresa_id: usuario.empresa_id }
    });

  } catch (error) {
    console.error('❌ [REGISTRO] ERROR GENERAL:', error.stack);
    return res.status(500).json({ error: 'Error al crear la cuenta' });
  }
}

// ============================================================
// LOGIN
// ============================================================
async function handleLogin(req, res, email, password) {
  try {
    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña son requeridos' });
    }

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

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    if (!user.activo) {
      return res.status(403).json({ error: 'Tu cuenta está desactivada. Contacta al administrador.' });
    }

    if (!user.email_confirmado) {
      return res.status(403).json({ error: 'Debes confirmar tu email antes de iniciar sesión. Revisa tu bandeja de entrada.' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, empresaId: user.empresa_id, rol: user.rol },
      JWT_SECRET,
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

// ============================================================
// INVITAR (acción protegida)
// ============================================================
async function handleInvitar(req, res, usuarioJWT) {
  try {
    const { email_invitado } = req.body;

    if (!email_invitado) {
      return res.status(400).json({ error: 'El email del invitado es requerido' });
    }

    // Verificar que el email no esté ya registrado
    const yaRegistrado = await pool.query(
      'SELECT id FROM usuarios WHERE email = $1', [email_invitado]
    );
    if (yaRegistrado.rows.length > 0) {
      return res.status(400).json({ error: 'Este email ya tiene una cuenta en Compita' });
    }

    // Verificar que no haya una invitación pendiente para ese email de este usuario
    const yaInvitado = await pool.query(
      `SELECT id FROM invitaciones_referido
       WHERE referidor_id = $1 AND email_invitado = $2 AND estado = 'pendiente' AND expira_at > NOW()`,
      [usuarioJWT.userId, email_invitado]
    );
    if (yaInvitado.rows.length > 0) {
      return res.status(400).json({ error: 'Ya enviaste una invitación pendiente a ese email' });
    }

    // Generar token único
    const token = crypto.randomBytes(32).toString('hex');

    // Guardar en la tabla
    await pool.query(
      `INSERT INTO invitaciones_referido (referidor_id, email_invitado, token)
       VALUES ($1, $2, $3)`,
      [usuarioJWT.userId, email_invitado, token]
    );

    // Obtener nombre del referidor para personalizar el email
    const referidorResult = await pool.query(
      'SELECT empresa FROM usuarios WHERE id = $1', [usuarioJWT.userId]
    );
    const empresaReferidor = referidorResult.rows[0]?.empresa || 'un colega';

    // Enviar email de invitación
    const resend = new Resend(process.env.RESEND_API_KEY);
    const linkRegistro = `https://compita.umbusk.com/registro.html?inv=${token}`;

    try {
      await resend.emails.send({
        from: 'Compita <noreply@compita.umbusk.com>',
        to: email_invitado,
        subject: `${empresaReferidor} te invita a probar Compita`,
        html: `
          <h2>Te han invitado a Compita 🎉</h2>
          <p><strong>${empresaReferidor}</strong> te invita a conocer Compita,
          la plataforma que detecta automáticamente licitaciones del Gobierno Dominicano
          relevantes para tu empresa.</p>
          <p>Como invitado, obtienes <strong>30 días de prueba gratuita</strong>
          (en lugar de los 7 días estándar).</p>
          <p style="text-align: center; margin: 30px 0;">
            <a href="${linkRegistro}"
               style="background-color: #4F46E5; color: white; padding: 12px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
              Crear mi cuenta gratis
            </a>
          </p>
          <p style="color: #666; font-size: 13px;">
            Este enlace expira en 7 días.<br>
            Si no esperabas este email, puedes ignorarlo.
          </p>
        `
      });
      console.log('✅ [INVITAR] Email enviado a:', email_invitado);
    } catch (emailError) {
      console.error('❌ [INVITAR] Error enviando email:', emailError);
      // No bloqueamos — la invitación quedó guardada
    }

    return res.status(200).json({ message: `Invitación enviada a ${email_invitado}` });

  } catch (error) {
    console.error('❌ [INVITAR] ERROR:', error.stack);
    return res.status(500).json({ error: 'Error al enviar invitación' });
  }
}

// ============================================================
// MIS INVITACIONES (acción protegida)
// ============================================================
async function handleMisInvitaciones(req, res, usuarioJWT) {
  try {
    const result = await pool.query(
      `SELECT email_invitado, estado, created_at, usado_at
       FROM invitaciones_referido
       WHERE referidor_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [usuarioJWT.userId]
    );

    return res.status(200).json({ invitaciones: result.rows });

  } catch (error) {
    console.error('❌ [MIS_INVITACIONES] ERROR:', error.stack);
    return res.status(500).json({ error: 'Error al cargar invitaciones' });
  }
}