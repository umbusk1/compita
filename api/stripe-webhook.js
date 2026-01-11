// api/stripe-webhook.js - Recibir eventos de Stripe
import Stripe from 'stripe';
import pkg from 'pg';
const { Pool } = pkg;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export const config = {
  api: {
    bodyParser: false, // Desactivar body parser para verificar firma de Stripe
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    // Leer el body raw
    const rawBody = await getRawBody(req);

    // Verificar la firma del webhook
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('❌ Error verificando webhook:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  console.log('📨 Evento recibido de Stripe:', event.type);

  try {
    // Manejar diferentes tipos de eventos
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;

      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object);
        break;

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;

      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object);
        break;

      default:
        console.log(`ℹ️ Evento no manejado: ${event.type}`);
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('❌ Error procesando webhook:', error);
    return res.status(500).json({ error: 'Error procesando evento' });
  }
}

// ============================================================================
// FUNCIONES PARA MANEJAR EVENTOS
// ============================================================================

async function handleCheckoutCompleted(session) {
  console.log('✅ Checkout completado:', session.id);

  const empresaId = session.metadata.empresa_id;
  const plan = session.metadata.plan;
  const subscriptionId = session.subscription;

  if (!empresaId || !plan) {
    console.error('❌ Metadata faltante en checkout session');
    return;
  }

  // Actualizar empresa: activar y asignar plan
  await pool.query(
    `UPDATE empresas
     SET plan = $1,
         activo = true,
         stripe_customer_id = $2,
         stripe_subscription_id = $3
     WHERE id = $4`,
    [plan, session.customer, subscriptionId, empresaId]
  );

  console.log(`✅ Empresa ${empresaId} activada con plan ${plan}`);
}

async function handleSubscriptionCreated(subscription) {
  console.log('🆕 Suscripción creada:', subscription.id);

  const customerId = subscription.customer;

  // Buscar empresa por customer_id
  const result = await pool.query(
    `SELECT id FROM empresas WHERE stripe_customer_id = $1`,
    [customerId]
  );

  if (result.rows.length === 0) {
    console.error('❌ Empresa no encontrada para customer:', customerId);
    return;
  }

  const empresaId = result.rows[0].id;

  // Actualizar subscription_id
  await pool.query(
    `UPDATE empresas
     SET stripe_subscription_id = $1,
         activo = true
     WHERE id = $2`,
    [subscription.id, empresaId]
  );

  console.log(`✅ Suscripción ${subscription.id} vinculada a empresa ${empresaId}`);
}

async function handleSubscriptionUpdated(subscription) {
  console.log('🔄 Suscripción actualizada:', subscription.id);

  const customerId = subscription.customer;
  const status = subscription.status; // active, past_due, canceled, etc.

  // 🆕 NUEVO: Extraer el plan actual de la suscripción
  const priceId = subscription.items.data[0]?.price.id;
  let plan = null;

  // Mapear price_id de Stripe a nuestros nombres de plan
  if (priceId === process.env.STRIPE_PRICE_ESTANDAR) {
    plan = 'estandar';
  } else if (priceId === process.env.STRIPE_PRICE_BUSINESS) {
    plan = 'business';
  }

  // Buscar empresa
  const result = await pool.query(
    `SELECT id FROM empresas WHERE stripe_customer_id = $1`,
    [customerId]
  );

  if (result.rows.length === 0) {
    console.error('❌ Empresa no encontrada para customer:', customerId);
    return;
  }

  const empresaId = result.rows[0].id;

  // Determinar si la empresa debe estar activa
  const activo = ['active', 'trialing'].includes(status);

  // 🆕 MODIFICADO: Actualizar también el plan
  if (plan) {
    await pool.query(
      `UPDATE empresas
       SET activo = $1,
           plan = $2
       WHERE id = $3`,
      [activo, plan, empresaId]
    );
    console.log(`✅ Empresa ${empresaId} - Plan: ${plan}, Estado: ${activo ? 'Activa' : 'Inactiva'}`);
  } else {
    // Si no pudimos determinar el plan, solo actualizamos activo
    await pool.query(
      `UPDATE empresas
       SET activo = $1
       WHERE id = $2`,
      [activo, empresaId]
    );
    console.log(`✅ Empresa ${empresaId} - Estado: ${activo ? 'Activa' : 'Inactiva'}`);
  }
}

async function handleSubscriptionDeleted(subscription) {
  console.log('❌ Suscripción cancelada:', subscription.id);

  const customerId = subscription.customer;

  // Buscar empresa
  const result = await pool.query(
    `SELECT id FROM empresas WHERE stripe_customer_id = $1`,
    [customerId]
  );

  if (result.rows.length === 0) {
    console.error('❌ Empresa no encontrada para customer:', customerId);
    return;
  }

  const empresaId = result.rows[0].id;

  // Desactivar empresa
  await pool.query(
    `UPDATE empresas
     SET activo = false,
         plan = 'cancelado'
     WHERE id = $1`,
    [empresaId]
  );

  console.log(`❌ Empresa ${empresaId} desactivada por cancelación`);
}

async function handlePaymentSucceeded(invoice) {
  console.log('💰 Pago exitoso:', invoice.id);

  const customerId = invoice.customer;

  // Buscar empresa
  const result = await pool.query(
    `SELECT id FROM empresas WHERE stripe_customer_id = $1`,
    [customerId]
  );

  if (result.rows.length === 0) {
    console.error('❌ Empresa no encontrada para customer:', customerId);
    return;
  }

  const empresaId = result.rows[0].id;

  // Asegurar que la empresa está activa
  await pool.query(
    `UPDATE empresas
     SET activo = true
     WHERE id = $1`,
    [empresaId]
  );

  console.log(`💰 Pago procesado para empresa ${empresaId}`);
}

// ============================================================================
// UTILIDAD: Leer body raw
// ============================================================================
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    req.on('data', chunk => {
      buffer += chunk;
    });
    req.on('end', () => {
      resolve(buffer);
    });
    req.on('error', err => {
      reject(err);
    });
  });
}