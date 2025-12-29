// api/init-usuarios.js - Crear tabla de usuarios
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Solo POST permitido' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // Crear tabla usuarios
    await sql`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        empresa VARCHAR(255) NOT NULL,
        password_hash TEXT NOT NULL,
        email_confirmado BOOLEAN DEFAULT false,
        token_confirmacion TEXT,
        trial_inicio TIMESTAMP,
        trial_fin TIMESTAMP,
        activo BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `;

    // Crear índices
    await sql`CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_usuarios_activo ON usuarios(activo)`;

    return res.status(200).json({
      success: true,
      mensaje: 'Tabla usuarios creada correctamente',
      tablas: ['usuarios'],
      indices: 2
    });

  } catch (error) {
    console.error('Error creando tabla usuarios:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}