"""
COMPITA - Scraping Diario Automático (v3 - BUGS CORREGIDOS)
============================================================
FIX 1: Parada inteligente mejorada
  - Antes: paraba al primer resultado viejo (aunque hubiera hoy debajo)
  - Ahora: para solo cuando 2 clicks consecutivos no agregan nada nuevo de hoy

FIX 2: Filtro de extracción corregido
  - Antes: filtraba por fecha_presentacion (guardaba licitaciones viejas con plazo futuro)
  - Ahora: filtra por fecha_publicacion == hoy (solo lo de hoy)

NUEVO — Sistema de contingencia:
  - Detecta dos tipos de falla: portal_inaccesible / estructura_modificada
  - Actualiza tabla sistema_estado en Neon
  - Envía email de alerta al Admin vía Resend
  - Cuando vuelve a funcionar, restaura el estado a NORMAL automáticamente

Fecha: Marzo 2026
"""

import os
import time
import requests
from datetime import datetime, timedelta
from decimal import Decimal
import re
from playwright.sync_api import sync_playwright
import psycopg2
from psycopg2.extras import execute_values

# ============================================================================
# CONFIGURACIÓN
# ============================================================================

PORTAL_URL = "https://comunidad.comprasdominicana.gob.do/Public/Tendering/ContractNoticeManagement/Index"
HEADLESS = True
DATABASE_URL  = os.getenv('DATABASE_URL')
RESEND_API_KEY = os.getenv('RESEND_API_KEY')
ADMIN_EMAIL    = os.getenv('ADMIN_EMAIL', 'admin@compita.umbusk.com')
FROM_EMAIL     = 'Compita Alertas <alertas@compita.umbusk.com>'

# ============================================================================
# TAXONOMÍA UNSPSC - CLASIFICACIÓN AUTOMÁTICA
# ============================================================================

