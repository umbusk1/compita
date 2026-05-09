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

export const config = {
  api: { bodyParser: false },
};

function getFirstDayOfNextMonth() {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  return Math.floor(nextMonth.getTime() / 1000);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Stripe-Signature');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const sig = req.headers['stripe-signature'];
  if (sig && webhookSecret) return await handleWebhook(req, res);
  return await handleAction(req, res);
}

// ====================================================
// WEBHOOK
// ====================================================
async function handleWebhook(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  let event;

  try {
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, req.headers['stripe-signature'], webhookSecret);
  } catch (err) {
    console.error('❌ Error verificando webhook:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      if (session.metadata?.accion === 'comprar_cupos') {
        const empresaId = parseInt(session.metadata.empresa_id);
        const tipoCupo  = session.metadata.tipo_cupo;

        const primerDiaMes = new Date();
        primerDiaMes.setDate(1); primerDiaMes.setHours(0, 0, 0, 0);
        const mesActual = primerDiaMes.toISOString().split('T')[0];

        const existe = await sql`
          SELECT id FROM uso_mensual WHERE empresa_id = ${empresaId} AND mes = ${mesActual}
        `;
        if (existe.length === 0) {
          await sql`
            INSERT INTO uso_mensual
              (empresa_id, mes, descargas_zip_usadas, analisis_ia_usados,
               zip_adicionales, analisis_adicionales, zip_limite_mes, analisis_limite_mes)
            VALUES (${empresaId}, ${mesActual}, 0, 0, 0, 0, 10, 5)
          `;
        }

        if (tipoCupo === 'zip') {
          await sql`UPDATE uso_mensual SET zip_adicionales = COALESCE(zip_adicionales,0) + 10,
            updated_at = CURRENT_TIMESTAMP WHERE empresa_id = ${empresaId} AND mes = ${mesActual}`;
          console.log(`✅ +10 cupos ZIP → empresa ${empresaId}`);

        } else if (tipoCupo === 'analisis') {
          await sql`UPDATE uso_mensual SET analisis_adicionales = COALESCE(analisis_adicionales,0) + 5,
            updated_at = CURRENT_TIMESTAMP WHERE empresa_id = ${empresaId} AND mes = ${mesActual}`;
          console.log(`✅ +5 cupos Análisis → empresa ${empresaId}`);

        } else if (tipoCupo === 'agente_033') {
          await sql`UPDATE uso_mensual SET agente_033_adicionales = COALESCE(agente_033_adicionales,0) + 5,
            updated_at = CURRENT_TIMESTAMP WHERE empresa_id = ${empresaId} AND mes = ${mesActual}`;
          console.log(`✅ +5 cupos Agente 033 → empresa ${empresaId}`);

        } else if (tipoCupo === 'agente_sprint') {
          await sql`UPDATE uso_mensual SET agente_sprint_adicionales = COALESCE(agente_sprint_adicionales,0) + 5,
            updated_at = CURRENT_TIMESTAMP WHERE empresa_id = ${empresaId} AND mes = ${mesActual}`;
          console.log(`✅ +5 cupos Agente Sprint → empresa ${empresaId}`);
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
// ACCIONES NORMALES
// ====================================================
async function handleAction(req, res) {
  let body = req.body;
  if (Buffer.isBuffer(body)) body = JSON.parse(body.toString());

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token no proporcionado' });

  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }

  const userId   = decoded.userId;
  const empresaId = decoded.empresaId;

  try {
    const { action, plan, tipo } = body;
    if (!action) return res.status(400).json({ error: 'Falta parámetro "action"' });

    const userResult = await pool.query(
      `SELECT u.email, u.empresa_id, e.nombre as empresa_nombre,
              e.stripe_customer_id, e.stripe_subscription_id
       FROM usuarios u JOIN empresas e ON u.empresa_id = e.id WHERE u.id = $1`,
      [userId]
    );
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    const user = userResult.rows[0];
    let customerId = user.stripe_customer_id;

    // Helper: crear o reutilizar cliente Stripe
    async function asegurarCliente() {
      if (customerId) return;
      const existing = await stripe.customers.list({ email: user.email, limit: 1 });
      if (existing.data.length > 0) {
        customerId = existing.data[0].id;
      } else {
        const c = await stripe.customers.create({
          email: user.email,
          metadata: { empresa_id: empresaId.toString(), user_id: userId.toString(), empresa_nombre: user.empresa_nombre }
        });
        customerId = c.id;
      }
      await pool.query('UPDATE empresas SET stripe_customer_id = $1 WHERE id = $2', [customerId, empresaId]);
    }

    // ====================================================
    // ACCIÓN 1: Crear sesión de Checkout (planes)
    // ====================================================
    if (action === 'create_checkout') {

      const planesValidos = ['estandar', 'business', 'enterprise_gold', 'enterprise_platinum'];
      if (!plan || !planesValidos.includes(plan)) {
        return res.status(400).json({ error: 'Plan inválido' });
      }

      const preciosPorPlan = {
        estandar:            process.env.STRIPE_PRICE_ESTANDAR,
        business:            process.env.STRIPE_PRICE_BUSINESS,
        enterprise_gold:     process.env.STRIPE_PRICE_ENTERPRISE_GOLD,
        enterprise_platinum: process.env.STRIPE_PRICE_ENTERPRISE_PLATINUM,
      };
      const priceId = preciosPorPlan[plan];
      if (!priceId) return res.status(500).json({ error: 'Precio no configurado para este plan' });

      await asegurarCliente();

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: 'subscription',
        success_url: `${req.headers.origin}/oportunidades.html?checkout=success`,
        cancel_url:  `${req.headers.origin}/cuenta.html?checkout=cancelled`,
        subscription_data: {
          billing_cycle_anchor: getFirstDayOfNextMonth(),
          proration_behavior: 'create_prorations',
          // Trial de 7 días solo para Plan Business
          ...(plan === 'business' && { trial_period_days: 7 }),
        },
        metadata: {
          empresa_id: empresaId.toString(),
          user_id:    userId.toString(),
          plan
        }
      });

      return res.status(200).json({ success: true, checkout_url: session.url });
    }

    // ====================================================
    // ACCIÓN 2: Abrir Customer Portal
    // ====================================================
    if (action === 'create_portal') {
      if (!customerId) {
        const customers = await stripe.customers.list({ email: user.email, limit: 1 });
        if (customers.data.length === 0) {
          return res.status(404).json({ error: 'No tienes cuenta de facturación. Suscríbete primero.' });
        }
        customerId = customers.data[0].id;
        await pool.query('UPDATE empresas SET stripe_customer_id = $1 WHERE id = $2', [customerId, empresaId]);
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

      const tiposValidos = ['zip', 'analisis', 'agente_033', 'agente_sprint'];
      if (!tipo || !tiposValidos.includes(tipo)) {
        return res.status(400).json({ error: 'Tipo inválido' });
      }

      const preciosPorTipo = {
        zip:           process.env.STRIPE_PRICE_CUPOS_ZIP,
        analisis:      process.env.STRIPE_PRICE_CUPOS_ANALISIS,
        agente_033:    process.env.STRIPE_PRICE_ADDON_033,
        agente_sprint: process.env.STRIPE_PRICE_ADDON_SPRINT,
      };
      const priceId = preciosPorTipo[tipo];
      if (!priceId) return res.status(500).json({ error: 'Configuración incompleta. Contacta a soporte.' });

      await asegurarCliente();

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: 'payment',
        success_url: `${req.headers.origin}/oportunidades.html?cupos=success&tipo=${tipo}`,
        cancel_url:  `${req.headers.origin}/oportunidades.html?cupos=cancelled`,
        metadata: {
          empresa_id: empresaId.toString(),
          user_id:    userId.toString(),
          tipo_cupo:  tipo,
          accion:     'comprar_cupos'
        }
      });

      return res.status(200).json({ success: true, checkout_url: session.url });
    }

    return res.status(400).json({ error: 'Acción inválida' });

  } catch (error) {
    console.error('Error en stripe.js:', error);
    return res.status(500).json({ error: 'Error al procesar solicitud', detalles: error.message });
  }
}

async function buffer(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}