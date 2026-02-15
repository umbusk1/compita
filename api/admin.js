import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'compita-admin-secret-2026';

// Verificar token
function verificarToken(authHeader) {
  try {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    const token = authHeader.substring(7);
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

// Handler principal
export default async function handler(req, res) {
  const { action } = req.query;

  try {
    switch(action) {
      case 'login':
        return await handleLogin(req, res);
      case 'stats':
        return await handleStats(req, res);
      case 'verify':
        return await handleVerify(req, res);
      case 'detalle':
        return await handleDetalle(req, res);
      case 'actualizar':
        return await handleActualizar(req, res);
      case 'resetear_cuota':
        return await handleResetearCuota(req, res);
      case 'crear_empresa':
        return await handleCrearEmpresa(req, res);
      case 'desactivar_empresa':
        return await handleDesactivarEmpresa(req, res);
      case 'reactivar_empresa':
        return await handleReactivarEmpresa(req, res);
      case 'eliminar_empresa':
        return await handleEliminarEmpresa(req, res);
      case 'ejecutar_scraping':
        return await handleEjecutarScraping(req, res);
      case 'ejecutar_analisis':
        return await handleEjecutarAnalisis(req, res);
      case 'invitar_admin':
  	    return await handleInvitarAdmin(req, res);
      default:
        return res.status(400).json({ error: 'Acción no especificada' });
    }
  } catch (error) {
    console.error('Error en admin API:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// LOGIN
async function handleLogin(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña son requeridos' });
  }

  const result = await pool.query(
    'SELECT * FROM administradores WHERE email = $1 AND activo = true',
    [email.toLowerCase()]
  );

  if (result.rows.length === 0) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  const admin = result.rows[0];
  const passwordValido = await bcrypt.compare(password, admin.password_hash);

  if (!passwordValido) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  await pool.query(
    'UPDATE administradores SET ultimo_acceso = CURRENT_TIMESTAMP WHERE id = $1',
    [admin.id]
  );

  const token = jwt.sign(
    { id: admin.id, email: admin.email, rol: admin.rol },
    JWT_SECRET,
    { expiresIn: '8h' }
  );

  return res.json({
    token,
    admin: {
      id: admin.id,
      nombre: admin.nombre,
      email: admin.email,
      rol: admin.rol
    }
  });
}

// STATS
async function handleStats(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const admin = verificarToken(req.headers.authorization);
  if (!admin) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const totalEmpresas = await pool.query('SELECT COUNT(*) as total FROM empresas WHERE activo = true');
  const licitacionesHoy = await pool.query(
    `SELECT COUNT(*) as total, MAX(scrapeado_en) as ultimo_scraping
     FROM licitaciones WHERE DATE(scrapeado_en) = CURRENT_DATE`
  );
  const oportunidadesTotales = await pool.query('SELECT COUNT(*) as total FROM resultados');
  const emailsHoy = await pool.query(
    `SELECT COUNT(DISTINCT empresa_id) as total FROM resultados
     WHERE DATE(fecha_analisis) = CURRENT_DATE`
  );

  // Contar análisis IA realizados hoy
  const analisisHoy = await pool.query(
    `SELECT COUNT(*) as total FROM resultados
     WHERE DATE(fecha_analisis) = CURRENT_DATE`
  );

  const empresas = await pool.query(`
    SELECT
      e.id, e.nombre, e.dominio, e.plan, e.activo, e.trial_fin,
      u.email as usuario_email,
      COUNT(r.id) as oportunidades_count
    FROM empresas e
    LEFT JOIN usuarios u ON u.empresa_id = e.id
    LEFT JOIN resultados r ON r.empresa_id = e.id
    GROUP BY e.id, e.nombre, e.dominio, e.plan, e.activo, e.trial_fin, u.email
    ORDER BY e.id
  `);

  const administradores = await pool.query(`
    SELECT id, nombre, email, rol, activo, creado_en, ultimo_acceso
    FROM administradores ORDER BY rol DESC, nombre
  `);

  const ultimoScraping = await pool.query('SELECT MAX(scrapeado_en) as fecha FROM licitaciones');
  const ultimoAnalisis = await pool.query('SELECT MAX(fecha_analisis) as fecha FROM resultados');

  return res.json({
    total_empresas: parseInt(totalEmpresas.rows[0].total),
    licitaciones_hoy: parseInt(licitacionesHoy.rows[0].total),
    oportunidades_totales: parseInt(oportunidadesTotales.rows[0].total),
    emails_enviados_hoy: parseInt(emailsHoy.rows[0].total),
    analisis_ia_hoy: parseInt(analisisHoy.rows[0].total),
    ultimo_scraping: ultimoScraping.rows[0].fecha,
    ultimo_analisis: ultimoAnalisis.rows[0].fecha,
    empresas: empresas.rows,
    administradores: administradores.rows,
    admin_actual: { id: admin.id, email: admin.email, rol: admin.rol }
  });
}

// VERIFY
async function handleVerify(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const decoded = verificarToken(req.headers.authorization);
  if (!decoded) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const result = await pool.query(
    'SELECT id, nombre, email, rol, activo FROM administradores WHERE id = $1',
    [decoded.id]
  );

  if (result.rows.length === 0 || !result.rows[0].activo) {
    return res.status(401).json({ error: 'Administrador no válido' });
  }

  const admin = result.rows[0];
  return res.json({
    id: admin.id,
    nombre: admin.nombre,
    email: admin.email,
    rol: admin.rol
  });
}

// DETALLE DE EMPRESA
async function handleDetalle(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const admin = verificarToken(req.headers.authorization);
  if (!admin) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { empresa_id } = req.query;

  if (!empresa_id) {
    return res.status(400).json({ error: 'empresa_id es requerido' });
  }

  const empresa = await pool.query(`
    SELECT
      e.*,
      u.email as usuario_email,
      COUNT(DISTINCT r.id) as oportunidades_count
    FROM empresas e
    LEFT JOIN usuarios u ON u.empresa_id = e.id
    LEFT JOIN resultados r ON r.empresa_id = e.id
    WHERE e.id = $1
    GROUP BY e.id, u.email
  `, [empresa_id]);

  if (empresa.rows.length === 0) {
    return res.status(404).json({ error: 'Empresa no encontrada' });
  }

  const datos = empresa.rows[0];

  const descargasMes = await pool.query(`
    SELECT COUNT(*) as total
    FROM descargas
    WHERE empresa_id = $1
    AND DATE_TRUNC('month', descargado_en) = DATE_TRUNC('month', CURRENT_DATE)
  `, [empresa_id]);

  const analisisMes = await pool.query(`
    SELECT COUNT(*) as total
    FROM analisis_profundos
    WHERE empresa_id = $1
    AND DATE_TRUNC('month', analizado_en) = DATE_TRUNC('month', CURRENT_DATE)
  `, [empresa_id]);

  return res.json({
    id: datos.id,
    nombre: datos.nombre,
    dominio: datos.dominio,
    usuario_email: datos.usuario_email,
    plan: datos.plan,
    activo: datos.activo,
    trial_fin: datos.trial_fin,
    palabras_clave: datos.palabras_clave || [],
    palabras_exclusion: datos.palabras_exclusion || [],
    familias_unspsc: datos.familias_unspsc || [],
    usa_unspsc: datos.usa_unspsc,
    monto_minimo: datos.monto_minimo,
    oportunidades_count: parseInt(datos.oportunidades_count) || 0,
    descargas_mes: parseInt(descargasMes.rows[0].total) || 0,
    analisis_ia_mes: parseInt(analisisMes.rows[0].total) || 0
  });
}

// ACTUALIZAR EMPRESA
async function handleActualizar(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const admin = verificarToken(req.headers.authorization);
  if (!admin) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { empresa_id, plan, activo } = req.body;

  if (!empresa_id) {
    return res.status(400).json({ error: 'empresa_id es requerido' });
  }

  await pool.query(`
    UPDATE empresas
    SET plan = $1, activo = $2
    WHERE id = $3
  `, [plan, activo, empresa_id]);

  console.log(`[ADMIN] Empresa ${empresa_id} actualizada: plan=${plan}, activo=${activo} por admin ${admin.email}`);

  return res.json({ success: true, mensaje: 'Empresa actualizada correctamente' });
}

// RESETEAR CUOTA
async function handleResetearCuota(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const admin = verificarToken(req.headers.authorization);
  if (!admin) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { empresa_id, tipo } = req.body;

  if (!empresa_id || !tipo) {
    return res.status(400).json({ error: 'empresa_id y tipo son requeridos' });
  }

  if (tipo === 'descargas') {
    await pool.query(`
      DELETE FROM descargas
      WHERE empresa_id = $1
      AND DATE_TRUNC('month', descargado_en) = DATE_TRUNC('month', CURRENT_DATE)
    `, [empresa_id]);

    console.log(`[ADMIN] Cuota de descargas reseteada para empresa ${empresa_id} por admin ${admin.email}`);

  } else if (tipo === 'analisis') {
    await pool.query(`
      DELETE FROM analisis_profundos
      WHERE empresa_id = $1
      AND DATE_TRUNC('month', analizado_en) = DATE_TRUNC('month', CURRENT_DATE)
    `, [empresa_id]);

    console.log(`[ADMIN] Cuota de análisis IA reseteada para empresa ${empresa_id} por admin ${admin.email}`);

  } else {
    return res.status(400).json({ error: 'Tipo inválido. Use "descargas" o "analisis"' });
  }

  return res.json({ success: true, mensaje: `Cuota de ${tipo} reseteada correctamente` });
}

// CREAR EMPRESA
async function handleCrearEmpresa(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const admin = verificarToken(req.headers.authorization);
  if (!admin) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { nombre, dominio, contacto_nombre, email, password, plan, palabras_clave } = req.body;

  if (!nombre || !contacto_nombre || !email || !password || !plan) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }

  try {
    const emailExiste = await pool.query(
      'SELECT id FROM usuarios WHERE email = $1',
      [email.toLowerCase()]
    );

    if (emailExiste.rows.length > 0) {
      return res.status(400).json({ error: 'Este email ya está registrado' });
    }

    const resultEmpresa = await pool.query(`
      INSERT INTO empresas (
        nombre,
        dominio,
        descripcion,
        plan,
        activo,
        palabras_clave,
        trial_inicio,
        trial_fin,
        max_familias_unspsc
      ) VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8)
      RETURNING id
    `, [
      nombre,
      dominio || 'Sin dominio',
      '',
      plan,
      palabras_clave || [],
      plan === 'prueba_gratis' ? new Date() : null,
      plan === 'prueba_gratis' ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) : null,
      plan === 'prueba_gratis' || plan === 'business' || plan === 'enterprise' ? 5 : 2
    ]);

    const empresaId = resultEmpresa.rows[0].id;
    const passwordHash = await bcrypt.hash(password, 10);

    await pool.query(`
      INSERT INTO usuarios (
        empresa_id,
        email,
        empresa,
        password_hash,
        rol,
        activo,
        email_confirmado
      ) VALUES ($1, $2, $3, $4, $5, true, true)
    `, [
      empresaId,
      email.toLowerCase(),
      nombre,
      passwordHash,
      'owner'
    ]);

    console.log(`[ADMIN] Nueva empresa creada: ${nombre} (ID: ${empresaId}) por admin ${admin.email}`);

    try {
      const resendApiKey = process.env.RESEND_API_KEY;
      if (resendApiKey) {
        const emailResponse = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${resendApiKey}`
          },
          body: JSON.stringify({
            from: 'Compita <no-reply@compita.umbusk.com>',
            to: [email],
            subject: '🎉 Bienvenido a Compita - Tus credenciales de acceso',
            html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px"><div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:30px;text-align:center;border-radius:10px 10px 0 0"><h1 style="color:white;margin:0">🎉 ¡Bienvenido a Compita!</h1></div><div style="background:#f9fafb;padding:30px;border-radius:0 0 10px 10px"><p>Hola <strong>${contacto_nombre}</strong>,</p><p>Tu cuenta en Compita ha sido creada exitosamente.</p><div style="background:white;border-left:4px solid #667eea;padding:20px;margin:20px 0;border-radius:5px"><h3 style="margin-top:0;color:#667eea">📋 Tus credenciales:</h3><p><strong>Usuario:</strong> ${email}</p><p><strong>Contraseña temporal:</strong> <code style="background:#f3f4f6;padding:5px 10px;border-radius:4px">${password}</code></p><p><strong>Plan:</strong> ${plan.toUpperCase()}</p></div><div style="text-align:center;margin:30px 0"><a href="https://compita.umbusk.com/login.html" style="background:#667eea;color:white;padding:15px 30px;text-decoration:none;border-radius:5px;font-weight:bold;display:inline-block">🚀 Iniciar Sesión</a></div></div></body></html>`
          })
        });
        if (emailResponse.ok) {
          console.log(`[EMAIL] Credenciales enviadas a ${email}`);
        }
      }
    } catch (emailError) {
      console.error('Error enviando email:', emailError);
    }

    return res.json({
      success: true,
      empresa_id: empresaId,
      mensaje: 'Empresa creada exitosamente'
    });

  } catch (error) {
    console.error('Error al crear empresa:', error);
    return res.status(500).json({ error: 'Error al crear la empresa' });
  }
}