unspsc_taxonomy = {
    '10-10': {'name': 'Animales vivos', 'segment': 'Material vivo', 'keywords': ['ganado', 'animales vivos', 'aves', 'peces', 'especies']},
    '10-11': {'name': 'Productos para animales', 'segment': 'Material vivo', 'keywords': ['productos animales', 'accesorios mascotas']},
    '10-12': {'name': 'Comida de animales', 'segment': 'Material vivo', 'keywords': ['alimento animal', 'comida ganado', 'forraje']},
    '10-15': {'name': 'Semillas y plantas', 'segment': 'Material vivo', 'keywords': ['semillas', 'plantas', 'árboles', 'plántulas', 'vivero']},
    '10-16': {'name': 'Productos de floricultura', 'segment': 'Material vivo', 'keywords': ['flores', 'floricultura', 'ornamentales', 'jardinería']},
    '10-17': {'name': 'Fertilizantes', 'segment': 'Material vivo', 'keywords': ['fertilizantes', 'abono', 'nutrientes plantas', 'herbicidas']},
    '11-10': {'name': 'Minerales', 'segment': 'Minerales', 'keywords': ['minerales', 'metales', 'metálicos']},
    '11-11': {'name': 'Madera', 'segment': 'Minerales', 'keywords': ['madera', 'tablones', 'troncos']},
    '11-12': {'name': 'Productos de cuero', 'segment': 'Minerales', 'keywords': ['cuero', 'pieles']},
    '11-13': {'name': 'Fibras textiles', 'segment': 'Minerales', 'keywords': ['fibras', 'hilos', 'textiles']},
    '11-14': {'name': 'Telas', 'segment': 'Minerales', 'keywords': ['telas', 'textiles', 'tejidos']},
    '11-15': {'name': 'Ropa y uniformes', 'segment': 'Minerales', 'keywords': ['uniformes', 'ropa', 'vestuario', 'vestimenta', 'indumentaria']},
    '12-14': {'name': 'Resinas y adhesivos', 'segment': 'Químicos', 'keywords': ['resinas', 'adhesivos', 'pegamento']},
    '12-16': {'name': 'Tintes y pigmentos', 'segment': 'Químicos', 'keywords': ['tintes', 'pigmentos', 'colorantes']},
    '12-17': {'name': 'Explosivos', 'segment': 'Químicos', 'keywords': ['explosivos', 'dinamita']},
    '12-18': {'name': 'Medicamentos', 'segment': 'Químicos', 'keywords': ['medicamentos', 'fármacos', 'medicina', 'medicinas', 'drogas']},
    '12-19': {'name': 'Gases industriales', 'segment': 'Químicos', 'keywords': ['gases', 'oxígeno', 'nitrógeno']},
    '12-35': {'name': 'Reactivos de laboratorio', 'segment': 'Químicos', 'keywords': ['reactivos', 'laboratorio', 'químicos']},
    '13-10': {'name': 'Caucho', 'segment': 'Resinas', 'keywords': ['caucho', 'goma', 'hule']},
    '13-11': {'name': 'Plásticos', 'segment': 'Resinas', 'keywords': ['plástico', 'polímero', 'pvc']},
    '14-10': {'name': 'Papel y cartón', 'segment': 'Papel', 'keywords': ['papel', 'cartón']},
    '14-11': {'name': 'Papel de oficina', 'segment': 'Papel', 'keywords': ['papel bond', 'papelería', 'hojas', 'resmas']},
    '15-10': {'name': 'Combustibles', 'segment': 'Combustibles', 'keywords': ['combustible', 'gasolina', 'diesel', 'gasoil', 'fuel']},
    '15-11': {'name': 'Lubricantes', 'segment': 'Combustibles', 'keywords': ['lubricantes', 'aceite motor', 'grasa']},
    '20-10': {'name': 'Equipo de minería', 'segment': 'Maquinaria minería', 'keywords': ['minería', 'perforación', 'excavación']},
    '21-10': {'name': 'Equipo agrícola', 'segment': 'Maquinaria agrícola', 'keywords': ['tractor', 'cosechadora', 'agrícola', 'arado']},
    '21-11': {'name': 'Equipo de pesca', 'segment': 'Maquinaria agrícola', 'keywords': ['pesca', 'redes', 'embarcaciones pesca']},
    '22-10': {'name': 'Maquinaria de construcción', 'segment': 'Maquinaria construcción', 'keywords': ['excavadora', 'bulldozer', 'grúa', 'retroexcavadora', 'maquinaria pesada']},
    '23-10': {'name': 'Maquinaria industrial', 'segment': 'Maquinaria industrial', 'keywords': ['maquinaria manufactura', 'equipos industriales']},
    '24-10': {'name': 'Equipos de almacenamiento', 'segment': 'Manejo materiales', 'keywords': ['estantería', 'racks', 'almacenamiento']},
    '24-11': {'name': 'Montacargas', 'segment': 'Manejo materiales', 'keywords': ['montacargas', 'elevador', 'grúa']},
    '25-10': {'name': 'Vehículos', 'segment': 'Vehículos', 'keywords': ['vehículo', 'automóvil', 'camión', 'camioneta', 'autobús', 'ambulancia', 'jeep', 'pick up']},
    '25-11': {'name': 'Partes de vehículos', 'segment': 'Vehículos', 'keywords': ['repuestos', 'piezas vehículo', 'neumáticos', 'gomas', 'llantas', 'baterías']},
    '25-12': {'name': 'Motocicletas', 'segment': 'Vehículos', 'keywords': ['motocicleta', 'moto']},
    '25-13': {'name': 'Bicicletas', 'segment': 'Vehículos', 'keywords': ['bicicleta', 'bike']},
    '26-10': {'name': 'Equipos de generación eléctrica', 'segment': 'Generación energía', 'keywords': ['planta eléctrica', 'generador', 'turbina']},
    '26-11': {'name': 'Equipos de distribución eléctrica', 'segment': 'Generación energía', 'keywords': ['transformador', 'subestación', 'distribución eléctrica']},
    '27-10': {'name': 'Herramientas manuales', 'segment': 'Herramientas', 'keywords': ['herramientas', 'martillo', 'destornillador', 'llave', 'limas', 'lima']},
    '27-11': {'name': 'Herramientas eléctricas', 'segment': 'Herramientas', 'keywords': ['taladro', 'sierra eléctrica', 'esmeril']},
    '27-21': {'name': 'Equipo de seguridad', 'segment': 'Herramientas', 'keywords': ['casco', 'guantes seguridad', 'epp', 'equipos protección', 'guantes']},
    '30-10': {'name': 'Materiales de construcción', 'segment': 'Construcción', 'keywords': ['cemento', 'arena', 'gravilla', 'blocks', 'concreto', 'hormigón']},
    '30-11': {'name': 'Madera para construcción', 'segment': 'Construcción', 'keywords': ['madera construcción', 'tablones', 'vigas madera']},
    '30-15': {'name': 'Tuberías', 'segment': 'Construcción', 'keywords': ['tubería', 'tubo', 'cañería', 'pvc']},
    '30-17': {'name': 'Estructuras metálicas', 'segment': 'Construcción', 'keywords': ['estructura metálica', 'vigas', 'columnas', 'acero estructural']},
    '30-18': {'name': 'Acabados de construcción', 'segment': 'Construcción', 'keywords': ['cerámica', 'porcelanato', 'pisos', 'azulejos']},
    '31-10': {'name': 'Componentes mecánicos', 'segment': 'Componentes manufactura', 'keywords': ['rodamientos', 'cojinetes', 'engranajes']},
    '31-15': {'name': 'Válvulas', 'segment': 'Componentes manufactura', 'keywords': ['válvulas', 'grifería']},
    '39-10': {'name': 'Cables eléctricos', 'segment': 'Equipos eléctricos', 'keywords': ['cable', 'alambre', 'cableado']},
    '39-11': {'name': 'Equipos eléctricos', 'segment': 'Equipos eléctricos', 'keywords': ['planta eléctrica', 'generador', 'eléctrico', 'panel eléctrico']},
    '39-12': {'name': 'Iluminación', 'segment': 'Equipos eléctricos', 'keywords': ['luminarias', 'lámparas', 'iluminación', 'luces', 'led', 'bombillas']},
    '40-10': {'name': 'Calefacción y ventilación', 'segment': 'Distribución HVAC', 'keywords': ['aire acondicionado', 'climatización', 'ventilación', 'hvac', 'abanico', 'abanicos', 'ventilador', 'ventiladores']},
    '40-11': {'name': 'Refrigeración', 'segment': 'Distribución HVAC', 'keywords': ['refrigeración', 'nevera', 'refrigerador', 'congelador']},
    '41-10': {'name': 'Equipos de laboratorio', 'segment': 'Laboratorio', 'keywords': ['laboratorio', 'microscopio', 'autoclave', 'centrífuga']},
    '41-11': {'name': 'Instrumentos de medición', 'segment': 'Laboratorio', 'keywords': ['medición', 'balanza', 'termómetro', 'calibración']},
    '41-12': {'name': 'Equipos de prueba', 'segment': 'Laboratorio', 'keywords': ['pruebas', 'ensayos', 'análisis']},
    '42-14': {'name': 'Equipo quirúrgico', 'segment': 'Equipos médicos', 'keywords': ['quirúrgico', 'cirugía', 'instrumental quirúrgico']},
    '42-18': {'name': 'Equipos médicos', 'segment': 'Equipos médicos', 'keywords': ['equipo médico', 'hospital', 'rayos x', 'ultrasonido', 'camilla']},
    '42-19': {'name': 'Equipo de rehabilitación', 'segment': 'Equipos médicos', 'keywords': ['rehabilitación', 'terapia física', 'fisioterapia']},
    '42-22': {'name': 'Equipo de examen médico', 'segment': 'Equipos médicos', 'keywords': ['examen médico', 'diagnóstico', 'estetoscopio']},
    '42-27': {'name': 'Equipos de sala de operaciones', 'segment': 'Equipos médicos', 'keywords': ['sala operaciones', 'quirófano']},
    '42-29': {'name': 'Insumos médicos', 'segment': 'Equipos médicos', 'keywords': ['insumos médicos', 'jeringuillas', 'jeringas', 'gasas', 'vendas', 'guantes médicos', 'desechables médicos', 'descartables']},
    '42-30': {'name': 'Equipo dental', 'segment': 'Equipos médicos', 'keywords': ['dental', 'odontológico', 'silla dental']},
    '43-20': {'name': 'Almacenamiento de datos', 'segment': 'Tecnología', 'keywords': ['disco duro', 'almacenamiento', 'storage']},
    '43-21': {'name': 'Computadoras', 'segment': 'Tecnología', 'keywords': ['computadora', 'laptop', 'pc', 'servidor', 'tablet', 'equipos informáticos', 'computador', 'tecnología', 'equipos tecnológicos']},
    '43-22': {'name': 'Periféricos', 'segment': 'Tecnología', 'keywords': ['impresora', 'escáner', 'ups', 'mouse', 'teclado', 'monitor']},
    '43-23': {'name': 'Software', 'segment': 'Tecnología', 'keywords': ['software', 'licencia', 'sistema', 'aplicación', 'programa']},
    '43-24': {'name': 'Equipos de telecomunicaciones', 'segment': 'Tecnología', 'keywords': ['teléfono', 'celular', 'telefonía']},
    '43-31': {'name': 'Equipos de redes', 'segment': 'Tecnología', 'keywords': ['router', 'switch', 'red', 'networking', 'wifi', 'cableado estructurado']},
    '43-33': {'name': 'Componentes de computadora', 'segment': 'Tecnología', 'keywords': ['memoria ram', 'procesador', 'tarjeta madre']},
    '44-10': {'name': 'Materiales de oficina', 'segment': 'Oficina', 'keywords': ['útiles', 'materiales oficina', 'lapiceros', 'bolígrafos', 'suministros oficina']},
    '44-11': {'name': 'Mobiliario de oficina', 'segment': 'Oficina', 'keywords': ['mobiliario', 'escritorio', 'silla', 'archivo', 'estante', 'muebles oficina']},
    '44-12': {'name': 'Suministros de oficina', 'segment': 'Oficina', 'keywords': ['carpetas', 'folders', 'archivadores']},
    '44-13': {'name': 'Equipos de presentación', 'segment': 'Oficina', 'keywords': ['pizarra', 'pizarras', 'tablero', 'proyector', 'pantalla']},
    '45-10': {'name': 'Equipos de imprenta', 'segment': 'Impresión', 'keywords': ['imprenta', 'impresión', 'offset']},
    '46-16': {'name': 'Equipos militares', 'segment': 'Defensa', 'keywords': ['militar', 'militares', 'pertrechos', 'uniformes militares', 'equipo táctico']},
    '46-17': {'name': 'Armas y municiones', 'segment': 'Defensa', 'keywords': ['armas', 'municiones', 'armamento']},
    '46-18': {'name': 'Equipos de seguridad', 'segment': 'Defensa', 'keywords': ['seguridad', 'cámaras', 'vigilancia', 'alarma', 'control acceso', 'cctv']},
    '46-19': {'name': 'Equipos de bomberos', 'segment': 'Defensa', 'keywords': ['bomberos', 'extintor', 'incendio']},
    '47-10': {'name': 'Equipos de limpieza', 'segment': 'Limpieza', 'keywords': ['aspiradora', 'equipo limpieza', 'lavadora']},
    '47-13': {'name': 'Productos de limpieza', 'segment': 'Limpieza', 'keywords': ['limpieza', 'detergente', 'desinfectante', 'cloro', 'productos aseo', 'jabón']},
    '48-10': {'name': 'Equipo de lavandería', 'segment': 'Servicios', 'keywords': ['lavandería', 'lavadora industrial', 'secadora']},
    '49-10': {'name': 'Equipos deportivos', 'segment': 'Deportes', 'keywords': ['deportivo', 'deporte', 'balón', 'equipo gimnasio']},
    '50-10': {'name': 'Carnes', 'segment': 'Alimentos', 'keywords': ['carne', 'pollo', 'res', 'cerdo']},
    '50-11': {'name': 'Pescados y mariscos', 'segment': 'Alimentos', 'keywords': ['pescado', 'mariscos', 'camarón']},
    '50-13': {'name': 'Lácteos', 'segment': 'Alimentos', 'keywords': ['lácteos', 'leche', 'queso', 'yogurt']},
    '50-20': {'name': 'Alimentos procesados', 'segment': 'Alimentos', 'keywords': ['alimentos', 'comida', 'alimentación', 'productos alimenticios', 'víveres']},
    '50-21': {'name': 'Bebidas', 'segment': 'Alimentos', 'keywords': ['bebidas', 'agua', 'refrescos', 'jugos']},
    '50-30': {'name': 'Tabaco', 'segment': 'Alimentos', 'keywords': ['tabaco', 'cigarros']},
    '51-10': {'name': 'Medicamentos', 'segment': 'Farmacéuticos', 'keywords': ['medicamentos', 'medicinas', 'fármacos']},
    '52-10': {'name': 'Electrodomésticos', 'segment': 'Productos domésticos', 'keywords': ['electrodomésticos', 'nevera', 'estufa', 'lavadora']},
    '52-14': {'name': 'Utensilios de cocina', 'segment': 'Productos domésticos', 'keywords': ['utensilios', 'cocina', 'ollas', 'vajilla']},
    '52-15': {'name': 'Productos desechables', 'segment': 'Productos domésticos', 'keywords': ['desechables', 'descartables', 'vasos desechables', 'platos desechables', 'cubiertos plásticos']},
    '53-10': {'name': 'Ropa', 'segment': 'Vestimenta', 'keywords': ['ropa', 'vestuario', 'prendas']},
    '53-11': {'name': 'Calzado', 'segment': 'Vestimenta', 'keywords': ['zapatos', 'calzado', 'botas']},
    '53-13': {'name': 'Productos de aseo personal', 'segment': 'Vestimenta', 'keywords': ['aseo personal', 'higiene', 'jabón', 'shampoo']},
    '55-10': {'name': 'Libros', 'segment': 'Publicaciones', 'keywords': ['libros', 'textos', 'publicaciones']},
    '56-10': {'name': 'Mobiliario', 'segment': 'Mobiliario', 'keywords': ['muebles', 'mobiliario', 'equipamiento', 'sillones']},
    '60-10': {'name': 'Instrumentos musicales', 'segment': 'Música', 'keywords': ['instrumentos musicales', 'música']},
    '60-11': {'name': 'Juguetes', 'segment': 'Música', 'keywords': ['juguetes', 'juegos']},
    '60-14': {'name': 'Material educativo', 'segment': 'Música', 'keywords': ['material educativo', 'didáctico', 'útiles escolares', 'pizarra inalámbrica', 'pizarras digitales']},
    '70-10': {'name': 'Servicios agrícolas', 'segment': 'Servicios agrícolas', 'keywords': ['servicios agrícolas', 'agricultura', 'agropecuario']},
    '70-11': {'name': 'Servicios de pesca', 'segment': 'Servicios agrícolas', 'keywords': ['servicios pesca', 'acuicultura']},
    '71-10': {'name': 'Servicios de minería', 'segment': 'Servicios minería', 'keywords': ['servicios minería', 'extracción']},
    '72-10': {'name': 'Construcción de edificios', 'segment': 'Servicios construcción', 'keywords': ['construcción', 'edificación', 'obra civil', 'obra']},
    '72-11': {'name': 'Mantenimiento de edificios', 'segment': 'Servicios construcción', 'keywords': ['mantenimiento', 'reparación', 'remodelación', 'refacción', 'rehabilitación', 'adecuación']},
    '72-12': {'name': 'Construcción de carreteras', 'segment': 'Servicios construcción', 'keywords': ['carreteras', 'pavimentación', 'asfalto', 'vías']},
    '72-13': {'name': 'Construcción de puentes', 'segment': 'Servicios construcción', 'keywords': ['puentes', 'viaductos']},
    '72-14': {'name': 'Construcción de infraestructura', 'segment': 'Servicios construcción', 'keywords': ['infraestructura', 'acueducto', 'alcantarillado']},
    '72-15': {'name': 'Trabajos especializados', 'segment': 'Servicios construcción', 'keywords': ['electricidad', 'plomería', 'pintura', 'acabados', 'instalación', 'fontanería']},
    '73-10': {'name': 'Servicios de manufactura', 'segment': 'Servicios manufactura', 'keywords': ['manufactura', 'fabricación', 'producción']},
    '73-15': {'name': 'Servicios de impresión', 'segment': 'Servicios manufactura', 'keywords': ['impresión', 'imprenta', 'publicación']},
    '76-10': {'name': 'Servicios de limpieza', 'segment': 'Servicios limpieza', 'keywords': ['servicios limpieza', 'aseo', 'conserjería', 'conserje']},
    '76-11': {'name': 'Manejo de desechos', 'segment': 'Servicios limpieza', 'keywords': ['desechos', 'basura', 'residuos', 'recolección']},
    '76-12': {'name': 'Fumigación', 'segment': 'Servicios limpieza', 'keywords': ['fumigación', 'desinfección', 'control plagas']},
    '77-10': {'name': 'Gestión ambiental', 'segment': 'Servicios ambientales', 'keywords': ['ambiental', 'medio ambiente', 'ecológico']},
    '77-11': {'name': 'Remediación ambiental', 'segment': 'Servicios ambientales', 'keywords': ['remediación', 'saneamiento']},
    '78-10': {'name': 'Transporte de pasajeros', 'segment': 'Servicios transporte', 'keywords': ['transporte', 'traslado', 'pasajeros', 'movilización', 'autobuses', 'autobús', 'bus']},
    '78-11': {'name': 'Transporte de carga', 'segment': 'Servicios transporte', 'keywords': ['carga', 'flete', 'transporte carga']},
    '78-13': {'name': 'Servicios de mudanza', 'segment': 'Servicios transporte', 'keywords': ['mudanza', 'traslado bienes']},
    '78-16': {'name': 'Alquiler de vehículos', 'segment': 'Servicios transporte', 'keywords': ['alquiler vehículos', 'renta vehículos', 'arrendamiento vehículos', 'alquiler autobuses']},
    '78-18': {'name': 'Servicios de almacenamiento', 'segment': 'Servicios transporte', 'keywords': ['almacenamiento', 'bodegaje', 'warehouse']},
    '80-10': {'name': 'Servicios de consultoría', 'segment': 'Servicios profesionales', 'keywords': ['consultoría', 'asesoría', 'consultor', 'asesor']},
    '80-11': {'name': 'Servicios profesionales técnicos', 'segment': 'Servicios profesionales', 'keywords': ['servicios profesionales', 'servicios técnicos', 'servicios especializados']},
    '80-12': {'name': 'Servicios legales', 'segment': 'Servicios profesionales', 'keywords': ['legal', 'jurídico', 'abogado', 'notarial', 'servicios jurídicos']},
    '80-14': {'name': 'Servicios de marketing y eventos', 'segment': 'Servicios profesionales', 'keywords': ['marketing', 'mercadeo', 'ventas', 'eventos', 'evento', 'maestro ceremonias', 'animación', 'montaje', 'desmontaje', 'alquiler equipos']},
    '80-16': {'name': 'Servicios de gestión', 'segment': 'Servicios profesionales', 'keywords': ['gestión', 'administración', 'gerencia']},
    '81-10': {'name': 'Servicios de ingeniería', 'segment': 'Servicios ingeniería', 'keywords': ['ingeniería', 'diseño', 'supervisión', 'estudios técnicos', 'proyectos']},
    '81-11': {'name': 'Servicios de arquitectura', 'segment': 'Servicios ingeniería', 'keywords': ['arquitectura', 'arquitectónico', 'planos', 'diseño arquitectónico']},
    '81-12': {'name': 'Servicios de topografía', 'segment': 'Servicios ingeniería', 'keywords': ['topografía', 'levantamiento', 'geodesia']},
    '82-10': {'name': 'Servicios editoriales', 'segment': 'Servicios editoriales', 'keywords': ['editorial', 'edición']},
    '82-11': {'name': 'Servicios de diseño gráfico', 'segment': 'Servicios editoriales', 'keywords': ['diseño gráfico', 'diseño', 'gráfico']},
    '83-10': {'name': 'Servicios de publicidad', 'segment': 'Servicios comunicación', 'keywords': ['publicidad', 'propaganda', 'promoción', 'campaña']},
    '83-11': {'name': 'Servicios audiovisuales', 'segment': 'Servicios comunicación', 'keywords': ['audiovisual', 'producción', 'video', 'fotografía']},
    '83-12': {'name': 'Servicios de telecomunicaciones', 'segment': 'Servicios comunicación', 'keywords': ['telecomunicaciones', 'internet', 'telefonía']},
    '84-10': {'name': 'Servicios bancarios', 'segment': 'Servicios financieros', 'keywords': ['bancario', 'financiero', 'crédito', 'préstamo']},
    '84-11': {'name': 'Servicios de seguros', 'segment': 'Servicios financieros', 'keywords': ['seguro', 'póliza', 'aseguradora', 'seguros']},
    '84-12': {'name': 'Servicios contables', 'segment': 'Servicios financieros', 'keywords': ['contabilidad', 'contable', 'auditoría', 'contador']},
    '85-10': {'name': 'Servicios médicos', 'segment': 'Servicios salud', 'keywords': ['servicios médicos', 'atención médica', 'salud', 'consulta médica']},
    '85-11': {'name': 'Servicios de enfermería', 'segment': 'Servicios salud', 'keywords': ['enfermería', 'enfermeras']},
    '85-12': {'name': 'Servicios de laboratorio clínico', 'segment': 'Servicios salud', 'keywords': ['laboratorio clínico', 'análisis clínicos', 'pruebas médicas', 'exámenes']},
    '85-13': {'name': 'Servicios dentales', 'segment': 'Servicios salud', 'keywords': ['dental', 'odontología', 'odontológico']},
    '86-10': {'name': 'Capacitación', 'segment': 'Servicios educativos', 'keywords': ['capacitación', 'entrenamiento', 'formación', 'curso', 'taller', 'adiestramiento', 'diplomado']},
    '86-11': {'name': 'Educación', 'segment': 'Servicios educativos', 'keywords': ['educación', 'educativo', 'enseñanza', 'académico']},
    '86-12': {'name': 'Investigación educativa', 'segment': 'Servicios educativos', 'keywords': ['investigación', 'estudio', 'investigación científica']},
    '90-10': {'name': 'Servicios de hotel', 'segment': 'Servicios viaje', 'keywords': ['hotel', 'hospedaje', 'alojamiento', 'estadía', 'hotelería']},
    '90-11': {'name': 'Servicios de alimentación', 'segment': 'Servicios viaje', 'keywords': ['catering', 'alimentación', 'servicio comida', 'desayuno', 'almuerzo', 'refrigerio', 'cafetería']},
    '90-12': {'name': 'Servicios de viaje', 'segment': 'Servicios viaje', 'keywords': ['agencia viajes', 'turismo', 'pasajes']},
    '90-15': {'name': 'Servicios de entretenimiento', 'segment': 'Servicios viaje', 'keywords': ['entretenimiento', 'recreación', 'actividades recreativas', 'espectáculos']},
    '91-10': {'name': 'Servicios de belleza', 'segment': 'Servicios personales', 'keywords': ['belleza', 'peluquería', 'estética']},
    '92-10': {'name': 'Servicios de vigilancia', 'segment': 'Servicios seguridad', 'keywords': ['vigilancia', 'guardias', 'seguridad privada', 'custodia']},
    '92-12': {'name': 'Servicios de investigación', 'segment': 'Servicios seguridad', 'keywords': ['investigación privada', 'detective']},
    '93-15': {'name': 'Servicios de energía', 'segment': 'Servicios públicos', 'keywords': ['energía eléctrica', 'electricidad', 'servicio eléctrico']},
    '93-16': {'name': 'Servicios de agua', 'segment': 'Servicios públicos', 'keywords': ['agua potable', 'acueducto', 'servicio agua']},
    '94-10': {'name': 'Servicios cívicos y culturales', 'segment': 'Servicios políticos', 'keywords': ['cívico', 'ciudadano', 'patriótico', 'cultural', 'culturales', 'actividades cívicas']},
    '95-10': {'name': 'Terrenos', 'segment': 'Inmuebles', 'keywords': ['terreno', 'lote', 'parcela']},
    '95-11': {'name': 'Edificios', 'segment': 'Inmuebles', 'keywords': ['edificio', 'inmueble', 'local']},
    '99-99': {'name': 'Otros', 'segment': 'Otros', 'keywords': []},
}

