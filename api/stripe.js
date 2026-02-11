// api/stripe.js - Endpoint consolidado para Stripe (Checkout + Portal + Cupos)
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
const { Pool } = pkg;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
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
    const { action, plan, tipo } = req.body;

    // Validar que venga el action
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
      // Validar plan
      if (!plan || !['estandar', 'business'].includes(plan)) {
        return res.status(400).json({ error: 'Plan inválido. Use: estandar o business' });
      }

      // Determinar el Price ID según el plan
      const priceId = plan === 'estandar'
        ? process.env.STRIPE_PRICE_ESTANDAR
        : process.env.STRIPE_PRICE_BUSINESS;

      // Crear o recuperar Customer en Stripe
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

        // Guardar customer_id en BD
        await pool.query(
          'UPDATE empresas SET stripe_customer_id = $1 WHERE id = $2',
          [customerId, empresaId]
        );
      }

      // Crear sesión de Checkout
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        mode: 'subscription',
        success_url: `${req.headers.origin}/oportunidades.html?checkout=success`,
        cancel_url: `${req.headers.origin}/cuenta.html?checkout=cancelled`,
        metadata: {
          empresa_id: empresaId.toString(),
          user_id: userId.toString(),
          plan: plan
        }
      });

      return res.status(200).json({
        success: true,
        checkout_url: session.url
      });
    }

    // ====================================================
    // ACCIÓN 2: Abrir Customer Portal
    // ====================================================
    if (action === 'create_portal') {
      // Validar que tenga customer_id
      if (!customerId) {
        // Buscar en Stripe por email
        const customers = await stripe.customers.list({
          email: user.email,
          limit: 1
        });

        if (customers.data.length === 0) {
          return res.status(404).json({
            error: 'No tienes una cuenta de facturación activa. Suscríbete primero a un plan.'
          });
        }

        customerId = customers.data[0].id;

        // Actualizar BD
        await pool.query(
          'UPDATE empresas SET stripe_customer_id = $1 WHERE id = $2',
          [customerId, empresaId]
        );
      }

      // Crear sesión del Portal de Facturación
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${req.headers.origin}/cuenta.html`
      });

      return res.status(200).json({
        success: true,
        portal_url: session.url
      });
    }

    // ====================================================
    // ACCIÓN 3: Comprar cupos adicionales
    // ====================================================
    if (action === 'comprar_cupos') {
      // Validar tipo de cupo
      if (!tipo || !['zip', 'analisis'].includes(tipo)) {
        return res.status(400).json({ error: 'Tipo inválido. Use: zip o analisis' });
      }

      // Determinar el Price ID según el tipo
      const priceId = tipo === 'zip'
        ? process.env.STRIPE_PRICE_CUPOS_ZIP
        : process.env.STRIPE_PRICE_CUPOS_ANALISIS;

      if (!priceId) {
        return res.status(500).json({
          error: 'Configuración incompleta. Contacta a soporte.'
        });
      }

      // Crear o recuperar Customer en Stripe
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

        // Guardar customer_id en BD
        await pool.query(
          'UPDATE empresas SET stripe_customer_id = $1 WHERE id = $2',
          [customerId, empresaId]
        );
      }

      // Crear sesión de Checkout para cupos
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        mode: 'payment', // ✅ Pago único, no suscripción
        success_url: `${req.headers.origin}/oportunidades.html?cupos=success&tipo=${tipo}`,
        cancel_url: `${req.headers.origin}/oportunidades.html?cupos=cancelled`,
        metadata: {
          empresa_id: empresaId.toString(),
          user_id: userId.toString(),
          tipo_cupo: tipo, // 'zip' o 'analisis'
          accion: 'comprar_cupos'
        }
      });

      return res.status(200).json({
        success: true,
        checkout_url: session.url
      });
    }

    // Si llegamos aquí, el action no es válido
    return res.status(400).json({
      error: 'Acción inválida. Use: create_checkout, create_portal o comprar_cupos'
    });

  } catch (error) {
    console.error('Error en endpoint Stripe:', error);
    return res.status(500).json({
      error: 'Error al procesar solicitud',
      detalles: error.message
    });
  }
}