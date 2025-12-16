# 🎯 Compita

**Sistema multi-cliente de análisis de licitaciones con Inteligencia Artificial**

Compita es una plataforma que utiliza Claude 4 (Anthropic) para analizar descripciones de licitaciones públicas y determinar su relevancia para diferentes clientes, permitiendo identificar oportunidades de negocio de manera automatizada e inteligente.

🌐 **URL:** https://compita.umbusk.com

---

## ✨ Características

- 🤖 **Análisis con IA**: Utiliza Claude Haiku 4.5 para clasificación contextual inteligente
- 👥 **Multi-cliente**: Gestiona múltiples clientes con criterios personalizados
- 📊 **Dashboard intuitivo**: Interface web completa para gestión y análisis
- 💾 **Persistencia de datos**: Guarda todos los análisis y resultados en base de datos
- 📁 **Importación Excel**: Procesa archivos Excel con descripciones de licitaciones
- 🎯 **Filtros avanzados**: Filtra resultados por cliente, relevancia y más
- ✅ **Selección de casos**: Marca licitaciones para dar seguimiento
- 📥 **Exportación**: Descarga resultados seleccionados en Excel

---

## 🛠️ Tecnologías

### **Backend**
- **Vercel Serverless Functions** - Infraestructura
- **Node.js** - Runtime
- **@anthropic-ai/sdk** - API de Claude
- **@neondatabase/serverless** - Base de datos PostgreSQL

### **Frontend**
- **HTML5/CSS3/JavaScript** - Interface
- **SheetJS (xlsx)** - Procesamiento de Excel

### **Base de Datos**
- **Neon PostgreSQL** - Base de datos serverless

---

## 📁 Estructura del Proyecto

```
compita/
├── api/                        # Serverless functions
│   ├── init-db.js             # Inicialización de base de datos
│   ├── clientes.js            # CRUD de clientes
│   ├── analizar-v3.js         # Motor de análisis con IA
│   └── resultados.js          # Gestión de resultados
├── public/                     # Frontend
│   └── index.html             # Dashboard principal
├── package.json               # Dependencias
├── vercel.json               # Configuración de Vercel
└── README.md                 # Este archivo
```

---

## 🗄️ Esquema de Base de Datos

### **Tabla: clientes**
Almacena información de clientes y sus criterios de clasificación personalizados.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | SERIAL | ID único |
| nombre | VARCHAR(255) | Nombre del cliente |
| descripcion | TEXT | Descripción del negocio |
| criterios_alta | TEXT[] | Palabras clave para relevancia ALTA |
| criterios_media | TEXT[] | Palabras clave para relevancia MEDIA |
| criterios_baja | TEXT[] | Palabras clave para relevancia BAJA |
| prompt_personalizado | TEXT | Prompt custom (opcional) |
| activo | BOOLEAN | Estado del cliente |
| created_at | TIMESTAMP | Fecha de creación |
| updated_at | TIMESTAMP | Última actualización |

### **Tabla: analisis**
Registra cada análisis realizado.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | SERIAL | ID único |
| cliente_id | INTEGER | FK a clientes |
| fecha_analisis | TIMESTAMP | Fecha del análisis |
| total_descripciones | INTEGER | Total procesado |
| total_alta | INTEGER | Cantidad ALTA |
| total_media | INTEGER | Cantidad MEDIA |
| total_baja | INTEGER | Cantidad BAJA |
| porcentaje_alta | DECIMAL(5,2) | % de relevancia alta |
| fuente | VARCHAR(100) | Origen (excel, manual, api) |
| notas | TEXT | Notas adicionales |

