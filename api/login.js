// api/login.js - Autenticación de usuarios
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
    const { email, password, recordar } = req.body;

    // ========== VALIDACIONES ==========
    
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email y contraseña son requeridos'
      });
    }

    // ========== BUSCAR USUARIO EN LA BASE DE DATOS ==========
    
    const usuarios = await sql`
      SELECT 
        id, 
        email, 
        empresa, 
        password_hash,
        email_confirmado,
        activo,
        trial_inicio,
        trial_fin,
        created_at
      FROM usuarios 
      WHERE email = ${email.toLowerCase()}
    `;

    if (usuarios.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Email o contraseña incorrectos'
      });
    }

    const usuario = usuarios[0];

    // ========== VERIFICAR QUE EL USUARIO ESTÉ ACTIVO ==========
    
    if (!usuario.activo) {
      return res.status(403).json({
        success: false,
        error: 'Esta cuenta ha sido desactivada. Contacta a soporte.'
      });
    }

    // ========== VERIFICAR CONTRASEÑA ==========
    
    const passwordValido = await bcrypt.compare(password, usuario.password_hash);

    if (!passwordValido) {
      return res.status(401).json({
        success: false,
        error: 'Email o contraseña incorrectos'
      });
    }

    // ========== VERIFICAR ESTADO DEL TRIAL ==========
    
    const ahora = new Date();
    const trialFin = new Date(usuario.trial_fin);
    const trialActivo = ahora <= trialFin;
    const diasRestantes = Math.max(0, Math.ceil((trialFin - ahora) / (1000 * 60 * 60 * 24)));

    // ========== GENERAR TOKEN JWT ==========
    
    const tokenExpiracion = recordar ? '30d' : '24h';
    
    const token = jwt.sign(
      { 
        id: usuario.id,
        email: usuario.email,
        empresa: usuario.empresa
      },
      process.env.JWT_SECRET || 'compita-secret-2024',
      { expiresIn: tokenExpiracion }
    );

    // ========== RESPUESTA EXITOSA ==========
    
    return res.status(200).json({
      success: true,
      token,
      usuario: {
        id: usuario.id,
        email: usuario.email,
        empresa: usuario.empresa,
        email_confirmado: usuario.email_confirmado,
        trial_activo: trialActivo,
        trial_fin: usuario.trial_fin,
        dias_restantes: diasRestantes,
        created_at: usuario.created_at
      }
    });

  } catch (error) {
    console.error('Error en login:', error);
    
    return res.status(500).json({
      success: false,
      error: 'Error al iniciar sesión. Por favor intenta nuevamente.'
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