// DESACTIVAR EMPRESA
async function handleDesactivarEmpresa(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const admin = verificarToken(req.headers.authorization);
  if (!admin) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { empresa_id } = req.body;

  if (!empresa_id) {
    return res.status(400).json({ error: 'empresa_id es requerido' });
  }

  try {
    await pool.query('UPDATE empresas SET activo = false WHERE id = $1', [empresa_id]);
    await pool.query('UPDATE usuarios SET activo = false WHERE empresa_id = $1', [empresa_id]);

    console.log(`[ADMIN] Empresa ${empresa_id} desactivada por admin ${admin.email}`);

    return res.json({ success: true, mensaje: 'Empresa desactivada correctamente' });
  } catch (error) {
    console.error('Error al desactivar empresa:', error);
    return res.status(500).json({ error: 'Error al desactivar la empresa' });
  }
}

// REACTIVAR EMPRESA
async function handleReactivarEmpresa(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const admin = verificarToken(req.headers.authorization);
  if (!admin) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { empresa_id } = req.body;

  if (!empresa_id) {
    return res.status(400).json({ error: 'empresa_id es requerido' });
  }

  try {
    await pool.query('UPDATE empresas SET activo = true WHERE id = $1', [empresa_id]);
    await pool.query('UPDATE usuarios SET activo = true WHERE empresa_id = $1', [empresa_id]);

    console.log(`[ADMIN] Empresa ${empresa_id} reactivada por admin ${admin.email}`);

    return res.json({ success: true, mensaje: 'Empresa reactivada correctamente' });
  } catch (error) {
    console.error('Error al reactivar empresa:', error);
    return res.status(500).json({ error: 'Error al reactivar la empresa' });
  }
}

