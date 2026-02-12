// api/stripe.js - Endpoint consolidado: Checkout + Portal + Cupos + Webhook
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
import { neon } from '@neondatabase/serverless';

const { Pool } = pkg;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Configuración especial para el webhook
export const config = {
  api: {
    bodyParser: false, // Desactivar para procesar webhooks de Stripe
  },
};

// ====================================================
// HELPER: Calcular primer día del mes siguiente
// ====================================================
function getFirstDayOfNextMonth() {
  const now = new Date();
  // Crear fecha del primer día del mes siguiente
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  // Retornar timestamp Unix en segundos (Stripe lo requiere así)
  return Math.floor(nextMonth.getTime() / 1000);
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Stripe-Signature');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  // ====================================================
  // DETECTAR SI ES UN WEBHOOK DE STRIPE
  // ====================================================
  const sig = req.headers['stripe-signature'];

  if (sig && webhookSecret) {
    return await handleWebhook(req, res);
  }

  // ====================================================
  // ACCIONES NORMALES (con JWT)
  // ====================================================
  return await handleAction(req, res);
}

// ====================================================
// HANDLER: Webhook de Stripe
// ====================================================
async function handleWebhook(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  let event;

  try {
    // Leer raw body
    const buf = await buffer(req);
    const sig = req.headers['stripe-signature'];

    // Verificar firma
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.error('❌ Error verificando webhook:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  // Procesar evento
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // Verificar si es compra de cupos
      if (session.metadata?.accion === 'comprar_cupos') {
        const empresaId = parseInt(session.metadata.empresa_id);
        const tipoCupo = session.metadata.tipo_cupo;

        // Obtener mes actual
        const primerDiaMes = new Date();
        primerDiaMes.setDate(1);
        primerDiaMes.setHours(0, 0, 0, 0);
        const mesActual = primerDiaMes.toISOString().split('T')[0];

        // Asegurar que existe el registro del mes
        const existe = await sql`
          SELECT id FROM uso_mensual
          WHERE empresa_id = ${empresaId} AND mes = ${mesActual}
        `;

        if (existe.length === 0) {
          await sql`
            INSERT INTO uso_mensual (empresa_id, mes, descargas_zip_usadas, analisis_ia_usados, zip_adicionales, analisis_adicionales, zip_limite_mes, analisis_limite_mes)
            VALUES (${empresaId}, ${mesActual}, 0, 0, 0, 0, 10, 5)
          `;
        }

        // Incrementar cupos adicionales
        if (tipoCupo === 'zip') {
          await sql`
            UPDATE uso_mensual
            SET zip_adicionales = COALESCE(zip_adicionales, 0) + 10,
                updated_at = CURRENT_TIMESTAMP
            WHERE empresa_id = ${empresaId} AND mes = ${mesActual}
          `;

          console.log(`✅ Agregados 10 cupos ZIP a empresa ${empresaId}`);
        } else if (tipoCupo === 'analisis') {
          await sql`
            UPDATE uso_mensual
            SET analisis_adicionales = COALESCE(analisis_adicionales, 0) + 5,
                updated_at = CURRENT_TIMESTAMP
            WHERE empresa_id = ${empresaId} AND mes = ${mesActual}
          `;

          console.log(`✅ Agregados 5 cupos análisis a empresa ${empresaId}`);
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('❌ Error procesando webhook:', error);
    return res.status(500).json({ error: 'Error procesando pago' });
  }
}

// ====================================================
// HANDLER: Acciones normales (create_checkout, etc)
// ====================================================
async function handleAction(req, res) {
  // Parse body manualmente si viene como buffer
  let body = req.body;
  if (Buffer.isBuffer(body)) {
    body = JSON.parse(body.toString());
  }

  // Verificar JWT Token
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }

  const token = authHeader.split(' ')[1];
  let decoded;

  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }

  const userId = decoded.userId;
  const empresaId = decoded.empresaId;

  try {
    const { action, plan, tipo } = body;

    if (!action) {
      return res.status(400).json({ error: 'Falta parámetro "action"' });
    }

    // Obtener datos del usuario y empresa
    const userResult = await pool.query(
      `SELECT u.email, u.empresa_id, e.nombre as empresa_nombre,
              e.stripe_customer_id, e.stripe_subscription_id
       FROM usuarios u
       JOIN empresas e ON u.empresa_id = e.id
       WHERE u.id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const user = userResult.rows[0];
    let customerId = user.stripe_customer_id;

    // ====================================================
    // ACCIÓN 1: Crear sesión de Checkout (planes)
    // ====================================================
    if (action === 'create_checkout') {
      if (!plan || !['estandar', 'business'].includes(plan)) {
        return res.status(400).json({ error: 'Plan inválido' });
      }

      const priceId = plan === 'estandar'
        ? process.env.STRIPE_PRICE_ESTANDAR
        : process.env.STRIPE_PRICE_BUSINESS;

      if (!customerId) {
        const existingCustomers = await stripe.customers.list({
          email: user.email,
          limit: 1
        });

        if (existingCustomers.data.length > 0) {
          customerId = existingCustomers.data[0].id;
        } else {
          const customer = await stripe.customers.create({
            email: user.email,
            metadata: {
              empresa_id: empresaId.toString(),
              user_id: userId.toString(),
              empresa_nombre: user.empresa_nombre
            }
          });
          customerId = customer.id;
        }

        await pool.query(
          'UPDATE empresas SET stripe_customer_id = $1 WHERE id = $2',
          [customerId, empresaId]
        );
      }

      // NUEVO: Crear sesión con billing cycle anclado al 1ro del mes
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: 'subscription',
        success_url: `${req.headers.origin}/oportunidades.html?checkout=success`,
        cancel_url: `${req.headers.origin}/cuenta.html?checkout=cancelled`,
        subscription_data: {
          // Anclar el billing cycle al 1ro del mes siguiente
          billing_cycle_anchor: getFirstDayOfNextMonth(),
          // Habilitar prorrateo automático
          proration_behavior: 'create_prorations',
        },
        metadata: {
          empresa_id: empresaId.toString(),
          user_id: userId.toString(),
          plan: plan
        }
      });

      return res.status(200).json({ success: true, checkout_url: session.url });
    }

    // ====================================================
    // ACCIÓN 2: Abrir Customer Portal
    // ====================================================
    if (action === 'create_portal') {
      if (!customerId) {
        const customers = await stripe.customers.list({
          email: user.email,
          limit: 1
        });

        if (customers.data.length === 0) {
          return res.status(404).json({
            error: 'No tienes cuenta de facturación. Suscríbete primero.'
          });
        }

        customerId = customers.data[0].id;
        await pool.query(
          'UPDATE empresas SET stripe_customer_id = $1 WHERE id = $2',
          [customerId, empresaId]
        );
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${req.headers.origin}/cuenta.html`
      });

      return res.status(200).json({ success: true, portal_url: session.url });
    }

    // ====================================================
    // ACCIÓN 3: Comprar cupos adicionales
    // ====================================================
    if (action === 'comprar_cupos') {
      if (!tipo || !['zip', 'analisis'].includes(tipo)) {
        return res.status(400).json({ error: 'Tipo inválido. Use: zip o analisis' });
      }

      const priceId = tipo === 'zip'
        ? process.env.STRIPE_PRICE_CUPOS_ZIP
        : process.env.STRIPE_PRICE_CUPOS_ANALISIS;

      if (!priceId) {
        return res.status(500).json({
          error: 'Configuración incompleta. Contacta a soporte.'
        });
      }

      if (!customerId) {
        const existingCustomers = await stripe.customers.list({
          email: user.email,
          limit: 1
        });

        if (existingCustomers.data.length > 0) {
          customerId = existingCustomers.data[0].id;
        } else {
          const customer = await stripe.customers.create({
            email: user.email,
            metadata: {
              empresa_id: empresaId.toString(),
              user_id: userId.toString(),
              empresa_nombre: user.empresa_nombre
            }
          });
          customerId = customer.id;
        }

        await pool.query(
          'UPDATE empresas SET stripe_customer_id = $1 WHERE id = $2',
          [customerId, empresaId]
        );
      }

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: 'payment',
        success_url: `${req.headers.origin}/oportunidades.html?cupos=success&tipo=${tipo}`,
        cancel_url: `${req.headers.origin}/oportunidades.html?cupos=cancelled`,
        metadata: {
          empresa_id: empresaId.toString(),
          user_id: userId.toString(),
          tipo_cupo: tipo,
          accion: 'comprar_cupos'
        }
      });

      return res.status(200).json({ success: true, checkout_url: session.url });
    }

    return res.status(400).json({
      error: 'Acción inválida. Use: create_checkout, create_portal o comprar_cupos'
    });

  } catch (error) {
    console.error('Error en stripe.js:', error);
    return res.status(500).json({
      error: 'Error al procesar solicitud',
      detalles: error.message
    });
  }
}

// Helper para leer raw body
async function buffer(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}