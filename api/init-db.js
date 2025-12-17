// api/init-db.js - Script para inicializar las tablas
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Solo POST permitido' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // Crear tabla clientes
    await sql`
      CREATE TABLE IF NOT EXISTS clientes (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        descripcion TEXT,
        criterios_alta TEXT[],
        criterios_media TEXT[],
        criterios_baja TEXT[],
        prompt_personalizado TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        activo BOOLEAN DEFAULT true
      )
    `;

    // Crear tabla analisis
    await sql`
      CREATE TABLE IF NOT EXISTS analisis (
        id SERIAL PRIMARY KEY,
        cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
        fecha_analisis TIMESTAMP DEFAULT NOW(),
        total_descripciones INTEGER,
        total_alta INTEGER,
        total_media INTEGER,
        total_baja INTEGER,
        porcentaje_alta DECIMAL(5,2),
        fuente VARCHAR(100),
        notas TEXT
      )
    `;

    // Crear tabla resultados
    await sql`
      CREATE TABLE IF NOT EXISTS resultados (
        id SERIAL PRIMARY KEY,
        analisis_id INTEGER REFERENCES analisis(id) ON DELETE CASCADE,
        cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
        descripcion TEXT NOT NULL,
        que VARCHAR(100),
        quien VARCHAR(100),
        relevancia VARCHAR(10),
        razon TEXT,
        seleccionado BOOLEAN DEFAULT false,
        notas TEXT,
        estado VARCHAR(50) DEFAULT 'pendiente',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;

    // Crear índices
    await sql`CREATE INDEX IF NOT EXISTS idx_resultados_relevancia ON resultados(relevancia)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_resultados_cliente ON resultados(cliente_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_resultados_seleccionado ON resultados(seleccionado)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_analisis_cliente ON analisis(cliente_id)`;

    // Insertar cliente de ejemplo si no existe
    const existente = await sql`SELECT id FROM clientes WHERE nombre = 'Formación Smart'`;
    
    if (existente.length === 0) {
      await sql`
        INSERT INTO clientes (nombre, descripcion, criterios_alta, criterios_media, criterios_baja) 
        VALUES (
          'Formación Smart',
          'Empresa de capacitación y consultoría organizacional',
          ARRAY['capacitación', 'cursos', 'talleres', 'diplomados', 'consultoría organizacional', 'coaching', 'evaluación desempeño'],
          ARRAY['consultoría técnica', 'estudios', 'servicios profesionales'],
          ARRAY['compra bienes', 'mantenimiento', 'construcción', 'catering', 'hospedaje', 'materiales', 'equipos']
        )
      `;
    }

    return res.status(200).json({
      success: true,
      mensaje: 'Base de datos inicializada correctamente',
      tablas: ['clientes', 'analisis', 'resultados'],
      indices: 4,
      cliente_ejemplo: 'Formación Smart'
    });

  } catch (error) {
    console.error('Error inicializando DB:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