// ELIMINAR EMPRESA (HARD DELETE)
async function handleEliminarEmpresa(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const admin = verificarToken(req.headers.authorization);
  if (!admin) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { empresa_id } = req.body;

  if (!empresa_id) {
    return res.status(400).json({ error: 'empresa_id es requerido' });
  }

  try {
    const conteoResultados = await pool.query('SELECT COUNT(*) as total FROM resultados WHERE empresa_id = $1', [empresa_id]);
    const conteoDescargas = await pool.query('SELECT COUNT(*) as total FROM descargas WHERE empresa_id = $1', [empresa_id]);
    const conteoAnalisisProfundos = await pool.query('SELECT COUNT(*) as total FROM analisis_profundos WHERE empresa_id = $1', [empresa_id]);
    const conteoAnalisis = await pool.query('SELECT COUNT(*) as total FROM analisis WHERE empresa_id = $1', [empresa_id]);
    const conteoUsuarios = await pool.query('SELECT COUNT(*) as total FROM usuarios WHERE empresa_id = $1', [empresa_id]);

    await pool.query('DELETE FROM analisis WHERE empresa_id = $1', [empresa_id]);
    await pool.query('DELETE FROM analisis_profundos WHERE empresa_id = $1', [empresa_id]);
    await pool.query('DELETE FROM descargas WHERE empresa_id = $1', [empresa_id]);
    await pool.query('DELETE FROM resultados WHERE empresa_id = $1', [empresa_id]);
    await pool.query('DELETE FROM usuarios WHERE empresa_id = $1', [empresa_id]);
    await pool.query('DELETE FROM empresas WHERE id = $1', [empresa_id]);

    const detalles = `Registros eliminados:
- ${conteoUsuarios.rows[0].total} usuarios
- ${conteoResultados.rows[0].total} oportunidades
- ${conteoDescargas.rows[0].total} descargas
- ${conteoAnalisisProfundos.rows[0].total} análisis profundos
- ${conteoAnalisis.rows[0].total} análisis`;

    console.log(`[ADMIN] Empresa ${empresa_id} ELIMINADA por admin ${admin.email}`);
    console.log(detalles);

    return res.json({
      success: true,
      mensaje: 'Empresa eliminada permanentemente',
      detalles: detalles
    });
  } catch (error) {
    console.error('Error al eliminar empresa:', error);
    return res.status(500).json({ error: 'Error al eliminar la empresa' });
  }
}

