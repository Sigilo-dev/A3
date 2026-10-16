import { copy, diagnostic, isObject, UUID_PATTERN } from './data.js';
import type { Diagnostic, DomainSnapshot, Entity, ExtensionMap, NodeType, Port, TypeRegistry } from './models.js';

export const IOT_VERSION = '1.0.0';
export const IOT_COMPONENT_TYPE = 'a3.iot.component';
export const IOT_METADATA_KEY = 'a3.iot.component';

export type IotPortDirection = 'input' | 'output' | 'bidirectional' | 'power' | 'passive';
export type IotKnown<T> = { state: 'known'; value: T } | { state: 'unknown'; reason: string };
export type IotSource = { title: string; url: string; documentRevision?: string };
export interface IotPort extends Port {
  function: string;
  direction: IotPortDirection;
  signalType: IotKnown<string>;
  /** Possible alternate bus functions documented for this exact port; this is not a configured bus connection. */
  bus: IotKnown<string[]>;
  limits: Record<string, IotKnown<{ min?: number; max?: number; nominal?: number; unit: string }>>;
  sourceIds: number[];
  availability?: 'available' | 'reserved' | 'not-connected';
}
export interface IotComponentMetadata {
  catalogId: string;
  collectionId: IotCollectionId;
  manufacturer: IotKnown<string>;
  model: string;
  revision: IotKnown<string>;
  sources: IotSource[];
  description: string;
  componentRevision: typeof IOT_VERSION;
}
export type IotCollectionId = typeof IOT_COLLECTIONS[number]['id'];
export interface IotCatalogEntry extends IotComponentMetadata {
  title: string;
  ports: IotPort[];
  template?: boolean;
}

const yes = <T>(value: T): IotKnown<T> => ({ state: 'known', value });
const unknown = <T = never>(reason: string): IotKnown<T> => ({ state: 'unknown', reason });
const noLimits = () => ({ electrical: unknown<{ min?: number; max?: number; nominal?: number; unit: string }>('No se publicaron límites por puerto en la fuente consultada.') });
const p = (id: string, label: string, direction: IotPortDirection, fn: string, signal: string, buses: string[] | null,
  limits: IotPort['limits'] = noLimits(), sourceIds: number[] = [0], availability: IotPort['availability'] = 'available'): IotPort => ({
  id, label, direction, function: fn, signalType: yes(signal), bus: buses ? yes(buses) : unknown('La fuente no fija un bus para este puerto.'), limits, sourceIds,
  ...(availability === 'available' ? {} : { availability })
});
const unknownRevision = unknown<string>('La fuente del fabricante no identifica una revisión de este componente.');

export const IOT_COLLECTIONS = [
  { id: 'a3.iot.collection.esp32', label: 'ESP32', category: 'board' },
  { id: 'a3.iot.collection.arduino', label: 'Arduino', category: 'board' },
  { id: 'a3.iot.collection.raspberry-pi', label: 'Raspberry Pi', category: 'board' },
  { id: 'a3.iot.collection.sensors', label: 'Sensores', category: 'sensor' },
  { id: 'a3.iot.collection.actuators', label: 'Actuadores', category: 'actuator' },
  { id: 'a3.iot.collection.resistors', label: 'Resistencias', category: 'passive' },
  { id: 'a3.iot.collection.power', label: 'Fuentes de alimentación', category: 'power' },
  { id: 'a3.iot.collection.connectors', label: 'Conectores genéricos', category: 'connector' }
] as const;

