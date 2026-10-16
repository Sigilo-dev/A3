# E3-C1 — Catálogo IoT identificado

Implementación del catálogo inicial de §13.4 y su relación con §6, §24.3 y A3-014. Este bloque aporta catálogo, instancias y puertos con procedencia. No implementa redes eléctricas, comprobación de compatibilidad, tabla de conexiones ni exportación de conexiones; esos resultados completos de A3-014 quedan pendientes del modelo de redes.

## Colecciones y componentes incluidos

El catálogo declarativo trae ESP32, Arduino, Raspberry Pi, sensores, actuadores, resistencias, alimentación y conectores genéricos. Los primeros siete contienen una pieza concreta; conectores contiene una plantilla sin puertos y no se puede instanciar hasta que el usuario la personalice. Estas categorías de catálogo no crean documentos `Collection` del proyecto ni sustituyen sus colecciones lógicas.

| Colección | Componente exacto | Puertos catalogados | Fabricante/modelo/revisión |
|---|---|---:|---|
| ESP32 | ESP32-DevKitC V4 con ESP32-WROOM-32E (`ESP32-DevKitC-32E`) | 38, J2/J3 | Espressif Systems; modelo y revisión de placa/módulo identificados |
| Arduino | UNO R3 (`A000066`) | 32, JANALOG/JDIGITAL (14 + 18) | Arduino; revisión Rev3 |
| Raspberry Pi | Pico W (`SC0918/SC0919`) | 40 | Raspberry Pi Ltd; revisión desconocida |
| Sensores | BME280, circuito integrado LGA de 8 pines | 8 | Bosch Sensortec; revisión de silicio desconocida; hoja de datos 1.23 |
| Actuadores | SG92R, servo de tres cables | 3 funciones de cable | TowerPro; revisión desconocida |
| Resistencias | RC0603FR-0710KL, 10 kΩ | 2 pads | YAGEO; revisión desconocida |
| Fuentes de alimentación | PowerBoost 1000C, producto 2465 | 7 funciones | Adafruit; revisión de placa desconocida |
| Conectores genéricos | Plantilla A3 | 0 | Fabricante/modelo/revisión desconocidos; no es una pieza comercial |

Los puertos guardan ID, etiqueta, función, dirección del contrato, tipo de señal, bus posible, límites conocidos/desconocidos y referencias a la fuente. Los buses de Pico son funciones alternativas posibles del GPIO, no conexiones configuradas. Límites por pin que no estén publicados quedan en `unknown`; no se copia una especificación global del chip como límite de cada GPIO. Los pines de flash del DevKitC se marcan como reservados de acuerdo con esa variante exacta.

Cada instancia se guarda como Entity `a3.iot.component@1.0.0` con `properties["a3.iot.component"]` para fabricante, modelo, revisión, colección, fuentes y versión del modelo, y con sus puertos en `Entity.ports`. La instancia y su Placement se crean en un comando de dominio reversible y pasan por el broker del host. Los IDs de puerto son locales a la instancia y estables; la colección o pertenencia no asigna semántica de exportación.

## Fuentes de piezas

- [Espressif ESP32-DevKitC V4, guía con módulo WROOM-32E y tablas J2/J3](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/esp32-devkitc/user_guide.html)
- [Arduino UNO R3, datasheet A000066](https://docs.arduino.cc/resources/datasheets/A000066-datasheet.pdf)
- [Arduino UNO R3 full pinout, SKU A000066](https://content.arduino.cc/assets/A000066-full-pinout.pdf), fuente de los límites de corriente de E/S y el pin 3V3 registrados en la tabla del catálogo.
- [Raspberry Pi Pico W pinout](https://datasheets.raspberrypi.com/picow/PicoW-A4-Pinout.pdf) y [documentación Pico](https://www.raspberrypi.com/documentation/microcontrollers/pico-series.html)
- [Bosch Sensortec BME280 datasheet](https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bme280-ds002.pdf), BST-BME280-DS001-23 Rev. 1.23; [página del producto y rangos de alimentación/medición](https://www.bosch-sensortec.com/en/products/environmental-sensors/humidity-sensors-bme280)
- [TowerPro SG92R, ficha del producto 169 y tensión indicada](https://www.adafruit.com/product/169); [guía de cableado de servos](https://learn.adafruit.com/using-servos-with-circuitpython/hardware). La función de los IDs representa tierra, alimentación y señal; no añade numeración de cavidad del conector.
- [YAGEO RC0603FR-0710KL, ficha del fabricante](https://www.yageogroup.com/component-documentation/download/specsheet/RC0603FR-0710KL)
- [Adafruit PowerBoost 1000C, producto 2465](https://www.adafruit.com/product/2465) y [tabla de pines](https://learn.adafruit.com/adafruit-powerboost-1000c-load-share-usb-charge-boost/pinouts)

## Criterios y límites

| Criterio | Aporte de E3-C1 | Pendiente |
|---|---|---|
| §6, identidad y campos extensibles | Entity/Placement con IDs estables, campos del catálogo versionados y campos desconocidos conservados. | Migraciones/paquetes personalizados posteriores. |
| §13.4, catálogos y puertos | Ocho colecciones visibles; siete referencias concretas exactas y una plantilla genérica; direcciones, señal, bus y límites explícitos. | Colecciones de catálogo comunitarias y editor de tipos custom. |
| §24.3, pertenencia no concede semántica | El catálogo sólo agrupa; no registra una relación técnica/exportador. | Mapeos/exportadores declarados por tipos y paquetes futuros. |
| A3-014, conexión de pines | La UI instancia componentes con IDs de puertos y muestra su procedencia. | Conectar puertos en redes eléctricas, validar incompatibilidad conocida y exportar la tabla de conexiones con IDs. VisualEdge conserva solo su significado organizativo. |

La fixture de [catálogo](../../fixtures/e3/iot/catalog.json) fija IDs, conteos y estados de fabricante/revisión que se probaron contra las fuentes concretas. Las pruebas del dominio cubren los puertos y los estados desconocidos; las pruebas del store cubren permiso, escritura local y reapertura. La prueba UI de Electron verifica insertar e inspeccionar una pieza desde la aplicación. Se ejecutan con `npm run test --workspace @a3/domain`, `npm run test --workspace @a3/project-store` y `npm run test:iot --workspace @a3/desktop`.
