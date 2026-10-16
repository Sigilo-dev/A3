import type { ExtensionMap } from './models.js';

export const PLANTUML_SOURCE_TYPE = 'a3.diagram.plantuml';
export const PLANTUML_RENDERER = 'plantuml';
export const PLANTUML_RENDERER_VERSION = '1.2026.8';
export const PLANTUML_SOURCE_LIMIT = 256 * 1024;

/** Source remains authoritative until a later, explicit converter offers a preview. */
export function plantUmlSourceProperties(): ExtensionMap {
  return {
    'a3.diagram.authority': 'source',
    'a3.diagram.format': 'plantuml',
    'a3.diagram.renderer': `${PLANTUML_RENDERER}@${PLANTUML_RENDERER_VERSION}`
  };
}

export function hasPlantUmlSourceAuthority(properties: ExtensionMap): boolean {
  return properties['a3.diagram.authority'] === 'source' && properties['a3.diagram.format'] === 'plantuml' &&
    properties['a3.diagram.renderer'] === `${PLANTUML_RENDERER}@${PLANTUML_RENDERER_VERSION}`;
}

export function supportsPlantUmlSourceRenderer(type: string, typeVersion: string, properties: ExtensionMap): boolean {
  return type === PLANTUML_SOURCE_TYPE && typeVersion === '1.0.0' && hasPlantUmlSourceAuthority(properties);
}