// EJECUTAR SCRAPING
async function handleEjecutarScraping(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const admin = verificarToken(req.headers.authorization);
  if (!admin) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const githubToken = process.env.GITHUB_TOKEN;
    const repo = 'umbusk1/compita';
    const workflow = 'scraping-diario.yml';

    const response = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'Authorization': `Bearer ${githubToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ref: 'main' })
      }
    );

    if (response.status === 204) {
      console.log(`[ADMIN] Scraping ejecutado manualmente por admin ${admin.email}`);
      return res.json({
        success: true,
        mensaje: 'Scraping iniciado correctamente. Revisa GitHub Actions para ver el progreso.'
      });
    } else {
      const error = await response.text();
      console.error('Error de GitHub:', error);
      return res.status(500).json({ error: 'Error al ejecutar scraping' });
    }
  } catch (error) {
    console.error('Error ejecutando scraping:', error);
    return res.status(500).json({ error: 'Error al ejecutar scraping' });
  }
}

// EJECUTAR ANÁLISIS
async function handleEjecutarAnalisis(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const admin = verificarToken(req.headers.authorization);
  if (!admin) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const githubToken = process.env.GITHUB_TOKEN;
    const repo = 'umbusk1/compita';
    const workflow = 'analisis-diario.yml';

    const response = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'Authorization': `Bearer ${githubToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ref: 'main' })
      }
    );

    if (response.status === 204) {
      console.log(`[ADMIN] Análisis ejecutado manualmente por admin ${admin.email}`);
      return res.json({
        success: true,
        mensaje: 'Análisis iniciado correctamente. Revisa GitHub Actions para ver el progreso.'
      });
    } else {
      const error = await response.text();
      console.error('Error de GitHub:', error);
      return res.status(500).json({ error: 'Error al ejecutar análisis' });
    }
  } catch (error) {
    console.error('Error ejecutando análisis:', error);
    return res.status(500).json({ error: 'Error al ejecutar análisis' });
  }
}