const espSources: IotSource[] = [{ title: 'ESP32-DevKitC V4 user guide (ESP32-WROOM-32E)',
  url: 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/esp32-devkitc/user_guide.html' }];
const espPinData: [string, string, string, 'input' | 'bidirectional' | 'power', string, ('available' | 'reserved')?][] = [
  ['j2.01', '3V3', '3.3 V power supply', 'power', 'power'], ['j2.02', 'EN', 'CHIP_PU, Reset', 'input', 'reset'],
  ['j2.03', 'VP', 'GPIO36, ADC1_CH0, S_VP', 'input', 'analog-or-digital-input'], ['j2.04', 'VN', 'GPIO39, ADC1_CH3, S_VN', 'input', 'analog-or-digital-input'],
  ['j2.05', 'IO34', 'GPIO34, ADC1_CH6, VDET_1', 'input', 'analog-or-digital-input'], ['j2.06', 'IO35', 'GPIO35, ADC1_CH7, VDET_2', 'input', 'analog-or-digital-input'],
  ['j2.07', 'IO32', 'GPIO32, ADC1_CH4, TOUCH_CH9, XTAL_32K_P', 'bidirectional', 'gpio'], ['j2.08', 'IO33', 'GPIO33, ADC1_CH5, TOUCH_CH8, XTAL_32K_N', 'bidirectional', 'gpio'],
  ['j2.09', 'IO25', 'GPIO25, ADC2_CH8, DAC_1', 'bidirectional', 'gpio'], ['j2.10', 'IO26', 'GPIO26, ADC2_CH9, DAC_2', 'bidirectional', 'gpio'],
  ['j2.11', 'IO27', 'GPIO27, ADC2_CH7, TOUCH_CH7', 'bidirectional', 'gpio'], ['j2.12', 'IO14', 'GPIO14, ADC2_CH6, TOUCH_CH6, MTMS', 'bidirectional', 'gpio'],
  ['j2.13', 'IO12', 'GPIO12, ADC2_CH5, TOUCH_CH5, MTDI', 'bidirectional', 'gpio'], ['j2.14', 'GND', 'Ground', 'power', 'ground'],
  ['j2.15', 'IO13', 'GPIO13, ADC2_CH4, TOUCH_CH4, MTCK', 'bidirectional', 'gpio'], ['j2.16', 'D2', 'GPIO9, D2; shared with SPI flash memory', 'bidirectional', 'gpio', 'reserved'],
  ['j2.17', 'D3', 'GPIO10, D3; shared with SPI flash memory', 'bidirectional', 'gpio', 'reserved'], ['j2.18', 'CMD', 'GPIO11, CMD; shared with SPI flash memory', 'bidirectional', 'gpio', 'reserved'],
  ['j2.19', '5V', '5 V power supply', 'power', 'power'], ['j3.01', 'GND', 'Ground', 'power', 'ground'],
  ['j3.02', 'IO23', 'GPIO23', 'bidirectional', 'gpio'], ['j3.03', 'IO22', 'GPIO22', 'bidirectional', 'gpio'], ['j3.04', 'TX', 'GPIO1, U0TXD', 'bidirectional', 'digital-io'],
  ['j3.05', 'RX', 'GPIO3, U0RXD', 'bidirectional', 'digital-io'], ['j3.06', 'IO21', 'GPIO21', 'bidirectional', 'gpio'], ['j3.07', 'GND', 'Ground', 'power', 'ground'],
  ['j3.08', 'IO19', 'GPIO19', 'bidirectional', 'gpio'], ['j3.09', 'IO18', 'GPIO18', 'bidirectional', 'gpio'], ['j3.10', 'IO5', 'GPIO5', 'bidirectional', 'gpio'],
  ['j3.11', 'IO17', 'GPIO17', 'bidirectional', 'gpio'], ['j3.12', 'IO16', 'GPIO16', 'bidirectional', 'gpio'], ['j3.13', 'IO4', 'GPIO4, ADC2_CH0, TOUCH_CH0', 'bidirectional', 'gpio'],
  ['j3.14', 'IO0', 'GPIO0, ADC2_CH1, TOUCH_CH1, Boot', 'bidirectional', 'gpio'], ['j3.15', 'IO2', 'GPIO2, ADC2_CH2, TOUCH_CH2', 'bidirectional', 'gpio'],
  ['j3.16', 'IO15', 'GPIO15, ADC2_CH3, TOUCH_CH3, MTDO', 'bidirectional', 'gpio'], ['j3.17', 'D1', 'GPIO8, D1; shared with SPI flash memory', 'bidirectional', 'gpio', 'reserved'],
  ['j3.18', 'D0', 'GPIO7, D0; shared with SPI flash memory', 'bidirectional', 'gpio', 'reserved'], ['j3.19', 'CLK', 'GPIO6, CLK; shared with SPI flash memory', 'bidirectional', 'gpio', 'reserved']
];
const espPorts = espPinData.map(([id, label, fn, direction, signal, availability]) => p(id, label, direction, fn, signal, null,
  label === '3V3' ? { voltage: yes({ nominal: 3.3, unit: 'V' }) } : label === '5V' ? { voltage: yes({ nominal: 5, unit: 'V' }) } : noLimits(), [0], availability));

const arduinoSources: IotSource[] = [{ title: 'Arduino UNO R3 datasheet, SKU A000066', url: 'https://docs.arduino.cc/resources/datasheets/A000066-datasheet.pdf', documentRevision: 'Modified 14/10/2026' },
  { title: 'Arduino UNO R3 full pinout, SKU A000066', url: 'https://content.arduino.cc/assets/A000066-full-pinout.pdf' }];
const unoAnalog: [string, string, IotPortDirection, string][] = [
  ['NC', 'Not connected', 'passive', 'not-connected'], ['IOREF', 'Digital logic reference; connected to 5V', 'power', 'power'], ['RESET', 'Reset', 'input', 'reset'],
  ['3V3', '+3V3 power rail', 'power', 'power'], ['5V', '+5V power rail', 'power', 'power'], ['GND', 'Ground', 'power', 'ground'], ['GND', 'Ground', 'power', 'ground'],
  ['VIN', 'Voltage input', 'power', 'power'], ...(['A0', 'A1', 'A2', 'A3'].map((name) => [name, `Analog input ${name.slice(1)} / GPIO`, 'bidirectional', 'analog-or-digital-io'] as [string, string, IotPortDirection, string])),
  ['A4/SDA', 'Analog input 4 / I2C data', 'bidirectional', 'digital-io'], ['A5/SCL', 'Analog input 5 / I2C clock', 'bidirectional', 'digital-io']
] ;
const unoDigital: [string, string, IotPortDirection, string][] = [
  ...Array.from({ length: 10 }, (_, i): [string, string, IotPortDirection, string] => [`D${i}`, `Digital pin ${i} / GPIO`, 'bidirectional', 'digital-io']),
  ['SS', 'SPI chip select', 'bidirectional', 'digital-io'], ['MOSI', 'SPI1 main out secondary in', 'bidirectional', 'digital-io'],
  ['MISO', 'SPI main in secondary out', 'bidirectional', 'digital-io'], ['SCK', 'SPI serial clock output', 'bidirectional', 'digital-io'], ['GND', 'Ground', 'power', 'ground'],
  ['AREF', 'Analog reference voltage', 'input', 'analog-input'], ['A4/SDA', 'Analog input 4 / I2C data (duplicated)', 'bidirectional', 'digital-io'],
  ['A5/SCL', 'Analog input 5 / I2C clock (duplicated)', 'bidirectional', 'digital-io']
] as const;
const unoDigitalIoLabels = new Set(['A0', 'A1', 'A2', 'A3', 'A4/SDA', 'A5/SCL', ...Array.from({ length: 14 }, (_, i) => `D${i}`), 'SS', 'MOSI', 'MISO', 'SCK']);
const unoIoCurrentLimit = (label: string): IotPort['limits'] => unoDigitalIoLabels.has(label) ? { current: yes({ max: 20, unit: 'mA' }) } : noLimits();
const unoPorts: IotPort[] = [
  ...unoAnalog.map(([label, fn, direction, signal], i) => p(`janalog.${String(i + 1).padStart(2, '0')}`, label, direction, fn, signal,
    label === 'A4/SDA' ? ['I2C data'] : label === 'A5/SCL' ? ['I2C clock'] : null,
    label === 'VIN' ? { voltage: yes({ min: 6, max: 20, unit: 'V' }) } : label === '3V3' ? { current: yes({ max: 50, unit: 'mA' }) } :
      unoIoCurrentLimit(label), [0, 1])),
  ...unoDigital.map(([label, fn, direction, signal], i) => p(`jdigital.${String(i + 1).padStart(2, '0')}`, label, direction, fn, signal,
    ['SS', 'MOSI', 'MISO', 'SCK'].includes(label) ? ['SPI'] : label === 'A4/SDA' ? ['I2C data'] : label === 'A5/SCL' ? ['I2C clock'] : null,
    unoIoCurrentLimit(label), [0, 1]))
];

const picoSources: IotSource[] = [{ title: 'Raspberry Pi Pico W pinout', url: 'https://datasheets.raspberrypi.com/picow/PicoW-A4-Pinout.pdf' },
  { title: 'Raspberry Pi Pico series documentation', url: 'https://www.raspberrypi.com/documentation/microcontrollers/pico-series.html' }];
const picoLeft: [number, string, string, IotPortDirection, string, string[]?][] = [
  [1, 'GP0', 'UART0 TX, I2C0 SDA, SPI0 RX', 'bidirectional', 'gpio', ['UART0', 'I2C0', 'SPI0']],
  [2, 'GP1', 'UART0 RX, I2C0 SCL, SPI0 CSn', 'bidirectional', 'gpio', ['UART0', 'I2C0', 'SPI0']], [3, 'GND', 'Ground', 'power', 'ground'],
  [4, 'GP2', 'I2C1 SDA, SPI0 SCK', 'bidirectional', 'gpio', ['I2C1', 'SPI0']], [5, 'GP3', 'I2C1 SCL, SPI0 TX', 'bidirectional', 'gpio', ['I2C1', 'SPI0']],
  [6, 'GP4', 'UART1 TX, I2C0 SDA, SPI0 RX', 'bidirectional', 'gpio', ['UART1', 'I2C0', 'SPI0']], [7, 'GP5', 'UART1 RX, I2C0 SCL, SPI0 CSn', 'bidirectional', 'gpio', ['UART1', 'I2C0', 'SPI0']],
  [8, 'GND', 'Ground', 'power', 'ground'], [9, 'GP6', 'I2C1 SDA, SPI0 SCK', 'bidirectional', 'gpio', ['I2C1', 'SPI0']], [10, 'GP7', 'I2C1 SCL, SPI0 TX', 'bidirectional', 'gpio', ['I2C1', 'SPI0']],
  [11, 'GP8', 'UART1 TX, I2C0 SDA, SPI1 RX', 'bidirectional', 'gpio', ['UART1', 'I2C0', 'SPI1']], [12, 'GP9', 'UART1 RX, I2C0 SCL, SPI1 CSn', 'bidirectional', 'gpio', ['UART1', 'I2C0', 'SPI1']],
  [13, 'GND', 'Ground', 'power', 'ground'], [14, 'GP10', 'I2C1 SDA, SPI1 SCK', 'bidirectional', 'gpio', ['I2C1', 'SPI1']], [15, 'GP11', 'I2C1 SCL, SPI1 TX', 'bidirectional', 'gpio', ['I2C1', 'SPI1']],
  [16, 'GP12', 'UART0 TX, I2C0 SDA, SPI1 RX', 'bidirectional', 'gpio', ['UART0', 'I2C0', 'SPI1']], [17, 'GP13', 'UART0 RX, I2C0 SCL, SPI1 CSn', 'bidirectional', 'gpio', ['UART0', 'I2C0', 'SPI1']],
  [18, 'GND', 'Ground', 'power', 'ground'], [19, 'GP14', 'I2C1 SDA, SPI1 SCK', 'bidirectional', 'gpio', ['I2C1', 'SPI1']], [20, 'GP15', 'I2C1 SCL, SPI1 TX', 'bidirectional', 'gpio', ['I2C1', 'SPI1']]
];
const picoRight: [number, string, string, IotPortDirection, string, string[]?][] = [
  [40, 'VBUS', '5 V USB input', 'power', 'power'], [39, 'VSYS', 'System input, 2–5 V', 'power', 'power'], [38, 'GND', 'Ground', 'power', 'ground'],
  [37, '3V3_EN', '3.3 V enable; pull low to turn the board off', 'input', 'control'], [36, '3V3(OUT)', '3.3 V regulated output', 'power', 'power'],
  [35, 'ADC_VREF', 'ADC reference voltage', 'input', 'analog-input'], [34, 'GP28', 'ADC2', 'bidirectional', 'gpio'], [33, 'GND/AGND', 'Ground / analog ground', 'power', 'ground'],
  [32, 'GP27', 'ADC1, I2C1 SCL', 'bidirectional', 'gpio', ['I2C1']], [31, 'GP26', 'ADC0, I2C1 SDA', 'bidirectional', 'gpio', ['I2C1']],
  [30, 'RUN', 'Microcontroller reset', 'input', 'reset'], [29, 'GP22', 'GPIO', 'bidirectional', 'gpio'], [28, 'GND', 'Ground', 'power', 'ground'],
  [27, 'GP21', 'I2C0 SCL', 'bidirectional', 'gpio', ['I2C0']], [26, 'GP20', 'I2C0 SDA', 'bidirectional', 'gpio', ['I2C0']],
  [25, 'GP19', 'SPI0 TX, I2C1 SCL', 'bidirectional', 'gpio', ['SPI0', 'I2C1']], [24, 'GP18', 'SPI0 SCK, I2C1 SDA', 'bidirectional', 'gpio', ['SPI0', 'I2C1']],
  [23, 'GND', 'Ground', 'power', 'ground'], [22, 'GP17', 'SPI0 CSn, I2C0 SCL, UART0 RX', 'bidirectional', 'gpio', ['SPI0', 'I2C0', 'UART0']],
  [21, 'GP16', 'SPI0 RX, I2C0 SDA, UART0 TX', 'bidirectional', 'gpio', ['SPI0', 'I2C0', 'UART0']]
];
const picoPowerLimits = (label: string): IotPort['limits'] => label === 'VSYS' ? { voltage: yes({ min: 2, max: 5, unit: 'V' }) } :
  label === 'VBUS' ? { voltage: yes({ nominal: 5, unit: 'V' }) } : label === '3V3(OUT)' ? { voltage: yes({ nominal: 3.3, unit: 'V' }) } : noLimits();
const picoPorts: IotPort[] = [
  ...picoLeft.map(([pin, label, fn, direction, signal, buses]) => p(`header.${pin}`, label, direction, fn, signal, buses ?? null, noLimits(), [0])),
  ...picoRight.map(([pin, label, fn, direction, signal, buses]) => p(`header.${pin}`, label, direction, fn, signal, buses ?? null, picoPowerLimits(label), [0]))
];

const bmeSources: IotSource[] = [{ title: 'Bosch Sensortec BME280 datasheet', url: 'https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bme280-ds002.pdf', documentRevision: 'BST-BME280-DS001-23 Revision 1.23 (2022-01)' },
  { title: 'Bosch Sensortec BME280 product page', url: 'https://www.bosch-sensortec.com/en/products/environmental-sensors/humidity-sensors-bme280' }];
const bmePorts: IotPort[] = [
  p('package.1', 'GND', 'power', 'Ground', 'ground', null, noLimits()), p('package.2', 'CSB', 'input', 'SPI chip select; tie to VDDIO for I²C mode', 'digital-control', ['SPI'], noLimits()),
  p('package.3', 'SDI/SDA', 'bidirectional', 'SPI data input or I²C data', 'digital-data', ['SPI', 'I2C'], noLimits()),
  p('package.4', 'SCK/SCL', 'input', 'SPI clock or I²C clock', 'digital-clock', ['SPI', 'I2C'], noLimits()),
  p('package.5', 'SDO', 'bidirectional', 'SPI data output; I²C address selection (GND default)', 'digital-data', ['SPI'], noLimits()),
  p('package.6', 'VDDIO', 'power', 'Digital/interface supply', 'power', null, { voltage: yes({ min: 1.2, max: 3.6, unit: 'V' }) }),
  p('package.7', 'GND', 'power', 'Ground', 'ground', null, noLimits()),
  p('package.8', 'VDD', 'power', 'Analog supply', 'power', null, { voltage: yes({ min: 1.71, max: 3.6, unit: 'V' }) })
];

const sg92Sources: IotSource[] = [{ title: 'TowerPro SG92R listing (product ID 169)', url: 'https://www.adafruit.com/product/169' },
  { title: 'Adafruit servo wiring guide', url: 'https://learn.adafruit.com/using-servos-with-circuitpython/hardware' }];
const sg92Ports = [
  p('wire.ground', 'GND · marrón/negro', 'power', 'Retorno/alimentación de tierra', 'ground', null, noLimits(), [0, 1]),
  p('wire.power', 'V+ · rojo', 'power', 'Alimentación del servomotor', 'power', null, { voltage: yes({ min: 3, max: 6, unit: 'V DC' }) }, [0, 1]),
  p('wire.signal', 'Signal · naranja/amarillo', 'input', 'Entrada de control por pulso', 'servo-control', null, noLimits(), [0, 1])
];

const yageoSources: IotSource[] = [{ title: 'YAGEO RC0603FR-0710KL specification', url: 'https://www.yageogroup.com/component-documentation/download/specsheet/RC0603FR-0710KL' }];
const resistorPorts = [p('pad.1', 'Pad 1', 'passive', 'Terminal pasivo no polarizado', 'passive-terminal', null, noLimits()),
  p('pad.2', 'Pad 2', 'passive', 'Terminal pasivo no polarizado', 'passive-terminal', null, noLimits())];

const powerSources: IotSource[] = [{ title: 'Adafruit PowerBoost 1000C product page (product ID 2465)', url: 'https://www.adafruit.com/product/2465' },
  { title: 'Adafruit PowerBoost 1000C pinout guide', url: 'https://learn.adafruit.com/adafruit-powerboost-1000c-load-share-usb-charge-boost/pinouts' }];
const powerPorts = [
  p('usb-in', 'USB', 'power', 'Entrada micro-USB para carga', 'power', null, { voltage: yes({ min: 4.75, max: 5.25, unit: 'V' }) }, [1]),
  p('battery-in', 'BAT', 'power', 'Entrada para batería Li-ion/LiPo', 'power', null, { voltage: yes({ min: 3, max: 4.2, unit: 'V' }) }, [1]),
  p('shared-vs', 'VS', 'power', 'Salida compartida de cargador/batería; depende del estado USB', 'power', null, noLimits(), [1]),
  p('ground', 'GND', 'power', 'Tierra común de entrada y salida', 'ground', null, noLimits(), [1]),
  p('boosted-5v', '5V', 'power', 'Salida boost', 'power', null, { voltage: yes({ min: 5, max: 5.2, unit: 'V' }) }, [1]),
  p('enable', 'EN', 'input', 'Habilitación; conectar a GND deshabilita el convertidor', 'digital-control', null, noLimits(), [1]),
  p('low-battery', 'LBO', 'output', 'Salida de batería baja; cae a 0 V bajo el umbral documentado', 'digital-status', null, noLimits(), [1])
];

export const IOT_CATALOG: readonly IotCatalogEntry[] = [
  { catalogId: 'espressif.esp32-devkitc-v4-32e', collectionId: 'a3.iot.collection.esp32', title: 'ESP32-DevKitC V4 · ESP32-WROOM-32E', manufacturer: yes('Espressif Systems'), model: 'ESP32-DevKitC-32E / ESP32-WROOM-32E', revision: yes('DevKitC V4; módulo WROOM-32E'), sources: espSources, description: 'Variante exacta del DevKitC V4 documentada con módulo WROOM-32E; varios GPIO están reservados para flash.', componentRevision: IOT_VERSION, ports: espPorts },
  { catalogId: 'arduino.uno-r3-a000066', collectionId: 'a3.iot.collection.arduino', title: 'Arduino UNO R3 · A000066', manufacturer: yes('Arduino'), model: 'UNO R3 · SKU A000066', revision: yes('Rev3'), sources: arduinoSources, description: 'Pinout JANALOG y JDIGITAL del datasheet A000066. Los pines repetidos en ambos headers conservan IDs físicos distintos.', componentRevision: IOT_VERSION, ports: unoPorts },
  { catalogId: 'raspberry-pi.pico-w-sc0918', collectionId: 'a3.iot.collection.raspberry-pi', title: 'Raspberry Pi Pico W · SC0918/SC0919', manufacturer: yes('Raspberry Pi Ltd'), model: 'Pico W · SC0918/SC0919', revision: unknownRevision, sources: picoSources, description: 'Los buses listados son funciones alternativas documentadas del GPIO; no indican qué función está configurada.', componentRevision: IOT_VERSION, ports: picoPorts },
  { catalogId: 'bosch.bme280', collectionId: 'a3.iot.collection.sensors', title: 'Bosch Sensortec BME280', manufacturer: yes('Bosch Sensortec'), model: 'BME280 · 8-pin LGA', revision: unknown<string>('La hoja de datos identifica la revisión del documento, no la revisión del silicio.'), sources: bmeSources, description: 'Modelo del circuito integrado. El paquete del sensor no es un módulo breakout.', componentRevision: IOT_VERSION, ports: bmePorts },
  { catalogId: 'towerpro.sg92r', collectionId: 'a3.iot.collection.actuators', title: 'TowerPro SG92R', manufacturer: yes('TowerPro'), model: 'SG92R', revision: unknownRevision, sources: sg92Sources, description: 'Servomotor de tres cables. Los IDs representan funciones de cable, no un número de cavidad no documentado.', componentRevision: IOT_VERSION, ports: sg92Ports },
  { catalogId: 'yageo.rc0603fr-0710kl', collectionId: 'a3.iot.collection.resistors', title: 'YAGEO RC0603FR-0710KL · 10 kΩ', manufacturer: yes('YAGEO'), model: 'RC0603FR-0710KL', revision: unknownRevision, sources: yageoSources, description: 'Resistor SMD 0603, 10 kΩ, tolerancia 1 %, potencia nominal 0.1 W a 70 °C.', componentRevision: IOT_VERSION, ports: resistorPorts },
  { catalogId: 'adafruit.powerboost-1000c-2465', collectionId: 'a3.iot.collection.power', title: 'Adafruit PowerBoost 1000C · 2465', manufacturer: yes('Adafruit Industries'), model: 'PowerBoost 1000C · product ID 2465', revision: unknownRevision, sources: powerSources, description: 'Convertidor/cargador boost; no equivale a una fuente regulada universal ni implica que su salida pueda alimentar cualquier componente.', componentRevision: IOT_VERSION, ports: powerPorts },
  { catalogId: 'a3.generic.connector', collectionId: 'a3.iot.collection.connectors', title: 'Conector genérico · plantilla', manufacturer: unknown('Plantilla lógica de A3; no identifica un producto fabricado.'), model: 'generic connector template', revision: unknown('La plantilla no corresponde a una pieza concreta.'), sources: [{ title: 'Especificación maestra A3 §13.4 y §24.3', url: 'A3_ESPECIFICACION_MAESTRA.md#134-iot' }], description: 'Plantilla vacía: añade un conector con IDs y datos de fabricante/modelo propios antes de usarlo en diseño físico.', componentRevision: IOT_VERSION, ports: [], template: true }
];

export function iotCatalogEntry(catalogId: string): IotCatalogEntry | undefined {
  const item = IOT_CATALOG.find((entry) => entry.catalogId === catalogId);
  return item ? copy(item) : undefined;
}
export function iotEntryPorts(entry: IotCatalogEntry): IotPort[] { return copy(entry.ports); }
export function iotMetadata(entry: IotCatalogEntry): IotComponentMetadata {
  const { ports: _ports, title: _title, template: _template, ...metadata } = copy(entry);
  return metadata;
}
export function iotData(entity: Pick<Entity, 'type' | 'typeVersion' | 'properties'>): IotComponentMetadata | undefined {
  if (entity.type !== IOT_COMPONENT_TYPE || entity.typeVersion !== IOT_VERSION) return undefined;
  const value = entity.properties[IOT_METADATA_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = value as unknown as IotComponentMetadata;
  const entry = IOT_CATALOG.find((candidate) => candidate.catalogId === data.catalogId);
  return entry && data.componentRevision === IOT_VERSION && data.collectionId === entry.collectionId && typeof data.model === 'string' &&
    Array.isArray(data.sources) && data.sources.every((source) => source && typeof source.title === 'string' && typeof source.url === 'string') ? data : undefined;
}
function validEvidence(value: unknown, payload: (value: unknown) => boolean): boolean {
  return isObject(value) && (value.state === 'known' ? payload(value.value) : value.state === 'unknown' && typeof value.reason === 'string' && value.reason.trim().length > 0);
}
function validIotPort(value: unknown): value is IotPort {
  if (!isObject(value) || typeof value.id !== 'string' || !value.id || typeof value.label !== 'string' || !value.label ||
      typeof value.function !== 'string' || !value.function || !['input', 'output', 'bidirectional', 'power', 'passive'].includes(String(value.direction)) ||
      !validEvidence(value.signalType, (item) => typeof item === 'string' && !!item) ||
      !validEvidence(value.bus, (item) => Array.isArray(item) && item.every((entry) => typeof entry === 'string' && !!entry)) ||
      !isObject(value.limits) || !Array.isArray(value.sourceIds) || !value.sourceIds.length ||
      !value.sourceIds.every((sourceId) => Number.isSafeInteger(sourceId) && Number(sourceId) >= 0) ||
      value.availability !== undefined && !['available', 'reserved', 'not-connected'].includes(String(value.availability))) return false;
  return Object.values(value.limits).every((limit) => validEvidence(limit, (item) => isObject(item) && typeof item.unit === 'string' && !!item.unit &&
    Object.entries(item).every(([key, part]) => key === 'unit' || ['min', 'max', 'nominal'].includes(key) && typeof part === 'number' && Number.isFinite(part))));
}
function validMetadata(value: unknown): value is IotComponentMetadata {
  return isObject(value) && typeof value.catalogId === 'string' && /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(value.catalogId) &&
    typeof value.collectionId === 'string' && IOT_COLLECTIONS.some((item) => item.id === value.collectionId) &&
    validEvidence(value.manufacturer, (item) => typeof item === 'string' && !!item) && typeof value.model === 'string' && !!value.model &&
    validEvidence(value.revision, (item) => typeof item === 'string' && !!item) && Array.isArray(value.sources) && value.sources.length > 0 &&
    value.sources.every((source) => isObject(source) && typeof source.title === 'string' && !!source.title && typeof source.url === 'string' && !!source.url &&
      (source.documentRevision === undefined || typeof source.documentRevision === 'string')) && typeof value.description === 'string' &&
    value.componentRevision === IOT_VERSION;
}
export function isIotComponent(entity: Pick<Entity, 'type' | 'typeVersion' | 'properties' | 'ports'>): boolean {
  const metadata = iotData(entity);
  return metadata !== undefined && Array.isArray(entity.ports) && entity.ports.every(validIotPort) &&
    new Set(entity.ports.map((port) => port.id.toLowerCase())).size === entity.ports.length &&
    entity.ports.every((port) => port.sourceIds.every((sourceId) => sourceId < metadata.sources.length));
}
export function validateIotSnapshot(snapshot: DomainSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const record of snapshot.records) {
    if (record.kind !== 'entity' || record.value.type !== IOT_COMPONENT_TYPE || record.value.typeVersion !== IOT_VERSION) continue;
    const metadata = record.value.properties[IOT_METADATA_KEY];
    const report = (detail: string, message: string) => diagnostics.push(diagnostic(detail, message, { kind: 'entity', id: record.value.id }));
    if (!validMetadata(metadata) || !Array.isArray(record.value.ports) || !record.value.ports.every(validIotPort)) {
      report('iot-component-invalid', 'El componente IoT requiere fabricante, modelo, revisión, fuente y puertos tipados; conserva los datos originales para reparación.');
      continue;
    }
    const portIds = record.value.ports.map((port) => port.id.toLowerCase());
    if (new Set(portIds).size !== portIds.length) report('iot-port-id-duplicate', 'Los IDs de puerto IoT deben ser únicos dentro del componente.');
    for (const port of record.value.ports as IotPort[]) {
      if (port.sourceIds.some((sourceId) => sourceId >= metadata.sources.length)) report('iot-port-source-missing', `El puerto ${port.id} referencia una fuente inexistente.`);
    }
  }
  return diagnostics;
}
export function iotNodeDefinition(type: string): NodeType | undefined {
  return type === IOT_COMPONENT_TYPE ? { name: type, version: IOT_VERSION, packageId: 'a3.builtin.iot',
    fields: [{ name: IOT_METADATA_KEY, valueType: 'json', required: true }], ports: [], bindingFields: [], extensions: {} } : undefined;
}
export function iotRegistry(): TypeRegistry { return { nodeTypes: [iotNodeDefinition(IOT_COMPONENT_TYPE)!], relationTypes: [] }; }
export function createIotEntity(id: string, title: string, entry: IotCatalogEntry): Entity {
  return { schemaVersion: '1.0.0', id, revision: 1, type: IOT_COMPONENT_TYPE, typeVersion: IOT_VERSION, title,
    tags: ['iot', entry.collectionId], properties: { [IOT_METADATA_KEY]: iotMetadata(entry) } as unknown as ExtensionMap, ports: iotEntryPorts(entry), bindings: {}, extensions: {} };
}

export function validCreateIotComponent(value: unknown): value is import('./models.js').CreateIotComponent {
  return isObject(value) && Object.keys(value).length === 6 &&
    ['workspaceId', 'entityId', 'placementId'].every((key) => typeof value[key] === 'string' && UUID_PATTERN.test(String(value[key]))) &&
    typeof value.catalogId === 'string' && IOT_CATALOG.some((item) => item.catalogId === value.catalogId && !item.template) &&
    typeof value.title === 'string' && value.title.trim().length > 0 && value.title.length <= 200 &&
    isObject(value.position) && Object.keys(value.position).length === 2 && Number.isFinite(value.position.x) && Number.isFinite(value.position.y);
}
