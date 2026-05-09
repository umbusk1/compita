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

  // 🆕 CORREGIDO: Buscar el item activo (quantity > 0)
  const activeItem = subscription.items.data.find(item => item.quantity > 0);
  const priceId = activeItem?.price.id;
  let plan = null;

  // Mapear price_id de Stripe a nuestros nombres de plan
  if (priceId === process.env.STRIPE_PRICE_ESTANDAR) {
      plan = 'estandar';
    } else if (priceId === process.env.STRIPE_PRICE_BUSINESS) {
      plan = 'business';
    } else if (priceId === process.env.STRIPE_PRICE_ENTERPRISE_GOLD) {
      plan = 'enterprise_gold';
    } else if (priceId === process.env.STRIPE_PRICE_ENTERPRISE_PLATINUM) {
      plan = 'enterprise_platinum';
  }

  console.log(`📊 Price ID detectado: ${priceId} → Plan: ${plan}`);

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

  // Actualizar también el plan
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
    console.log(`⚠️ Empresa ${empresaId} - Plan no identificado. Estado: ${activo ? 'Activa' : 'Inactiva'}`);
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

  // ========== RECOMPENSA AL REFERIDOR ==========
  try {
    // Buscar si hay un referido pendiente para esta empresa
    const referidoRes = await pool.query(
      `SELECT r.id, r.referidor_id
       FROM referidos r
       JOIN usuarios u ON u.empresa_id = $1
       WHERE r.referido_id = u.id AND r.estado = 'pendiente'
       LIMIT 1`,
      [empresaId]
    );

    if (referidoRes.rows.length > 0) {
      const { id: referidoId, referidor_id } = referidoRes.rows[0];

      // Obtener datos del referidor
      const referidorRes = await pool.query(
        `SELECT e.id as empresa_id, e.plan, e.trial_fin,
                e.stripe_customer_id, u.email
         FROM usuarios u
         JOIN empresas e ON e.id = u.empresa_id
         WHERE u.id = $1
         LIMIT 1`,
        [referidor_id]
      );

      if (referidorRes.rows.length > 0) {
        const referidor = referidorRes.rows[0];

        if (referidor.plan === 'free_trial') {
          // Referidor en trial → extender 30 días
          await pool.query(
            `UPDATE empresas
             SET trial_fin = trial_fin + INTERVAL '30 days'
             WHERE id = $1`,
            [referidor.empresa_id]
          );
          console.log(`🎁 Referidor ${referidor.email} — trial extendido 30 días`);

        } else if (referidor.stripe_customer_id) {
          // Referidor con plan pago → crédito en Stripe para el próximo mes
          const creditAmounts = { estandar: 1000, business: 2000, enterprise_gold: 4000, enterprise_platinum: 8000 }; // centavos USD
          const creditAmount = creditAmounts[referidor.plan] || 1000;

          await stripe.customers.createBalanceTransaction(
            referidor.stripe_customer_id,
            {
              amount: -creditAmount, // negativo = crédito a favor
              currency: 'usd',
              description: `Recompensa por referido — 1 mes gratis`
            }
          );
          console.log(`🎁 Referidor ${referidor.email} — crédito $${creditAmount/100} aplicado en Stripe`);
        }

        // Marcar referido como completado
        await pool.query(
          `UPDATE referidos
           SET estado = 'completado', recompensa_aplicada_at = NOW()
           WHERE id = $1`,
          [referidoId]
        );

        console.log(`✅ Referido ${referidoId} marcado como completado`);
      }
    }
  } catch (refError) {
    console.error('❌ Error aplicando recompensa de referido:', refError);
    // No bloqueamos el flujo principal si falla la recompensa
  }
  // ========== FIN RECOMPENSA AL REFERIDOR ==========

}

// ============================================================================
// UTILIDAD: Leer body raw  ← REEMPLAZA la función anterior completa
// ============================================================================
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}