// api/stripe-portal.js - Portal de facturación de Stripe
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

  try {
    // Obtener empresa y stripe_customer_id del usuario
    const userResult = await pool.query(
      `SELECT u.email, u.empresa_id, e.stripe_customer_id, e.stripe_subscription_id
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

    // Extraer action del body (necesario para la lógica siguiente)
    const { action, plan } = req.body;

    // Si no tenemos el customer_id en la BD, buscarlo o crearlo en Stripe
    if (!customerId) {
      const customers = await stripe.customers.list({
        email: user.email,
        limit: 1
      });

      if (customers.data.length === 0) {
        // Si no existe y estamos haciendo checkout, crear el customer
        if (action === 'create_checkout') {
          const newCustomer = await stripe.customers.create({
            email: user.email,
            metadata: {
              empresa_id: user.empresa_id.toString()
            }
          });
          customerId = newCustomer.id;

          // Guardar el customer_id en la BD
          await pool.query(
            'UPDATE empresas SET stripe_customer_id = $1 WHERE id = $2',
            [customerId, user.empresa_id]
          );
        } else {
          // Para otras acciones (como portal), devolver error
          return res.status(404).json({
            error: 'No tienes una cuenta de facturación activa. Suscríbete primero a un plan.'
          });
        }
      } else {
        customerId = customers.data[0].id;

        // Actualizar la BD con el customer_id encontrado
        await pool.query(
          'UPDATE empresas SET stripe_customer_id = $1 WHERE id = $2',
          [customerId, user.empresa_id]
        );
      }
    }

    // ====== NUEVA FUNCIONALIDAD: Crear Checkout Session ======
    if (action === 'create_checkout') {
      // Validar plan
      if (!plan || !['estandar', 'business'].includes(plan)) {
        return res.status(400).json({ error: 'Plan inválido' });
      }

      // Determinar el Price ID según el plan
      const priceId = plan === 'estandar'
        ? process.env.STRIPE_PRICE_ESTANDAR
        : process.env.STRIPE_PRICE_BUSINESS;

	// Crear Checkout Session
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
		empresa_id: user.empresa_id.toString(),
		plan: plan
	  }
	});
    }

    // ====== FUNCIONALIDAD ORIGINAL: Abrir Customer Portal ======
    // Configuración para crear el portal
    const portalConfig = {
      customer: customerId,
      return_url: `${req.headers.origin}/cuenta.html`
    };

    // Si tenemos subscription_id, agregarlo para mejor experiencia
    if (user.stripe_subscription_id) {
      portalConfig.configuration = undefined; // Usar configuración por defecto del dashboard
    }

    // Crear sesión del Portal de Facturación
    const session = await stripe.billingPortal.sessions.create(portalConfig);

    return res.status(200).json({
      portal_url: session.url
    });

  } catch (error) {
    console.error('Error en stripe-portal:', error);
    return res.status(500).json({ error: 'Error al procesar solicitud' });
  }
}