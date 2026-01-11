// api/stripe-checkout.js - Crear sesión de pago con Stripe
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
    const { plan } = req.body;

    // Validar plan
    if (!plan || !['estandar', 'business'].includes(plan)) {
      return res.status(400).json({ error: 'Plan inválido. Use: estandar o business' });
    }

    // Obtener datos del usuario y empresa
    const userResult = await pool.query(
      `SELECT u.email, e.nombre as empresa_nombre
       FROM usuarios u
       JOIN empresas e ON u.empresa_id = e.id
       WHERE u.id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const user = userResult.rows[0];

    // Determinar el Price ID según el plan
    const priceId = plan === 'estandar'
      ? process.env.STRIPE_PRICE_ESTANDAR
      : process.env.STRIPE_PRICE_BUSINESS;

    // Crear o recuperar Customer en Stripe
    let customer;
    const existingCustomers = await stripe.customers.list({
      email: user.email,
      limit: 1
    });

    if (existingCustomers.data.length > 0) {
      customer = existingCustomers.data[0];
    } else {
      customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          empresa_id: empresaId.toString(),
          user_id: userId.toString(),
          empresa_nombre: user.empresa_nombre
        }
      });
    }

    // Crear sesión de Checkout
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${req.headers.origin}/oportunidades.html?pago=exitoso`,
      cancel_url: `${req.headers.origin}/registro.html?plan=${plan}&pago=cancelado`,
      metadata: {
        empresa_id: empresaId.toString(),
        user_id: userId.toString(),
        plan: plan
      }
    });

    return res.status(200).json({
      checkout_url: session.url
    });

  } catch (error) {
    console.error('Error creando sesión de checkout:', error);
    return res.status(500).json({ error: 'Error al crear sesión de pago' });
  }
}