### **Tabla: resultados**
Almacena resultados individuales de cada licitación analizada.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | SERIAL | ID único |
| analisis_id | INTEGER | FK a analisis |
| cliente_id | INTEGER | FK a clientes |
| descripcion | TEXT | Descripción original |
| que | VARCHAR(100) | Síntesis (qué se busca) |
| quien | VARCHAR(100) | Destinatario |
| relevancia | VARCHAR(10) | ALTA/MEDIA/BAJA/ERROR |
| razon | TEXT | Justificación del análisis |
| seleccionado | BOOLEAN | Marcado para licitar |
| notas | TEXT | Notas del usuario |
| estado | VARCHAR(50) | pendiente/en_proceso/completado/descartado |
| created_at | TIMESTAMP | Fecha de creación |

---

## 🚀 Instalación y Deployment

### **Prerrequisitos**

1. Cuenta en [Vercel](https://vercel.com)
2. Cuenta en [Neon](https://neon.tech) (PostgreSQL)
3. API Key de [Anthropic](https://console.anthropic.com)

### **Variables de Entorno**

Configura estas variables en Vercel:

```env
ClaudeAPIKeyForCompita=sk-ant-xxxxxxxxxxxxxxxxxxxxx
NETLIFYDATABASEURL=postgresql://user:pass@host.neon.tech/dbname?sslmode=require
```

### **Deploy en Vercel**

1. Fork o clona este repositorio
2. Importa el proyecto en Vercel
3. Configura las variables de entorno
4. Deploy automático

### **Inicializar Base de Datos**

Después del primer deploy, ejecuta una vez:

```bash
curl -X POST https://compita.umbusk.com/api/init-db
```

Esto creará las tablas y un cliente de ejemplo.

---

## 📖 Uso del Sistema

### **1. Gestionar Clientes**

**Pestaña "👥 Clientes"**
- Ver todos los clientes activos
- Crear nuevo cliente con criterios personalizados
- Editar criterios de clasificación existentes
- Eliminar clientes (soft delete)

### **2. Analizar Licitaciones**

**Pestaña "🔍 Analizar"**
1. Selecciona un cliente
2. Carga archivo Excel con descripciones (columna A)
3. Click en "🚀 Analizar Licitaciones"
4. Espera el procesamiento (máximo 25 descripciones por análisis)
5. Revisa estadísticas de resultados

### **3. Revisar Resultados**

**Pestaña "📊 Resultados"**
- Filtra por cliente y/o relevancia
- Marca casos interesantes para dar seguimiento
- Exporta selección a Excel
- Consulta historial completo

---

## 🔌 APIs Disponibles

### **POST /api/init-db**
Inicializa las tablas de la base de datos.

**Response:**
```json
{
  "success": true,
  "mensaje": "Base de datos inicializada correctamente",
  "tablas": ["clientes", "analisis", "resultados"],
  "indices": 4,
  "cliente_ejemplo": "Formación Smart"
}
```

### **GET /api/clientes**
Lista todos los clientes activos.

**Response:**
```json
{
  "success": true,
  "clientes": [...]
}
```

### **POST /api/clientes**
Crea un nuevo cliente.

**Request:**
```json
{
  "nombre": "Mi Empresa",
  "descripcion": "Consultoría en tecnología",
  "criterios_alta": ["software", "sistemas", "IT"],
  "criterios_media": ["consultoría", "asesoría"],
  "criterios_baja": ["construcción", "alimentos"]
}
```

### **POST /api/analizar-v3**
Analiza licitaciones para un cliente específico.

**Request:**
```json
{
  "cliente_id": 1,
  "descripciones": [
    "Capacitación en gestión de proyectos",
    "Compra de mobiliario de oficina"
  ],
  "guardar_en_db": true,
  "batchSize": 10
}
```

**Response:**
```json
{
  "success": true,
  "cliente": {
    "id": 1,
    "nombre": "Formación Smart"
  },
  "analisis_id": 42,
  "estadisticas": {
    "total": 2,
    "alta": 1,
    "media": 0,
    "baja": 1,
    "errores": 0,
    "porcentajeAlta": "50.0"
  },
  "resultados": [...],
  "mensaje": "Análisis completado para Formación Smart: 2 descripciones procesadas"
}
```

### **GET /api/resultados**
Consulta resultados con filtros.

**Query params:**
- `cliente_id`: Filtrar por cliente
- `relevancia`: Filtrar por ALTA/MEDIA/BAJA
- `seleccionado`: true/false
- `analisis_id`: ID de análisis específico
- `limite`: Número máximo de resultados (default: 100)

**Response:**
```json
{
  "success": true,
  "total": 50,
  "resultados": [...]
}
```

### **PUT /api/resultados**
Actualiza estado de un resultado.

**Request:**
```json
{
  "id": 123,
  "seleccionado": true,
  "estado": "en_proceso",
  "notas": "Requiere seguimiento"
}
```

---

## 🧠 Cómo Funciona el Análisis

1. **Recepción:** Sistema recibe descripciones desde Excel
2. **Contexto:** Obtiene criterios personalizados del cliente
3. **Procesamiento:** Divide en lotes de 10 descripciones
4. **IA:** Claude Haiku 4.5 analiza cada lote contextualmente
5. **Clasificación:** Determina relevancia (ALTA/MEDIA/BAJA) y justifica
6. **Persistencia:** Guarda todos los resultados en base de datos
7. **Visualización:** Presenta resultados en dashboard con estadísticas

**Modelo usado:** `claude-haiku-4-5-20251001` (rápido y económico)

**Límites:**
- 25 descripciones por análisis (limite de timeout)
- 10 descripciones por lote
- Timeout de 10 segundos por función

---

## 🔒 Seguridad

- ✅ Variables de entorno para credenciales sensibles
- ✅ CORS configurado para acceso controlado
- ✅ Validación de datos en todas las APIs
- ✅ Conexiones SSL a base de datos
- ✅ Soft delete para clientes (no se borran físicamente)

---

## 🎯 Casos de Uso

### **Ejemplo 1: Empresa de Capacitación**
- **Cliente:** Formación Smart
- **Criterios ALTA:** capacitación, cursos, talleres, diplomados
- **Objetivo:** Identificar licitaciones de servicios formativos
- **Resultado:** Filtrado automático de oportunidades relevantes

### **Ejemplo 2: Consultoría Tecnológica**
- **Cliente:** TechConsult RD
- **Criterios ALTA:** software, sistemas, implementación, desarrollo
- **Objetivo:** Detectar proyectos de transformación digital
- **Resultado:** Priorización de licitaciones técnicas

### **Ejemplo 3: Servicios Profesionales**
- **Cliente:** Legal & Compliance
- **Criterios ALTA:** auditoría, consultoría legal, compliance
- **Objetivo:** Identificar necesidades de asesoría especializada
- **Resultado:** Dashboard con casos pre-calificados

---

## 🤝 Contribuciones

Este es un proyecto propietario de **Umbusk LLC**. Para consultas o sugerencias:
- Email: info@umbusk.com
- Web: https://umbusk.com

---

## 📄 Licencia

© 2024 Umbusk LLC. Todos los derechos reservados.

---

## 👨‍💻 Autor

**Moisés P. Ramírez**  
General Manager - Umbusk LLC  
Consultor en Diseño Social, Innovación y Tecnología

---

## 🙏 Agradecimientos

- **Anthropic** - Por Claude 4 y su API
- **Vercel** - Por la infraestructura serverless
- **Neon** - Por la base de datos PostgreSQL serverless
- **SheetJS** - Por el procesamiento de archivos Excel

---

## 📊 Estado del Proyecto

✅ **Versión:** 1.0.0  
✅ **Estado:** Producción  
✅ **Última actualización:** Diciembre 2024  
🌐 **Sitio:** https://compita.umbusk.com

---

## 🔮 Roadmap

- [ ] Autenticación de usuarios
- [ ] Panel de administración avanzado
- [ ] Notificaciones por email
- [ ] Integración con APIs de portales de licitaciones
- [ ] Análisis de documentos PDF completos
- [ ] Dashboard de métricas y reportes
- [ ] App móvil

---

**¿Preguntas? ¿Sugerencias?** Contacta a Umbusk LLC
