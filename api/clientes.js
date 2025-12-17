// api/clientes.js - CRUD de Clientes (ACTUALIZADO con exclusiones)
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,PUT,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const sql = neon(process.env.NETLIFYDATABASEURL);

  try {
    // LISTAR TODOS los clientes
    if (req.method === 'GET' && !req.query.id) {
      const clientes = await sql`
        SELECT 
          id, nombre, descripcion, 
          criterios_alta, criterios_media, exclusiones,
          prompt_personalizado, activo, created_at
        FROM clientes 
        WHERE activo = true
        ORDER BY nombre
      `;
      return res.status(200).json({ success: true, clientes });
    }

    // OBTENER UN cliente por ID
    if (req.method === 'GET' && req.query.id) {
      const cliente = await sql`SELECT * FROM clientes WHERE id = ${req.query.id}`;
      if (cliente.length === 0) {
        return res.status(404).json({ success: false, error: 'Cliente no encontrado' });
      }
      return res.status(200).json({ success: true, cliente: cliente[0] });
    }

    // CREAR nuevo cliente
    if (req.method === 'POST') {
      const { nombre, descripcion, criterios_alta, criterios_media, exclusiones, prompt_personalizado } = req.body;

      if (!nombre) {
        return res.status(400).json({ success: false, error: 'Nombre es requerido' });
      }

      if ((!criterios_alta || criterios_alta.length === 0) && (!criterios_media || criterios_media.length === 0)) {
        return res.status(400).json({ success: false, error: 'Debe especificar al menos un criterio ALTA o MEDIA' });
      }

      const resultado = await sql`
        INSERT INTO clientes (nombre, descripcion, criterios_alta, criterios_media, exclusiones, prompt_personalizado)
        VALUES (${nombre}, ${descripcion || ''}, ${criterios_alta || []}, ${criterios_media || []}, ${exclusiones || []}, ${prompt_personalizado || null})
        RETURNING *
      `;

      return res.status(201).json({ success: true, cliente: resultado[0], mensaje: 'Cliente creado exitosamente' });
    }

    // ACTUALIZAR cliente
    if (req.method === 'PUT') {
      const { id, nombre, descripcion, criterios_alta, criterios_media, exclusiones, prompt_personalizado } = req.body;

      if (!id) {
        return res.status(400).json({ success: false, error: 'ID es requerido' });
      }

      if ((!criterios_alta || criterios_alta.length === 0) && (!criterios_media || criterios_media.length === 0)) {
        return res.status(400).json({ success: false, error: 'Debe especificar al menos un criterio ALTA o MEDIA' });
      }

      const resultado = await sql`
        UPDATE clientes 
        SET nombre = ${nombre}, descripcion = ${descripcion}, criterios_alta = ${criterios_alta},
            criterios_media = ${criterios_media}, exclusiones = ${exclusiones || []},
            prompt_personalizado = ${prompt_personalizado}, updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;

      if (resultado.length === 0) {
        return res.status(404).json({ success: false, error: 'Cliente no encontrado' });
      }

      return res.status(200).json({ success: true, cliente: resultado[0], mensaje: 'Cliente actualizado exitosamente' });
    }

    // ELIMINAR cliente (soft delete)
    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) {
        return res.status(400).json({ success: false, error: 'ID es requerido' });
      }

      await sql`UPDATE clientes SET activo = false, updated_at = NOW() WHERE id = ${id}`;
      return res.status(200).json({ success: true, mensaje: 'Cliente eliminado exitosamente' });
    }

    return res.status(405).json({ error: 'Método no permitido' });

  } catch (error) {
    console.error('Error en API clientes:', error);
    return res.status(500).json({ success: false, error: 'Error del servidor: ' + error.message });
  }
}

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
  maxDuration: 10,
};