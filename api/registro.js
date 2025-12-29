// api/registro.js - Registro de usuarios
import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

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
    
    // 1. Validar que todos los campos estén presentes
    if (!email || !empresa || !password) {
      return res.status(400).json({
        success: false,
        error: 'Todos los campos son requeridos'
      });
    }

    // 2. Validar formato de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        error: 'Email inválido'
      });
    }

    // 3. Validar que NO sea email gratuito
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

    // 4. Validar longitud de contraseña
    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'La contraseña debe tener al menos 8 caracteres'
      });
    }

    // 5. Validar que la empresa tenga al menos 2 caracteres
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

    // ========== HASHEAR CONTRASEÑA ==========
    
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // ========== GENERAR TOKEN DE CONFIRMACIÓN ==========
    
    const tokenConfirmacion = jwt.sign(
      { email: email.toLowerCase() },
      process.env.JWT_SECRET || 'compita-secret-2024',
      { expiresIn: '7d' }
    );

    // ========== CALCULAR FECHAS DEL TRIAL ==========
    
    const ahora = new Date();
    const trialFin = new Date(ahora);
    trialFin.setDate(trialFin.getDate() + 7); // 7 días de trial

    // ========== CREAR USUARIO EN LA BASE DE DATOS ==========
    
    const resultado = await sql`
      INSERT INTO usuarios (
        email,
        empresa,
        password_hash,
        token_confirmacion,
        trial_inicio,
        trial_fin,
        email_confirmado,
        activo
      )
      VALUES (
        ${email.toLowerCase()},
        ${empresa.trim()},
        ${passwordHash},
        ${tokenConfirmacion},
        ${ahora.toISOString()},
        ${trialFin.toISOString()},
        false,
        true
      )
      RETURNING id, email, empresa, trial_inicio, trial_fin, created_at
    `;

    const nuevoUsuario = resultado[0];

    // ========== ENVIAR EMAIL DE CONFIRMACIÓN ==========
    // Por ahora lo dejamos comentado hasta configurar el servicio de email
    
    /*
    await enviarEmailConfirmacion({
      email: nuevoUsuario.email,
      empresa: nuevoUsuario.empresa,
      token: tokenConfirmacion
    });
    */

    // ========== RESPUESTA EXITOSA ==========
    
    return res.status(201).json({
      success: true,
      mensaje: 'Usuario registrado exitosamente',
      usuario: {
        id: nuevoUsuario.id,
        email: nuevoUsuario.email,
        empresa: nuevoUsuario.empresa,
        trial_fin: nuevoUsuario.trial_fin
      }
    });

  } catch (error) {
    console.error('Error en registro:', error);
    
    // Manejar errores específicos de la base de datos
    if (error.code === '23505') { // Código de PostgreSQL para unique violation
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