// INVITAR ADMINISTRADOR
async function handleInvitarAdmin(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const admin = verificarToken(req.headers.authorization);
  if (!admin) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  // Solo superadmins pueden invitar otros administradores
  if (admin.rol !== 'superadmin') {
    return res.status(403).json({ error: 'Solo los superadministradores pueden invitar otros administradores' });
  }

  const { nombre, email, password, rol } = req.body;

  if (!nombre || !email || !password || !rol) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }

  if (!['admin', 'superadmin'].includes(rol)) {
    return res.status(400).json({ error: 'Rol inválido. Use "admin" o "superadmin"' });
  }

  try {
    // Verificar que el email no esté registrado
    const emailExiste = await pool.query(
      'SELECT id FROM administradores WHERE email = $1',
      [email.toLowerCase()]
    );

    if (emailExiste.rows.length > 0) {
      return res.status(400).json({ error: 'Este email ya está registrado como administrador' });
    }

    // Hash de la contraseña
    const passwordHash = await bcrypt.hash(password, 10);

    // Crear administrador
    const result = await pool.query(`
      INSERT INTO administradores (
        nombre,
        email,
        password_hash,
        rol,
        activo,
        invitado_por
      ) VALUES ($1, $2, $3, $4, true, $5)
      RETURNING id
    `, [nombre, email.toLowerCase(), passwordHash, rol, admin.id]);

    const nuevoAdminId = result.rows[0].id;

    console.log(`[ADMIN] Nuevo administrador creado: ${nombre} (${rol}) por ${admin.email}`);

    // Enviar email con credenciales
    try {
      const resendApiKey = process.env.RESEND_API_KEY;
      if (resendApiKey) {
        const emailResponse = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${resendApiKey}`
          },
          body: JSON.stringify({
            from: 'Compita <no-reply@compita.umbusk.com>',
            to: [email],
            subject: '🔐 Acceso al Dashboard Admin de Compita',
            html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px"><div style="background:linear-gradient(135deg,#9333ea 0%,#7c3aed 100%);padding:30px;text-align:center;border-radius:10px 10px 0 0"><h1 style="color:white;margin:0">🔐 Acceso Admin - Compita</h1></div><div style="background:#f9fafb;padding:30px;border-radius:0 0 10px 10px"><p>Hola <strong>${nombre}</strong>,</p><p>Has sido invitado como <strong>${rol === 'superadmin' ? 'Superadministrador' : 'Administrador'}</strong> del sistema Compita.</p><div style="background:white;border-left:4px solid #9333ea;padding:20px;margin:20px 0;border-radius:5px"><h3 style="margin-top:0;color:#9333ea">📋 Tus credenciales:</h3><p><strong>Email:</strong> ${email}</p><p><strong>Contraseña temporal:</strong> <code style="background:#f3f4f6;padding:5px 10px;border-radius:4px">${password}</code></p><p><strong>Rol:</strong> ${rol === 'superadmin' ? 'Superadministrador' : 'Administrador'}</p></div><div style="text-align:center;margin:30px 0"><a href="https://compita.umbusk.com/admin-login.html" style="background:#9333ea;color:white;padding:15px 30px;text-decoration:none;border-radius:5px;font-weight:bold;display:inline-block">🔐 Acceder al Dashboard</a></div><div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:15px;margin:20px 0;border-radius:5px"><p style="margin:0;font-size:14px"><strong>⚠️ Importante:</strong> Cambia tu contraseña en el primer inicio de sesión.</p></div></div></body></html>`
          })
        });

        if (emailResponse.ok) {
          console.log(`[EMAIL] Credenciales de admin enviadas a ${email}`);
        }
      }
    } catch (emailError) {
      console.error('Error enviando email:', emailError);
    }

    return res.json({
      success: true,
      admin_id: nuevoAdminId,
      mensaje: 'Administrador invitado exitosamente'
    });

  } catch (error) {
    console.error('Error al invitar administrador:', error);
    return res.status(500).json({ error: 'Error al invitar administrador' });
  }
}