def clasificar_keywords(descripcion):
    if not descripcion:
        return ('99-99', 'Otros', 'Otros')
    desc_lower = str(descripcion).lower()
    best_match = None
    max_score = 0
    for code, family in unspsc_taxonomy.items():
        if code == '99-99':
            continue
        score = sum(1 for kw in family['keywords'] if kw.lower() in desc_lower)
        if score > max_score:
            max_score = score
            best_match = code
    if best_match and max_score > 0:
        return (best_match, unspsc_taxonomy[best_match]['name'], unspsc_taxonomy[best_match]['segment'])
    return ('99-99', 'Otros', 'Otros')

# ============================================================================
# FUNCIONES AUXILIARES
# ============================================================================

def limpiar_monto(texto_monto):
    if not texto_monto:
        return None, None
    numeros = re.findall(r'[\d,\.]+', texto_monto)
    if not numeros:
        return None, None
    monto_str = numeros[0].replace(',', '')
    moneda = "USD" if ("USD" in texto_monto.upper() or "DÓLAR" in texto_monto.upper()) else "DOP"
    try:
        return Decimal(monto_str), moneda
    except:
        return None, None

def convertir_fecha(texto_fecha):
    if not texto_fecha:
        return None
    formatos = ["%d/%m/%Y %H:%M", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"]
    for fmt in formatos:
        try:
            return datetime.strptime(texto_fecha.strip(), fmt)
        except:
            continue
    return None

def conectar_base_datos():
    try:
        conn = psycopg2.connect(DATABASE_URL)
        print("✅ Conexión exitosa a base de datos")
        return conn
    except Exception as e:
        print(f"❌ Error conectando a BD: {e}")
        return None

# ============================================================================
# NUEVO — SISTEMA DE CONTINGENCIA
# ============================================================================

def registrar_falla_en_db(motivo):
    """
    Registra la falla del scraper en sistema_estado.
    motivo puede ser: 'portal_inaccesible' o 'estructura_modificada'
    Sólo actúa si el estado actual es NORMAL (evita sobrescribir alertas previas).
    """
    print(f"\n🚨 Registrando falla en DB: {motivo}")
    conn = conectar_base_datos()
    if not conn:
        print("⚠️  No se pudo conectar a BD para registrar falla")
        return

    try:
        cursor = conn.cursor()

        # Verificar estado actual
        cursor.execute("SELECT estado FROM sistema_estado WHERE id = 1")
        row = cursor.fetchone()
        estado_actual = row[0] if row else 'NORMAL'

        if estado_actual in ('ALERTA_PENDIENTE', 'SUSPENDIDO'):
            print(f"ℹ️  Sistema ya está en estado {estado_actual} — no se sobreescribe")
            cursor.close()
            conn.close()
            return

        # Registrar la falla
        cursor.execute("""
            UPDATE sistema_estado SET
                estado                        = 'ALERTA_PENDIENTE',
                motivo                        = %s,
                fecha_falla                   = NOW(),
                alerta_admin_enviada          = FALSE,
                notificacion_usuarios_enviada = FALSE,
                modal_activo                  = FALSE,
                abortado_por_admin            = FALSE,
                actualizado_en                = NOW()
            WHERE id = 1
        """, (motivo,))
        conn.commit()
        print(f"✅ Estado cambiado a ALERTA_PENDIENTE (motivo: {motivo})")

        # Enviar email al Admin
        email_enviado = enviar_alerta_admin(motivo)

        # Marcar alerta como enviada
        if email_enviado:
            cursor.execute("""
                UPDATE sistema_estado SET
                    alerta_admin_enviada = TRUE,
                    fecha_alerta_admin   = NOW(),
                    actualizado_en       = NOW()
                WHERE id = 1
            """)
            conn.commit()
            print("✅ Alerta de Admin marcada como enviada en DB")

        cursor.close()
        conn.close()

    except Exception as e:
        print(f"❌ Error registrando falla en DB: {e}")
        if conn:
            conn.rollback()
            conn.close()


def registrar_exito_en_db():
    """
    Cuando el scraper funciona correctamente, restaura el estado a NORMAL.
    Si estaba en ALERTA_PENDIENTE o SUSPENDIDO, también apaga el modal.
    """
    conn = conectar_base_datos()
    if not conn:
        return

    try:
        cursor = conn.cursor()
        cursor.execute("SELECT estado FROM sistema_estado WHERE id = 1")
        row = cursor.fetchone()
        estado_actual = row[0] if row else 'NORMAL'

        if estado_actual != 'NORMAL':
            cursor.execute("""
                UPDATE sistema_estado SET
                    estado         = 'NORMAL',
                    motivo         = NULL,
                    modal_activo   = FALSE,
                    actualizado_en = NOW()
                WHERE id = 1
            """)
            conn.commit()
            print(f"✅ Sistema restaurado a NORMAL (estaba en: {estado_actual})")
        else:
            print("✅ Sistema en estado NORMAL — sin cambios")

        cursor.close()
        conn.close()

    except Exception as e:
        print(f"❌ Error registrando éxito en DB: {e}")
        if conn:
            conn.close()


def enviar_alerta_admin(motivo):
    """
    Envía email de alerta al Admin vía Resend.
    Retorna True si fue exitoso, False si no.
    """
    if not RESEND_API_KEY:
        print("⚠️  RESEND_API_KEY no configurado — no se puede enviar alerta por email")
        return False

    descripciones = {
        'portal_inaccesible':   '🔌 El portal no respondió (sin conexión o caído)',
        'estructura_modificada': '🔧 El portal respondió, pero su estructura cambió (datos no reconocidos)'
    }
    descripcion = descripciones.get(motivo, motivo)
    hora_falla  = datetime.now().strftime('%d/%m/%Y %H:%M')

    html_body = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #c0392b; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h2 style="margin: 0;">⚠️ Alerta de Sistema — Compita</h2>
      </div>
      <div style="background: #f9f9f9; padding: 24px; border: 1px solid #ddd; border-radius: 0 0 8px 8px;">
        <p style="font-size: 16px;">El scraping diario ha <strong>fallado</strong>.</p>
        <table style="width:100%; border-collapse:collapse; margin-bottom:16px;">
          <tr style="background:#fff;">
            <td style="padding:10px; font-weight:bold; width:40%;">Causa:</td>
            <td style="padding:10px;">{descripcion}</td>
          </tr>
          <tr style="background:#f0f0f0;">
            <td style="padding:10px; font-weight:bold;">Hora de falla:</td>
            <td style="padding:10px;">{hora_falla} (hora del servidor)</td>
          </tr>
        </table>
        <hr style="margin: 20px 0; border: none; border-top: 1px solid #ddd;">
        <p>Tienes <strong>1 hora</strong> para revisar antes de que el sistema:</p>
        <ul>
          <li>Notifique a todos los usuarios suscritos</li>
          <li>Active el aviso de suspensión en la landing y el dashboard</li>
        </ul>
        <p>Si la situación no requiere escalar la alerta a usuarios, ve al panel de administración y haz clic en <strong>"Abortar notificación"</strong>.</p>
        <div style="text-align:center; margin: 24px 0;">
          <a href="https://compita.umbusk.com/admin"
             style="background:#c0392b; color:white; padding:14px 28px;
                    text-decoration:none; border-radius:6px; font-weight:bold;
                    display:inline-block;">
            Ir al Panel de Admin
          </a>
        </div>
        <p style="color:#999; font-size:12px;">Este mensaje fue generado automáticamente por el sistema de scraping de Compita.</p>
      </div>
    </div>
    """

    try:
        response = requests.post(
            'https://api.resend.com/emails',
            headers={
                'Authorization': f'Bearer {RESEND_API_KEY}',
                'Content-Type':  'application/json'
            },
            json={
                'from':    FROM_EMAIL,
                'to':      [ADMIN_EMAIL],
                'subject': f'⚠️ Compita: Scraping falló — {hora_falla}',
                'html':    html_body
            },
            timeout=15
        )
        if response.status_code in [200, 201]:
            print(f"✅ Alerta enviada al Admin: {ADMIN_EMAIL}")
            return True
        else:
            print(f"❌ Error enviando alerta: HTTP {response.status_code} — {response.text}")
            return False
    except Exception as e:
        print(f"❌ Excepción enviando alerta: {e}")
        return False


# ============================================================================
# FIX 1 — CONTAR licitaciones de HOY en la tabla cargada
# ============================================================================

def contar_licitaciones_hoy(celdas, hoy):
    count = 0
    for i in range(93, len(celdas) - 9, 10):
        try:
            texto = celdas[i+4].inner_text().strip()
            texto = texto.replace(" (UTC -4 hours)", "").replace(" (UTC -4 horas)", "").strip()
            fecha = convertir_fecha(texto)
            if fecha and fecha.date() == hoy:
                count += 1
        except:
            continue
    return count

# ============================================================================
# CLICK ROBUSTO
# ============================================================================

def hacer_click_ver_mas(page):
    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    time.sleep(2)

    try:
        resultado = page.evaluate("""
            () => {
                const todos = Array.from(document.querySelectorAll('a, button, span, div'));
                for (let el of todos) {
                    const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                    if (txt === 'ver más' || txt === 'ver mas') {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        el.click();
                        return true;
                    }
                }
                return false;
            }
        """)
        if resultado:
            time.sleep(6)
            return True
    except:
        pass

    selectores = [
        "text='Ver más'", "text='ver más'", "text='VER MÁS'",
        "a:has-text('Ver más')", "button:has-text('Ver más')",
        "text='More Items'", "a:has-text('More Items')"
    ]
    for sel in selectores:
        try:
            boton = page.locator(sel).first
            if boton.is_visible(timeout=3000):
                boton.scroll_into_view_if_needed()
                time.sleep(1)
                boton.click()
                time.sleep(6)
                return True
        except:
            continue

    return False

# ============================================================================
# SCRAPING PRINCIPAL
# ============================================================================

def scraping_diario():
    """
    Retorna una tupla (licitaciones, exito):
      - licitaciones: lista de dicts con los datos extraídos
      - exito: True si el scraping funcionó (aunque no haya licitaciones hoy),
               False si hubo una falla técnica del portal
    """
    print("\n" + "="*70)
    print("🚀 COMPITA - SCRAPING DIARIO v3")
    print(f"🕐 Inicio: {datetime.now().strftime('%d/%m/%Y %H:%M')}")
    print("="*70)
    print("🎯 Captura TODAS las licitaciones de HOY (parada inteligente mejorada)")
    print("🏷️  Clasificación UNSPSC automática\n")

    hoy = (datetime.utcnow() - timedelta(hours=4)).date()
    print(f"📅 Fecha de hoy (Santo Domingo): {hoy.strftime('%d/%m/%Y')}")
    print(f"🛑 Para cuando 2 clicks seguidos no agregan licitaciones nuevas de hoy\n")

    licitaciones_encontradas = []

    with sync_playwright() as p:
        print("📱 Iniciando navegador headless...")
        browser = p.chromium.launch(headless=HEADLESS)
        page    = browser.new_page()
        page.set_default_timeout(30000)

        try:
            # ----------------------------------------------------------------
            # NUEVO: Detectar portal_inaccesible
            # Si page.goto() o wait_for_selector fallan, es porque el portal
            # no está respondiendo o no tiene la tabla esperada.
            # ----------------------------------------------------------------
            print(f"🌐 Navegando al portal...")
            try:
                page.goto(PORTAL_URL, timeout=30000)
            except Exception as e:
                print(f"❌ FALLA DE CONEXIÓN: No se pudo acceder al portal — {e}")
                browser.close()
                registrar_falla_en_db('portal_inaccesible')
                return [], False

            print("⏳ Esperando tabla inicial...")
            try:
                page.wait_for_selector("table tbody tr", timeout=20000)
                print("✅ Tabla inicial cargada\n")
            except Exception as e:
                print(f"❌ FALLA DE CONEXIÓN: La tabla no apareció en el portal — {e}")
                browser.close()
                registrar_falla_en_db('portal_inaccesible')
                return [], False

            time.sleep(5)

            # ----------------------------------------------------------------
            # CLICKS CON PARADA INTELIGENTE (sin cambios)
            # ----------------------------------------------------------------
            print("🔄 Cargando licitaciones de hoy...")
            print("   (para cuando 2 clicks seguidos no agregan nada nuevo de hoy)\n")

            clicks            = 0
            max_clicks_seguridad = 30
            count_hoy_anterior   = 0
            clicks_sin_nuevas    = 0

            while clicks < max_clicks_seguridad:
                exito = hacer_click_ver_mas(page)

                if not exito:
                    print(f"\n   ℹ️  Botón 'Ver más' no encontrado — fin de páginas disponibles")
                    break

                clicks += 1
                print(f"   ✅ Click #{clicks}...")

                try:
                    filas = page.query_selector_all("table tbody tr")
                    for fila in filas:
                        celdas = fila.query_selector_all("td")
                        if len(celdas) > 100:
                            count_hoy_actual = contar_licitaciones_hoy(celdas, hoy)
                            print(f"   📅 Licitaciones de hoy visibles hasta ahora: {count_hoy_actual}")

                            if count_hoy_actual > count_hoy_anterior:
                                clicks_sin_nuevas  = 0
                                count_hoy_anterior = count_hoy_actual
                            else:
                                clicks_sin_nuevas += 1
                                print(f"   ⚠️  Sin nuevas de hoy ({clicks_sin_nuevas}/2)")
                                if clicks_sin_nuevas >= 2:
                                    print(f"\n🛑 2 clicks seguidos sin licitaciones nuevas — deteniendo")
                                    print(f"   ✅ Se hicieron {clicks} clicks en total\n")
                                    clicks = max_clicks_seguridad
                            break
                except Exception as e:
                    print(f"   ⚠️  Error revisando conteo: {e}")

            # ----------------------------------------------------------------
            # EXTRACCIÓN DE DATOS
            # ----------------------------------------------------------------
            print("\n" + "="*70)
            print("📊 EXTRAYENDO LICITACIONES DE HOY...")
            print("="*70 + "\n")

            time.sleep(2)
            filas = page.query_selector_all("table tbody tr")
            fila_principal = None
            for fila in filas:
                celdas = fila.query_selector_all("td")
                if len(celdas) > 100:
                    fila_principal = celdas
                    print(f"✅ {len(celdas)} celdas encontradas (~{(len(celdas)-93)//10} licitaciones totales)\n")
                    break

            # ----------------------------------------------------------------
            # NUEVO: Detectar estructura_modificada
            # Si la tabla existe pero no tiene la estructura que esperamos,
            # el portal fue modificado estructuralmente.
            # ----------------------------------------------------------------
            if not fila_principal:
                print("❌ FALLA DE ESTRUCTURA: Tabla encontrada pero formato no reconocido")
                browser.close()
                registrar_falla_en_db('estructura_modificada')
                return [], False

            total_procesadas    = 0
            omitidas_otra_fecha = 0

            for i in range(93, len(fila_principal) - 9, 10):
                try:
                    unidad         = fila_principal[i].inner_text().strip()
                    referencia     = fila_principal[i+1].inner_text().strip()
                    descripcion    = fila_principal[i+2].inner_text().strip()
                    fecha_pub_txt  = fila_principal[i+4].inner_text().strip()
                    fecha_pres_txt = fila_principal[i+5].inner_text().strip()
                    total_estimado = fila_principal[i+6].inner_text().strip()
                    estado         = fila_principal[i+7].inner_text().strip()

                    if not referencia:
                        continue

                    fecha_pub_limpia  = fecha_pub_txt.replace(" (UTC -4 hours)", "").replace(" (UTC -4 horas)", "").strip()
                    fecha_pres_limpia = fecha_pres_txt.replace(" (UTC -4 hours)", "").replace(" (UTC -4 horas)", "").strip()

                    fecha_publicacion  = convertir_fecha(fecha_pub_limpia)
                    fecha_presentacion = convertir_fecha(fecha_pres_limpia)

                    if not fecha_publicacion or fecha_publicacion.date() != hoy:
                        omitidas_otra_fecha += 1
                        continue

                    boton_detalle = fila_principal[i+8].query_selector("a")
                    url_detalle   = ""
                    if boton_detalle:
                        href = boton_detalle.get_attribute("href")
                        if href:
                            url_detalle = f"https://comunidad.comprasdominicana.gob.do{href}" if href.startswith("/") else href

                    monto, moneda = limpiar_monto(total_estimado)
                    codigo_unspsc, familia_unspsc, segmento_unspsc = clasificar_keywords(descripcion)

                    licitaciones_encontradas.append({
                        'unidad_compras':       unidad,
                        'referencia':           referencia,
                        'descripcion':          descripcion,
                        'fecha_publicacion':    fecha_publicacion,
                        'fecha_presentacion':   fecha_presentacion,
                        'total_estimado_texto': total_estimado,
                        'monto_estimado':       monto,
                        'moneda':               moneda,
                        'estado':               estado,
                        'url_detalle':          url_detalle,
                        'codigo_unspsc':        codigo_unspsc,
                        'familia_unspsc':       familia_unspsc,
                        'segmento_unspsc':      segmento_unspsc
                    })

                    total_procesadas += 1
                    if total_procesadas % 50 == 0:
                        print(f"   📌 {total_procesadas} licitaciones de hoy procesadas...")

                except Exception:
                    continue

            print(f"\n✅ Extracción completada:")
            print(f"   📅 Licitaciones de HOY:    {len(licitaciones_encontradas)}")
            print(f"   ⏭️  Omitidas (otra fecha): {omitidas_otra_fecha}")

        except Exception as e:
            # Cualquier error inesperado no capturado antes
            print(f"\n❌ Error inesperado durante scraping: {e}")
            import traceback
            traceback.print_exc()
            browser.close()
            # Intentar clasificar el tipo de error
            err_str = str(e).lower()
            if any(p in err_str for p in ['timeout', 'net::', 'connection', 'refused', 'dns', 'socket']):
                registrar_falla_en_db('portal_inaccesible')
            else:
                registrar_falla_en_db('estructura_modificada')
            return [], False

        finally:
            try:
                print("\n🔒 Cerrando navegador...")
                browser.close()
            except:
                pass

    return licitaciones_encontradas, True

# ============================================================================
# GUARDAR EN BASE DE DATOS (sin cambios)
# ============================================================================

def guardar_en_base_datos(licitaciones):
    if not licitaciones:
        print("\n⚠️  No hay licitaciones para guardar")
        return

    print(f"\n💾 Guardando {len(licitaciones)} licitaciones en BD...")

    vistas = set()
    unicas = []
    for lic in licitaciones:
        if lic['referencia'] not in vistas:
            unicas.append(lic)
            vistas.add(lic['referencia'])

    conn = conectar_base_datos()
    if not conn:
        return

    try:
        cursor = conn.cursor()

        valores = [(
            l['unidad_compras'], l['referencia'], l['descripcion'],
            l['fecha_publicacion'], l['fecha_presentacion'],
            l['total_estimado_texto'], l['monto_estimado'], l['moneda'],
            l['estado'], l['url_detalle'],
            l['codigo_unspsc'], l['familia_unspsc'], l['segmento_unspsc']
        ) for l in unicas]

        query = """
            INSERT INTO licitaciones (
                unidad_compras, referencia, descripcion,
                fecha_publicacion, fecha_presentacion,
                total_estimado_texto, monto_estimado, moneda,
                estado, url_detalle,
                codigo_unspsc, familia_unspsc, segmento_unspsc
            )
            VALUES %s
            ON CONFLICT (referencia) DO UPDATE SET
                estado          = EXCLUDED.estado,
                codigo_unspsc   = EXCLUDED.codigo_unspsc,
                familia_unspsc  = EXCLUDED.familia_unspsc,
                segmento_unspsc = EXCLUDED.segmento_unspsc,
                scrapeado_en    = NOW(),
                actualizado_en  = NOW()
        """
        execute_values(cursor, query, valores)
        conn.commit()

        print(f"✅ Guardado exitoso:")
        print(f"   Procesadas: {len(unicas)}")

        cursor.close()
        conn.close()

    except Exception as e:
        print(f"❌ Error guardando: {e}")
        import traceback
        traceback.print_exc()
        if conn:
            conn.rollback()
            conn.close()

# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    inicio = datetime.now()

    # scraping_diario() ahora retorna (licitaciones, exito)
    resultado = scraping_diario()
    licitaciones, exito = resultado if isinstance(resultado, tuple) else (resultado, True)

    print("\n" + "="*70)
    print("📊 RESUMEN FINAL")
    print("="*70)
    print(f"🕐 {datetime.now().strftime('%d/%m/%Y %H:%M')}")

    if exito:
        # Scraping funcionó — restaurar estado NORMAL si era necesario
        registrar_exito_en_db()
        print(f"📈 Licitaciones de hoy: {len(licitaciones)}")
        if licitaciones:
            guardar_en_base_datos(licitaciones)
        else:
            print("ℹ️  Sin licitaciones hoy (posible día festivo o portal sin publicaciones)")
    else:
        print("🚨 Scraping falló — alerta registrada en DB y enviada al Admin")

    duracion = (datetime.now() - inicio).total_seconds()
    print(f"⏱️  Duración: {duracion:.1f} segundos")
    print("✨ Completado\n")